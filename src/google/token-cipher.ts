import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

/** Encrypts OAuth tokens at rest with an app-level AES-256-GCM key; `context` (the owner's id) is authenticated, so a ciphertext only decrypts for its owner. */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new Error("token encryption key must be 32 bytes");
    this.key = Buffer.from(key);
  }

  /** `GOOGLE_TOKEN_ENCRYPTION_KEY`: 32 random bytes, base64 encoded (`openssl rand -base64 32`). */
  static fromBase64(key: string): TokenCipher {
    return new TokenCipher(Buffer.from(key, "base64"));
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), ciphertext].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
  }

  decrypt(sealed: string, context: string): string {
    const [version, iv, tag, ciphertext] = sealed.split(".");
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new Error("unrecognized token ciphertext");
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }
}
