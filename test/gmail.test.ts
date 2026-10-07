import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgServices } from "../src/app/postgres/index.js";
import { CONNECT_LINK_TTL_MS, PgGmailService, type GmailDeps } from "../src/app/postgres/gmail.js";
import { createBot } from "../src/bot/bot.js";
import { decodeCallback, encodeCallback } from "../src/bot/callbacks.js";
import { googleAccounts, oauthStates, users } from "../src/db/schema.js";
import { gmailDepsFromEnv } from "../src/google/env.js";
import {
  GMAIL_READONLY_SCOPE,
  GoogleGrantRevokedError,
  HttpGoogleOAuth,
  codeChallenge,
  type GoogleOAuth,
  type GoogleTokens,
} from "../src/google/oauth.js";
import { createGoogleCallbackHandler, createGoogleConnectHandler } from "../src/google/routes.js";
import { TokenCipher } from "../src/google/token-cipher.js";
import { strings } from "../src/i18n/index.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { BOT_INFO, DANA, NOA, callbackUpdate, captureApiCalls, textUpdate, type ApiCall } from "./support/telegram.js";

const en = strings("en");
const KEY = Buffer.alloc(32, 7).toString("base64");

class FakeGoogleOAuth implements GoogleOAuth {
  scopes = [GMAIL_READONLY_SCOPE];
  email = "dana@gmail.com";
  issued = 0;
  revoked: string[] = [];
  invalid = new Set<string>();
  revokeFails = false;
  exchanged: { code: string; verifier: string }[] = [];

  authorizationUrl({ state, codeChallenge }: { state: string; codeChallenge: string }) {
    return `https://accounts.example/auth?state=${state}&challenge=${codeChallenge}`;
  }
  async exchangeCode(code: string, verifier: string): Promise<GoogleTokens> {
    this.exchanged.push({ code, verifier });
    this.issued += 1;
    return { accessToken: `access-${this.issued}`, refreshToken: `refresh-${this.issued}`, scopes: this.scopes };
  }
  async refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
    if (this.invalid.has(refreshToken)) throw new GoogleGrantRevokedError();
    return { accessToken: `fresh-${refreshToken}`, refreshToken: null, scopes: this.scopes };
  }
  async revoke(token: string) {
    if (this.revokeFails) throw new Error("network down");
    this.revoked.push(token);
  }
  async gmailAddress() {
    return this.email;
  }
}

let db: TestDb;
let close: () => Promise<void>;
let oauth: FakeGoogleOAuth;
let deps: GmailDeps;
let gmail: PgGmailService;
let bot: ReturnType<typeof createBot>;
let calls: ApiCall[];
let sent: { chatId: number; text: string }[];
let connect: (request: Request) => Promise<Response>;
let callback: (request: Request) => Promise<Response>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  oauth = new FakeGoogleOAuth();
  deps = { oauth, cipher: TokenCipher.fromBase64(KEY), connectUrl: (state) => `https://app.example/api/google/connect?state=${state}` };
  gmail = new PgGmailService(db, deps);
  bot = createBot("test-token", createPgServices(db, new FakeProfileAssistant(), new FakeCvTailorer(), { gmail: deps }), {
    botInfo: BOT_INFO,
  });
  calls = captureApiCalls(bot);
  sent = [];
  connect = createGoogleConnectHandler(gmail);
  callback = createGoogleCallbackHandler(gmail, async (chatId, text) => sent.push({ chatId, text }));
});

afterEach(async () => {
  await close();
});

const lastText = () => calls.filter((c) => c.method === "sendMessage").at(-1)?.payload.text as string;

async function userId(person = DANA) {
  const [user] = await db.select().from(users).where(eq(users.telegramUserId, person.id));
  return user!.id;
}

/** Sends /connect_gmail and returns the state in the sign-in button's link. */
async function requestLink(person = DANA): Promise<string> {
  await bot.handleUpdate(textUpdate("/connect_gmail", person));
  const message = calls.filter((c) => c.method === "sendMessage").at(-1)!;
  const url = message.payload.reply_markup.inline_keyboard[0][0].url as string;
  return new URL(url).searchParams.get("state")!;
}

const callbackRequest = (params: Record<string, string>) =>
  new Request(`https://app.example/api/google/callback?${new URLSearchParams(params)}`);

/** A sign-in link's state straight from the service, also for a user who is already connected. */
async function linkState(person = DANA): Promise<string> {
  await bot.handleUpdate(textUpdate("/help", person));
  const link = await gmail.startConnect(await userId(person));
  if (link.kind !== "link") throw new Error("gmail is unavailable");
  return new URL(link.url).searchParams.get("state")!;
}

async function connectGmail(person = DANA) {
  return callback(callbackRequest({ state: await linkState(person), code: "auth-code" }));
}

describe("token encryption", () => {
  const cipher = TokenCipher.fromBase64(KEY);

  it("round-trips and never stores the plaintext", () => {
    const sealed = cipher.encrypt("1//refresh-token", "user-1");
    expect(sealed).not.toContain("refresh-token");
    expect(cipher.encrypt("1//refresh-token", "user-1")).not.toBe(sealed);
    expect(cipher.decrypt(sealed, "user-1")).toBe("1//refresh-token");
  });

  it("rejects another user's ciphertext, a tampered one and a wrong key", () => {
    const sealed = cipher.encrypt("secret", "user-1");
    expect(() => cipher.decrypt(sealed, "user-2")).toThrow();
    const [v, iv, tag, body] = sealed.split(".");
    const flipped = `${body![0] === "A" ? "B" : "A"}${body!.slice(1)}`;
    expect(() => cipher.decrypt([v, iv, tag, flipped].join("."), "user-1")).toThrow();
    expect(() => TokenCipher.fromBase64(Buffer.alloc(32, 9).toString("base64")).decrypt(sealed, "user-1")).toThrow();
    expect(() => TokenCipher.fromBase64("c2hvcnQ=")).toThrow(/32 bytes/);
  });
});

describe("google oauth client", () => {
  const config = { clientId: "client", clientSecret: "secret", redirectUri: "https://app.example/api/google/callback" };

  it("asks only for read-only Gmail, offline, with PKCE", () => {
    const url = new URL(new HttpGoogleOAuth(config).authorizationUrl({ state: "s", codeChallenge: "c" }));
    expect(url.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("reports a rejected refresh token and treats an already invalid token as revoked", async () => {
    const client = (status: number, body: object) =>
      new HttpGoogleOAuth(config, async () => new Response(JSON.stringify(body), { status }));
    await expect(client(400, { error: "invalid_grant" }).refreshAccessToken("r")).rejects.toBeInstanceOf(GoogleGrantRevokedError);
    await expect(client(500, { error: "backend" }).refreshAccessToken("r")).rejects.not.toBeInstanceOf(GoogleGrantRevokedError);
    await expect(client(400, { error: "invalid_token" }).revoke("t")).resolves.toBeUndefined();
    await expect(client(503, {}).revoke("t")).rejects.toThrow();
  });

  it("is unavailable until every setting is present", () => {
    const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_TOKEN_ENCRYPTION_KEY: KEY };
    expect(gmailDepsFromEnv(env)).toBeNull();
    const configured = gmailDepsFromEnv({ ...env, VERCEL_PROJECT_PRODUCTION_URL: "agent.example" })!;
    expect(configured.connectUrl("abc")).toBe("https://agent.example/api/google/connect?state=abc");
    const url = new URL(configured.oauth.authorizationUrl({ state: "s", codeChallenge: "c" }));
    expect(url.searchParams.get("redirect_uri")).toBe("https://agent.example/api/google/callback");
  });
});

describe("connecting gmail", () => {
  it("explains what is read, stored and how to disconnect before linking to sign-in", async () => {
    const state = await requestLink();
    expect(lastText()).toBe(en.gmail.explain);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await db.select().from(oauthStates);
    expect(stored!.stateHash).not.toBe(state);
    expect(stored!.userId).toBe(await userId());

    const response = await connect(new Request(`https://app.example/api/google/connect?state=${state}`));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://accounts.example/auth?state=${state}&challenge=${codeChallenge(stored!.codeVerifier)}`,
    );
  });

  it("stores the encrypted grant for the user who asked and confirms in Telegram", async () => {
    const response = await connectGmail();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(en.gmail.page.connected);
    expect(sent).toEqual([{ chatId: DANA.id, text: en.gmail.connected("dana@gmail.com") }]);

    const [account] = await db.select().from(googleAccounts);
    expect(account).toMatchObject({ userId: await userId(), email: "dana@gmail.com", scopes: [GMAIL_READONLY_SCOPE], status: "active", lastSyncAt: null });
    expect(account!.refreshTokenEncrypted).not.toContain("refresh-1");
    expect(deps.cipher.decrypt(account!.refreshTokenEncrypted!, account!.userId)).toBe("refresh-1");
    expect(oauth.exchanged[0]!.verifier).toHaveLength(43);
    expect(await db.select().from(oauthStates)).toEqual([]);
  });

  it("accepts each state once, only before it expires, and only the latest link", async () => {
    const first = await requestLink();
    const state = await requestLink();
    expect((await connect(new Request(`https://app.example/api/google/connect?state=${first}`))).status).toBe(400);
    expect((await callback(callbackRequest({ state: first, code: "c" }))).status).toBe(400);

    expect((await callback(callbackRequest({ state, code: "c" }))).status).toBe(200);
    const replay = await callback(callbackRequest({ state, code: "c" }));
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("This link has expired or was already used.");
    expect(oauth.exchanged).toHaveLength(1);

    const later = new PgGmailService(db, deps, () => new Date(Date.now() + CONNECT_LINK_TTL_MS + 1000));
    const expired = await linkState();
    expect(await later.authorizationUrl(expired)).toBeNull();
    expect(await later.completeConnect({ state: expired, code: "c", error: null })).toEqual({ kind: "invalid_state" });
  });

  it("binds the grant to the Telegram user whose link was used", async () => {
    await requestLink(NOA);
    const noaState = new URL(calls.filter((c) => c.method === "sendMessage").at(-1)!.payload.reply_markup.inline_keyboard[0][0].url).searchParams.get("state")!;
    await requestLink(DANA);
    await callback(callbackRequest({ state: noaState, code: "c" }));
    const accounts = await db.select().from(googleAccounts);
    expect(accounts.map((a) => a.userId)).toEqual([await userId(NOA)]);
    expect(sent.map((s) => s.chatId)).toEqual([NOA.id]);
  });

  it("tells the user when they decline", async () => {
    const state = await requestLink();
    const response = await callback(callbackRequest({ state, error: "access_denied" }));
    expect(await response.text()).toContain(en.gmail.page.denied);
    expect(sent).toEqual([{ chatId: DANA.id, text: en.gmail.denied }]);
    expect(await db.select().from(googleAccounts)).toEqual([]);
  });

  it("refuses and revokes a grant without read-only Gmail access", async () => {
    oauth.scopes = [];
    await connectGmail();
    expect(sent.map((s) => s.text)).toEqual([en.gmail.missingScope]);
    expect(oauth.revoked).toEqual(["refresh-1"]);
    expect(await db.select().from(googleAccounts)).toEqual([]);
  });

  it("shows the connected account instead of a new link", async () => {
    await connectGmail();
    await bot.handleUpdate(textUpdate("/connect_gmail"));
    expect(lastText()).toBe(en.gmail.alreadyConnected("dana@gmail.com", new Date().toISOString().slice(0, 10)));
  });

  it("keeps the grant when reconnecting the same account and revokes a replaced account's grant", async () => {
    await connectGmail();
    await connectGmail();
    expect(oauth.revoked).toEqual([]);
    oauth.email = "dana.work@gmail.com";
    await connectGmail();
    expect(oauth.revoked).toEqual(["refresh-2"]);
    const accounts = await db.select().from(googleAccounts);
    expect(accounts.map((a) => a.email)).toEqual(["dana.work@gmail.com"]);
  });

  it("is unavailable when Google is not configured", async () => {
    const unconfigured = createBot("test-token", createPgServices(db, new FakeProfileAssistant(), new FakeCvTailorer()), { botInfo: BOT_INFO });
    const unconfiguredCalls = captureApiCalls(unconfigured);
    await unconfigured.handleUpdate(textUpdate("/connect_gmail"));
    expect(unconfiguredCalls.at(-1)!.payload.text).toBe(en.gmail.unavailable);
  });
});

describe("expired or revoked grants", () => {
  it("refreshes access tokens while the grant is valid", async () => {
    await connectGmail();
    expect(await gmail.accessToken(await userId())).toEqual({ kind: "ok", accessToken: "fresh-refresh-1", email: "dana@gmail.com" });
  });

  it("marks the account for reconnecting and prompts with a new link", async () => {
    await connectGmail();
    oauth.invalid.add("refresh-1");
    expect(await gmail.accessToken(await userId())).toEqual({ kind: "needs_reconnect", email: "dana@gmail.com" });
    const [account] = await db.select().from(googleAccounts);
    expect(account).toMatchObject({ status: "needs_reconnect", refreshTokenEncrypted: null });

    await requestLink();
    expect(lastText()).toBe(en.gmail.reconnect("dana@gmail.com"));
    const keyboard = calls.at(-1)!.payload.reply_markup.inline_keyboard;
    expect(keyboard[0][0].text).toBe(en.buttons.reconnectGmail);
  });

  it("finds a revoked grant when the user asks to connect", async () => {
    await connectGmail();
    oauth.invalid.add("refresh-1");
    await bot.handleUpdate(textUpdate("/connect_gmail"));
    expect(lastText()).toBe(en.gmail.reconnect("dana@gmail.com"));
  });

  it("asks to reconnect when the stored token can't be decrypted", async () => {
    await connectGmail();
    const rotated = new PgGmailService(db, { ...deps, cipher: TokenCipher.fromBase64(Buffer.alloc(32, 1).toString("base64")) });
    expect((await rotated.accessToken(await userId())).kind).toBe("needs_reconnect");
  });
});

describe("disconnecting gmail", () => {
  it("asks for confirmation, then revokes at Google and deletes the credentials", async () => {
    await connectGmail();
    await bot.handleUpdate(textUpdate("/disconnect_gmail"));
    expect(lastText()).toBe(en.gmail.disconnectConfirm("dana@gmail.com"));
    expect(calls.at(-1)!.payload.reply_markup.inline_keyboard[0][0].callback_data).toBe("gm:disconnect");

    await bot.handleUpdate(callbackUpdate("gm:disconnect"));
    expect(oauth.revoked).toEqual(["refresh-1"]);
    expect(lastText()).toBe(en.gmail.disconnected("dana@gmail.com"));
    expect(await db.select().from(googleAccounts)).toEqual([]);
    expect(await gmail.status(await userId())).toEqual({ kind: "not_connected" });
  });

  it("still deletes the credentials when Google can't confirm the revocation", async () => {
    await connectGmail();
    oauth.revokeFails = true;
    await bot.handleUpdate(callbackUpdate("gm:disconnect"));
    expect(lastText()).toBe(en.gmail.disconnectedNotRevoked("dana@gmail.com"));
    expect(await db.select().from(googleAccounts)).toEqual([]);
  });

  it("disconnects an account that needs reconnecting and invalidates pending links", async () => {
    await connectGmail();
    oauth.invalid.add("refresh-1");
    await gmail.accessToken(await userId());
    const state = await linkState();
    await bot.handleUpdate(callbackUpdate("gm:disconnect"));
    expect(lastText()).toBe(en.gmail.disconnected("dana@gmail.com"));
    expect(await gmail.authorizationUrl(state)).toBeNull();
  });

  it("says when nothing is connected", async () => {
    await bot.handleUpdate(textUpdate("/disconnect_gmail"));
    expect(lastText()).toBe(en.gmail.notConnected);
    await bot.handleUpdate(callbackUpdate("gm:disconnect"));
    expect(lastText()).toBe(en.gmail.notConnected);
  });

  it("deletes the grant with the user", async () => {
    await connectGmail();
    await db.delete(users).where(eq(users.id, await userId()));
    expect(await db.select().from(googleAccounts)).toEqual([]);
  });
});

it("round-trips the disconnect callback", () => {
  expect(decodeCallback(encodeCallback({ type: "gmail_disconnect" }))).toEqual({ type: "gmail_disconnect" });
});
