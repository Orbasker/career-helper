import type { GmailDeps } from "../app/postgres/gmail.js";
import { HttpGoogleOAuth } from "./oauth.js";
import { TokenCipher } from "./token-cipher.js";

export const GOOGLE_CONNECT_PATH = "/api/google/connect";
export const GOOGLE_CALLBACK_PATH = "/api/google/callback";

/** `APP_BASE_URL`, otherwise the Vercel production domain. */
export function appBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  if (env.APP_BASE_URL) return env.APP_BASE_URL.replace(/\/+$/, "");
  return env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null;
}

/** Gmail connection settings, or null when any is missing so the bot reports Gmail as unavailable. */
export function gmailDepsFromEnv(env: Record<string, string | undefined> = process.env): GmailDeps | null {
  const base = appBaseUrl(env);
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_TOKEN_ENCRYPTION_KEY: key } = env;
  if (!base || !clientId || !clientSecret || !key) return null;
  return {
    oauth: new HttpGoogleOAuth({ clientId, clientSecret, redirectUri: `${base}${GOOGLE_CALLBACK_PATH}` }),
    cipher: TokenCipher.fromBase64(key),
    connectUrl: (state) => `${base}${GOOGLE_CONNECT_PATH}?${new URLSearchParams({ state })}`,
  };
}
