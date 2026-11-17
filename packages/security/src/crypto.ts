import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGORITHM = "aes-256-gcm";

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  algorithm: typeof ALGORITHM;
}

/**
 * AES-256-GCM credential encryption.
 *
 * Master key resolution order:
 *  1. FORGE_MASTER_KEY environment variable (base64-encoded 32 bytes).
 *  2. Key file at <dataDir>/master.key (auto-generated, mode 0600) — documented
 *     development fallback. Set FORGE_MASTER_KEY in production.
 *
 * The OS keychain integration is pluggable via KeyProvider; the file-based
 * provider is the default. Secrets are only ever decrypted in memory, for the
 * duration of one outbound request.
 */
export class CredentialCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("master key must be 32 bytes");
    this.key = key;
  }

  static fromEnvOrFile(dataDir: string): CredentialCipher {
    const envKey = process.env.FORGE_MASTER_KEY;
    if (envKey) {
      const decoded = Buffer.from(envKey, "base64");
      if (decoded.length !== 32) {
        throw new Error("FORGE_MASTER_KEY must be a base64-encoded 32-byte key");
      }
      return new CredentialCipher(decoded);
    }
    const keyPath = path.join(dataDir, "master.key");
    if (fs.existsSync(keyPath)) {
      const raw = fs.readFileSync(keyPath);
      if (raw.length === 32) return new CredentialCipher(raw);
      // tolerate base64-encoded key files
      const decoded = Buffer.from(raw.toString("utf8").trim(), "base64");
      if (decoded.length === 32) return new CredentialCipher(decoded);
      throw new Error(`master key file at ${keyPath} is invalid`);
    }
    fs.mkdirSync(dataDir, { recursive: true });
    const key = randomBytes(32);
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      /* best effort on Windows */
    }
    return new CredentialCipher(key);
  }

  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      algorithm: ALGORITHM,
    };
  }

  decrypt(payload: EncryptedPayload): string {
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }

  /** Mask a secret for UI display: never returns recoverable material. */
  static hint(plaintext: string): string {
    const trimmed = plaintext.trim();
    const last4 = trimmed.slice(-4);
    return `••••${last4}`;
  }

  /** Constant-time comparison used for admin token checks. */
  static safeEqual(a: string, b: string): boolean {
    const ha = createHash("sha256").update(a).digest();
    const hb = createHash("sha256").update(b).digest();
    return timingSafeEqual(ha, hb);
  }
}
