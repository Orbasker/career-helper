import { createHash, randomBytes } from "node:crypto";

/** The only Google scope the app ever requests. */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export interface GoogleTokens {
  accessToken: string;
  /** Null when Google did not issue one. */
  refreshToken: string | null;
  scopes: string[];
}

/** Google rejected a refresh token: it expired, was revoked, or the user changed their password. */
export class GoogleGrantRevokedError extends Error {
  constructor() {
    super("google refresh token is no longer valid");
  }
}

export interface GoogleOAuth {
  authorizationUrl(input: { state: string; codeChallenge: string }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokens>;
  /** Throws `GoogleGrantRevokedError` when the refresh token is no longer valid. */
  refreshAccessToken(refreshToken: string): Promise<GoogleTokens>;
  /** Resolves when the token is revoked or was already invalid. */
  revoke(token: string): Promise<void>;
  gmailAddress(accessToken: string): Promise<string>;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function codeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export class HttpGoogleOAuth implements GoogleOAuth {
  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  ) {}

  authorizationUrl({ state, codeChallenge }: { state: string; codeChallenge: string }): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: GMAIL_READONLY_SCOPE,
      access_type: "offline",
      // Forces a refresh token on every consent, including reconnects.
      prompt: "consent",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `${AUTH_URL}?${params}`;
  }

  exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokens> {
    return this.token({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.config.redirectUri,
    });
  }

  refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async revoke(token: string): Promise<void> {
    const response = await this.fetchFn(REVOKE_URL, { method: "POST", body: new URLSearchParams({ token }) });
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (body.error === "invalid_token") return;
    throw new Error(`Google token revocation failed with ${response.status}`);
  }

  async gmailAddress(accessToken: string): Promise<string> {
    const response = await this.fetchFn(GMAIL_PROFILE_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Gmail profile request failed with ${response.status}`);
    const { emailAddress } = (await response.json()) as { emailAddress?: string };
    if (!emailAddress) throw new Error("Gmail profile has no email address");
    return emailAddress;
  }

  private async token(params: Record<string, string>): Promise<GoogleTokens> {
    const response = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...params }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
      error?: string;
    };
    if (body.error === "invalid_grant" && params.grant_type === "refresh_token") throw new GoogleGrantRevokedError();
    if (!response.ok || !body.access_token) throw new Error(`Google token request failed with ${response.status} ${body.error ?? ""}`.trim());
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      scopes: (body.scope ?? "").split(" ").filter(Boolean),
    };
  }
}
