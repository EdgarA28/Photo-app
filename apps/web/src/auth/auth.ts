import {
  ErrorResponse,
  OidcClient,
  UserManager,
  WebStorageStateStore,
  type User,
  type UserManagerSettings,
} from "oidc-client-ts";
import type { AppConfig } from "@/config";
import { safeRedirect } from "./redirect";
import { SessionStore } from "./sessionStore";

/** Who is signed in, from the ID token. Display only: the API trusts the access token's `sub`. */
export interface SessionUser {
  sub: string;
  email: string | undefined;
  name: string | undefined;
}

export type LoginProvider = "Google" | "email";

/** Everything the app needs from login (§11, §12.1); a fake in tests. */
export interface Auth {
  /** The signed-in user, refreshing expired tokens first; null if there is no valid session. */
  getUser(): Promise<SessionUser | null>;
  /** Current access token for `Authorization: Bearer` (8.4), refreshed if needed. */
  getAccessToken(): Promise<string | null>;
  /** Redirects to Cognito (Google directly, or managed login for email/password). */
  login(options: { provider: LoginProvider; redirect: string | undefined }): Promise<void>;
  /** Finishes the redirect on /auth/callback; returns the path to continue to. */
  completeLogin(url?: string): Promise<string>;
  /** Revokes the refresh token, forgets the session, ends the Cognito session (FR-AUTH-5). */
  logout(): Promise<void>;
}

export interface AuthDeps {
  persistentStorage?: Storage;
  /** Per-tab storage for in-flight logins (state, nonce, PKCE verifier). */
  requestStorage?: Storage;
  /** Full-page navigation to Cognito; replaceable in tests (jsdom can't navigate). */
  navigate?: (url: string) => void;
}

export function userManagerSettings(
  config: AppConfig,
  persistentStorage: Storage,
  requestStorage: Storage,
): UserManagerSettings {
  const { issuer, clientId, domain } = config.cognito;
  return {
    authority: issuer,
    client_id: clientId,
    redirect_uri: `${config.origin}/auth/callback`,
    post_logout_redirect_uri: `${config.origin}/login`,
    response_type: "code", // + PKCE (S256), always on in oidc-client-ts
    scope: "openid email profile", // `openid` is what the API's routes require (5.4)
    // Static metadata: no discovery request at startup. Cognito's endpoints live on the hosted
    // domain, not under the issuer.
    metadata: {
      issuer,
      authorization_endpoint: `${domain}/oauth2/authorize`,
      token_endpoint: `${domain}/oauth2/token`,
      revocation_endpoint: `${domain}/oauth2/revoke`,
      userinfo_endpoint: `${domain}/oauth2/userInfo`,
      end_session_endpoint: `${domain}/logout`,
    },
    userStore: new SessionStore(persistentStorage),
    // In-flight login requests: per tab, removed when the callback is processed.
    stateStore: new WebStorageStateStore({ store: requestStorage }),
    // Refresh-token renewal shortly before the 1 h access token expires (FR-AUTH-4); no iframes.
    automaticSilentRenew: true,
    loadUserInfo: false, // the ID token already has email and name
    monitorSession: false, // Cognito has no check_session_iframe
  };
}

export function createAuth(config: AppConfig, deps: AuthDeps = {}): Auth {
  const persistentStorage = deps.persistentStorage ?? window.localStorage;
  const navigate = deps.navigate ?? ((url: string) => window.location.assign(url));
  const settings = userManagerSettings(
    config,
    persistentStorage,
    deps.requestStorage ?? window.sessionStorage,
  );
  const manager = new UserManager(settings);
  // Builds the authorize URL and stores its state in the shared stateStore; we navigate ourselves
  // (UserManager.signinRedirect would, but can't be pointed elsewhere in tests).
  const client = new OidcClient(settings);

  // Concurrent callers (route guard + API calls) share one refresh request.
  let pending: Promise<User | null> | null = null;

  async function validUser(): Promise<User | null> {
    const user = await manager.getUser();
    if (user && !user.expired && user.access_token) return user;
    if (!user?.refresh_token) return null;
    pending ??= manager.signinSilent().finally(() => {
      pending = null;
    });
    try {
      return await pending;
    } catch (error) {
      // Cognito rejected the refresh token (expired after 30 days, revoked, user deleted): the
      // session is over. Network errors are rethrown so being offline doesn't log anyone out.
      if (error instanceof ErrorResponse) {
        await manager.removeUser();
        return null;
      }
      throw error;
    }
  }

  return {
    async getUser() {
      const user = await validUser();
      if (!user) return null;
      const { sub, email, name } = user.profile;
      return {
        sub,
        email: typeof email === "string" ? email : undefined,
        name: typeof name === "string" ? name : undefined,
      };
    },

    async getAccessToken() {
      return (await validUser())?.access_token ?? null;
    },

    async login({ provider, redirect }) {
      const request = await client.createSigninRequest({
        request_type: "si:r",
        ...signinArgs(provider, redirect),
      });
      navigate(request.url);
    },

    async completeLogin(url) {
      // Checks `state`, exchanges the code with the PKCE verifier, stores the session (§11).
      const user = await manager.signinRedirectCallback(url);
      return safeRedirect(typeof user.state === "string" ? user.state : undefined);
    },

    async logout() {
      try {
        await manager.revokeTokens(["refresh_token"]);
      } catch (error) {
        // Still sign out locally; the token expires on its own (30 days).
        console.warn("Refresh token revocation failed", error);
      }
      await manager.removeUser();
      // Cognito's own logout (not OIDC end_session): ends its session cookie so the next login
      // asks again, then returns to /login (a registered logout URL, 4.2).
      const params = new URLSearchParams({
        client_id: config.cognito.clientId,
        logout_uri: `${config.origin}/login`,
      });
      navigate(`${config.cognito.domain}/logout?${params}`);
    },
  };
}

/** Sign-in request: Google skips the Cognito page (`identity_provider`); `state` carries the target. */
export function signinArgs(provider: LoginProvider, redirect: string | undefined) {
  return {
    state: safeRedirect(redirect),
    ...(provider === "Google" ? { extraQueryParams: { identity_provider: "Google" } } : {}),
  };
}
