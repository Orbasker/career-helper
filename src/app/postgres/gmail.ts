import { createHash } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import { googleAccounts, oauthStates, users } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { GMAIL_READONLY_SCOPE, GoogleGrantRevokedError, codeChallenge, randomToken, type GoogleOAuth } from "../../google/oauth.js";
import type { TokenCipher } from "../../google/token-cipher.js";
import type {
  GmailAccess,
  GmailConnectLink,
  GmailConnectOutcome,
  GmailDisconnectOutcome,
  GmailService,
  GmailStatus,
} from "../services.js";

export const CONNECT_LINK_TTL_MS = 10 * 60 * 1000;

export interface GmailDeps {
  oauth: GoogleOAuth;
  cipher: TokenCipher;
  /** The app URL that starts sign-in for a state, e.g. `https://host/api/google/connect?state=…`. */
  connectUrl: (state: string) => string;
}

const hashState = (state: string) => createHash("sha256").update(state).digest("hex");

export class PgGmailService implements GmailService {
  constructor(
    private readonly db: Db,
    private readonly deps: GmailDeps | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(userId: string, { verify = false }: { verify?: boolean } = {}): Promise<GmailStatus> {
    if (!this.deps) return { kind: "unavailable" };
    const account = await this.account(userId);
    if (!account) return { kind: "not_connected" };
    if (account.status === "needs_reconnect") return { kind: "needs_reconnect", email: account.email };
    if (verify) {
      const access = await this.accessToken(userId).catch((error: unknown) => {
        console.error("gmail token check failed", { error });
        return null;
      });
      if (access?.kind === "needs_reconnect") return access;
    }
    return { kind: "connected", email: account.email, connectedAt: account.connectedAt, lastSyncAt: account.lastSyncAt };
  }

  async startConnect(userId: string): Promise<GmailConnectLink> {
    if (!this.deps) return { kind: "unavailable" };
    const state = randomToken();
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx.delete(oauthStates).where(eq(oauthStates.userId, userId));
      await tx.delete(oauthStates).where(lte(oauthStates.expiresAt, now));
      await tx.insert(oauthStates).values({
        stateHash: hashState(state),
        userId,
        codeVerifier: randomToken(),
        expiresAt: new Date(now.getTime() + CONNECT_LINK_TTL_MS),
      });
    });
    return { kind: "link", url: this.deps.connectUrl(state) };
  }

  async authorizationUrl(state: string): Promise<string | null> {
    if (!this.deps) return null;
    const [pending] = await this.db
      .select({ codeVerifier: oauthStates.codeVerifier })
      .from(oauthStates)
      .where(and(eq(oauthStates.stateHash, hashState(state)), gt(oauthStates.expiresAt, this.now())));
    if (!pending) return null;
    return this.deps.oauth.authorizationUrl({ state, codeChallenge: codeChallenge(pending.codeVerifier) });
  }

  async completeConnect({ state, code, error }: { state: string; code: string | null; error: string | null }): Promise<GmailConnectOutcome> {
    if (!this.deps) return { kind: "invalid_state" };
    const { oauth, cipher } = this.deps;
    const [consumed] = await this.db
      .delete(oauthStates)
      .where(eq(oauthStates.stateHash, hashState(state)))
      .returning({ userId: oauthStates.userId, codeVerifier: oauthStates.codeVerifier, expiresAt: oauthStates.expiresAt });
    if (!consumed || consumed.expiresAt <= this.now()) return { kind: "invalid_state" };

    const [user] = await this.db
      .select({ chatId: users.telegramChatId, language: users.preferredLanguage })
      .from(users)
      .where(eq(users.id, consumed.userId));
    if (!user) return { kind: "invalid_state" };
    if (error || !code) return { kind: error === "access_denied" ? "denied" : "failed", ...user };

    let tokens;
    try {
      tokens = await oauth.exchangeCode(code, consumed.codeVerifier);
    } catch (exchangeError) {
      console.error("google code exchange failed", { error: exchangeError });
      return { kind: "failed", ...user };
    }
    if (!tokens.scopes.includes(GMAIL_READONLY_SCOPE) || !tokens.refreshToken) {
      await this.revokeQuietly(tokens.refreshToken ?? tokens.accessToken);
      return { kind: tokens.refreshToken ? "missing_scope" : "failed", ...user };
    }

    let email: string;
    try {
      email = await oauth.gmailAddress(tokens.accessToken);
    } catch (profileError) {
      console.error("gmail profile lookup failed", { error: profileError });
      await this.revokeQuietly(tokens.refreshToken);
      return { kind: "failed", ...user };
    }

    const previous = await this.account(consumed.userId);
    const connectedAt = this.now();
    const values = {
      email,
      scopes: tokens.scopes,
      refreshTokenEncrypted: cipher.encrypt(tokens.refreshToken, consumed.userId),
      status: "active" as const,
      connectedAt,
      lastSyncAt: previous?.email === email ? previous.lastSyncAt : null,
    };
    await this.db
      .insert(googleAccounts)
      .values({ userId: consumed.userId, ...values })
      .onConflictDoUpdate({ target: googleAccounts.userId, set: values });
    // Revoking a token revokes its whole grant, so only a different Google account's token may be revoked here.
    const previousToken = previous && previous.email !== email && this.decryptQuietly(previous.refreshTokenEncrypted, consumed.userId);
    if (previousToken) await this.revokeQuietly(previousToken);
    return { kind: "connected", email, ...user };
  }

  async disconnect(userId: string): Promise<GmailDisconnectOutcome> {
    const account = await this.account(userId);
    if (!account) return { kind: "not_connected" };
    let revoked = true;
    const refreshToken = this.decryptQuietly(account.refreshTokenEncrypted, userId);
    if (refreshToken && this.deps) {
      revoked = await this.deps.oauth.revoke(refreshToken).then(
        () => true,
        (error: unknown) => {
          console.error("google token revocation failed", { error });
          return false;
        },
      );
    } else if (account.refreshTokenEncrypted) {
      revoked = false;
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(googleAccounts).where(eq(googleAccounts.userId, userId));
      await tx.delete(oauthStates).where(eq(oauthStates.userId, userId));
    });
    return { kind: "disconnected", email: account.email, revoked };
  }

  async accessToken(userId: string): Promise<GmailAccess> {
    if (!this.deps) return { kind: "unavailable" };
    const account = await this.account(userId);
    if (!account) return { kind: "not_connected" };
    const refreshToken = account.status === "active" ? this.decryptQuietly(account.refreshTokenEncrypted, userId) : null;
    if (!refreshToken) return this.markNeedsReconnect(userId, account.email);
    try {
      const tokens = await this.deps.oauth.refreshAccessToken(refreshToken);
      return { kind: "ok", accessToken: tokens.accessToken, email: account.email };
    } catch (error) {
      if (error instanceof GoogleGrantRevokedError) return this.markNeedsReconnect(userId, account.email);
      throw error;
    }
  }

  private async markNeedsReconnect(userId: string, email: string): Promise<GmailAccess> {
    await this.db
      .update(googleAccounts)
      .set({ status: "needs_reconnect", refreshTokenEncrypted: null })
      .where(eq(googleAccounts.userId, userId));
    return { kind: "needs_reconnect", email };
  }

  private async account(userId: string) {
    const [account] = await this.db.select().from(googleAccounts).where(eq(googleAccounts.userId, userId));
    return account ?? null;
  }

  private decryptQuietly(sealed: string | null, userId: string): string | null {
    if (!sealed || !this.deps) return null;
    try {
      return this.deps.cipher.decrypt(sealed, userId);
    } catch (error) {
      console.error("google refresh token could not be decrypted", { error });
      return null;
    }
  }

  private async revokeQuietly(token: string): Promise<void> {
    await this.deps?.oauth.revoke(token).catch((error: unknown) => console.error("google token revocation failed", { error }));
  }
}
