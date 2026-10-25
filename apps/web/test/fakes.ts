import type { UploadUrlResponse } from "@photo-app/shared";
import { vi } from "vitest";
import { createApi } from "../src/api/api";
import type { Request, RequestOptions } from "../src/api/client";
import type { Auth, SessionUser } from "../src/auth/auth";
import type { MediaCookies } from "../src/auth/mediaCookie";
import type { AppConfig } from "../src/config";
import { createUploadQueue, type UploadQueueDeps } from "../src/upload/queue";
import type { PostToS3 } from "../src/upload/s3Post";
import type { UploadItem, UploadStore } from "../src/upload/store";

export const testConfig: AppConfig = {
  origin: "http://localhost:5173",
  cognito: {
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST",
    clientId: "test-client",
    domain: "https://photo-app-test.auth.us-east-1.amazoncognito.com",
  },
  googleLogin: true,
};

export const testUser: SessionUser = {
  sub: "04e8b4b8-0000-4000-8000-000000000001",
  email: "user@example.com",
  name: "Test User",
};

/** Auth with a switchable session; methods are spies. */
export function fakeAuth(options: { signedIn?: boolean; callbackTarget?: string } = {}) {
  let user: SessionUser | null = options.signedIn ? testUser : null;
  const auth = {
    getUser: vi.fn(async () => user),
    getAccessToken: vi.fn(async () => (user ? "access-token" : null)),
    refreshAccessToken: vi.fn(async () => (user ? "access-token-2" : null)),
    login: vi.fn(async () => {}),
    completeLogin: vi.fn(async () => {
      user = testUser;
      return options.callbackTarget ?? "/gallery";
    }),
    clearSession: vi.fn(async () => {
      user = null;
    }),
    logout: vi.fn(async () => {
      user = null;
    }),
    onTokens: vi.fn(() => () => {}),
  } satisfies Auth;
  return auth;
}

/** Media cookies that are always "set"; tests of the real module use createMediaCookies. */
export function fakeMedia() {
  return {
    ensure: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  } satisfies MediaCookies;
}

/** Minimal Web Storage (a separate sessionStorage per simulated tab). */
export class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

/** A canned response: a value, an error to throw, or a function of the request's query. */
export type FakeResponse = unknown | ((query: RequestOptions<unknown>["query"]) => unknown);

/**
 * Api backed by a table of canned responses keyed by "METHOD /path" (no query string). Responses
 * still go through the route's schema, as in the real client.
 */
export function fakeApi(responses: Record<string, FakeResponse> = {}) {
  const request = vi.fn(
    async (method: string, path: string, options: RequestOptions<unknown> = {}) => {
      const key = `${method} ${path}`;
      if (!(key in responses)) throw new Error(`fakeApi: no response for ${key}`);
      const entry = responses[key];
      const value = typeof entry === "function" ? entry(options.query) : entry;
      if (value instanceof Error) throw value;
      return options.schema ? options.schema.parse(value) : undefined;
    },
  );
  return { api: createApi(request as Request), request };
}

export const testMe = {
  userId: testUser.sub,
  email: "user@example.com",
  name: "Test User",
  // Set, so the first-login prompt (8.15) stays out of the way; its tests use `username: null`.
  username: "test.user",
  usage: { bytesUsed: 1536 * 1024, photoCount: 3, quotaBytes: 2 * 1024 ** 3 },
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A valid ULID that encodes `n` in its last characters (stable, readable test IDs). */
export function testId(n: number): string {
  let suffix = "";
  for (let i = 0; i < 6; i++, n = Math.floor(n / 32)) suffix = CROCKFORD[n % 32] + suffix;
  return `01JB2Z3M4N5P6Q7R8S9T${suffix}`;
}

/** A ready 4:3 photo as GET /photos returns it. */
export function testPhoto(n: number, overrides: Record<string, unknown> = {}) {
  const photoId = testId(n);
  return {
    photoId,
    status: "ready",
    fileName: `IMG_${n}.jpg`,
    contentType: "image/jpeg",
    sizeBytes: 2_000_000,
    width: 4032,
    height: 3024,
    takenAt: "2026-10-01T10:00:00.000Z",
    uploadedAt: "2026-10-02T10:00:00.000Z",
    thumbUrl: `/users/${testUser.sub}/thumbs/${photoId}.jpg`,
    previewUrl: `/users/${testUser.sub}/previews/${photoId}.jpg`,
    ...overrides,
  };
}

/** A page of `count` photos starting at `from`. */
export function testPhotoPage(from: number, count: number, nextCursor: string | null = null) {
  return { items: Array.from({ length: count }, (_, i) => testPhoto(from + i)), nextCursor };
}

export const emptyPage = { items: [], nextCursor: null };

/** The upload queue's store in memory (jsdom's Blob doesn't survive fake-indexeddb). */
export class MemoryUploadStore implements UploadStore {
  readonly items = new Map<string, UploadItem>();
  async list(userId: string) {
    return [...this.items.values()]
      .filter((item) => item.userId === userId)
      .sort((a, b) => a.addedAt - b.addedAt);
  }
  async put(item: UploadItem) {
    this.items.set(item.id, { ...item });
  }
  async delete(id: string) {
    this.items.delete(id);
  }
  async clear() {
    this.items.clear();
  }
}

/** An S3 POST the test finishes by hand: `next()` is the oldest unfinished one. */
export function controlledPost() {
  const calls: {
    upload: UploadUrlResponse["upload"];
    file: Blob;
    progress: (fraction: number) => void;
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal | undefined;
  }[] = [];
  const post = vi.fn<PostToS3>(
    (upload, file, options = {}) =>
      new Promise<void>((resolve, reject) => {
        calls.push({
          upload,
          file,
          progress: (fraction) => options.onProgress?.(fraction),
          resolve,
          reject,
          signal: options.signal,
        });
        options.signal?.addEventListener("abort", () =>
          reject(new DOMException("Upload cancelled", "AbortError")),
        );
      }),
  );
  return { post, calls };
}

/** An upload queue on a memory store whose S3 POSTs succeed at once (unless `post` is given). */
export function testUploadQueue(
  api: UploadQueueDeps["api"],
  overrides: Partial<UploadQueueDeps> = {},
) {
  const store = new MemoryUploadStore();
  let n = 0;
  const queue = createUploadQueue({
    api,
    store,
    post: async () => {},
    isOnline: () => true,
    newId: () => `local-${++n}`,
    ...overrides,
  });
  return { queue, store };
}

/** A File of `size` bytes. */
export function testFile(name: string, size = 1000, type = "image/jpeg") {
  return new File([new Uint8Array(size)], name, { type });
}
