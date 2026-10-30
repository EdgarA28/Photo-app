import type { UploadUrlResponse } from "@photo-app/shared";
import { vi } from "vitest";
import { createApi } from "../src/api/api";
import type { Request, RequestOptions } from "../src/api/client";
import type { Auth, SessionUser } from "../src/auth/auth";
import type { MediaCookies } from "../src/auth/mediaCookie";
import type { SessionDb } from "../src/auth/sessionDb";
import type { AppConfig } from "../src/config";
import type { PersistedQueryCache } from "../src/queries/persistedCache";
import { createUploadQueue, type UploadQueueDeps } from "../src/upload/queue";
import type { PostToS3 } from "../src/upload/s3Post";
import type { ShareInbox, SharedFile, WaitingPhoto } from "../src/upload/shareInbox";
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
    getStoredUser: vi.fn(async () => user && { sub: user.sub, email: undefined, name: undefined }),
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
    ready: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  } satisfies MediaCookies;
}

/** Saved Query cache that saves nothing; tests of the real one use createPersistedQueryCache. */
export function fakePersistedCache() {
  return {
    start: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  } satisfies PersistedQueryCache;
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

/** Web Locks with one exclusive lock, a waiting line, `signal`, `steal` and `ifAvailable`. */
export class FakeLocks {
  holder: { reject: (error: unknown) => void } | null = null;
  waiting: { grant: () => void }[] = [];

  request<T>(name: string, options: LockOptions, callback: (lock: Lock | null) => T) {
    return new Promise<Awaited<T>>((resolve, reject) => {
      const grant = () => {
        const held = { reject };
        this.holder = held;
        void Promise.resolve(callback({ name, mode: "exclusive" })).then((value) => {
          if (this.holder === held) {
            this.holder = null;
            this.waiting.shift()?.grant();
          }
          resolve(value);
        });
      };
      if (options.ifAvailable && this.holder) {
        return void Promise.resolve(callback(null)).then(resolve);
      }
      if (options.steal) {
        const old = this.holder;
        this.holder = null;
        old?.reject(new DOMException("Lock stolen", "AbortError"));
        return grant();
      }
      if (!this.holder) return grant();
      const entry = { grant };
      this.waiting.push(entry);
      options.signal?.addEventListener("abort", () => {
        this.waiting = this.waiting.filter((e) => e !== entry);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }
}

/** BroadcastChannel between the windows; a frozen window neither sends nor receives. */
export function channelHub() {
  const members = new Set<{ frozen: boolean; listeners: Set<(e: MessageEvent) => void> }>();
  const create = () => {
    const member = { frozen: false, listeners: new Set<(e: MessageEvent) => void>() };
    members.add(member);
    const channel = {
      postMessage(data: unknown) {
        if (member.frozen) return;
        for (const other of members) {
          if (other === member || other.frozen) continue;
          for (const listener of other.listeners) {
            queueMicrotask(() => listener(new MessageEvent("message", { data })));
          }
        }
      },
      addEventListener: (_type: string, listener: (e: MessageEvent) => void) =>
        member.listeners.add(listener),
      removeEventListener: (_type: string, listener: (e: MessageEvent) => void) =>
        member.listeners.delete(listener),
      close: () => members.delete(member),
    };
    return { channel: channel as unknown as BroadcastChannel, member };
  };
  return { create };
}

/** The share inbox (9.6) in memory. */
export class MemoryShareInbox implements ShareInbox {
  photos: WaitingPhoto[] = [];
  private nextId = 1;
  get files() {
    return this.photos.map((photo) => photo.file);
  }
  /** Test setup: these files are waiting. */
  set files(files: File[]) {
    this.photos = files.map((file) => ({ id: this.nextId++, file }));
  }
  async replace(files: SharedFile[]) {
    this.files = files.map(
      ({ name, type, lastModified, blob }) => new File([blob], name, { type, lastModified }),
    );
  }
  async list() {
    return [...this.photos];
  }
  async take(ids: number[]) {
    const taken = this.photos.filter((photo) => ids.includes(photo.id));
    this.photos = this.photos.filter((photo) => !ids.includes(photo.id));
    return taken.map((photo) => photo.file);
  }
  async clear() {
    this.photos = [];
  }
}

/** The session database (9.5) in memory. */
export class MemorySessionDb implements SessionDb {
  readonly items = new Map<string, string>();
  async get(key: string) {
    return this.items.get(key);
  }
  async set(key: string, value: string) {
    this.items.set(key, value);
  }
  async delete(key: string) {
    this.items.delete(key);
  }
  async keys() {
    return [...this.items.keys()];
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
    place: null,
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
