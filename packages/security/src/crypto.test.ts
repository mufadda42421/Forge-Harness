import { describe, it, expect } from "vitest";
import { CredentialCipher } from "./crypto.js";
import { redactSecrets } from "./redact.js";
import { randomBytes } from "node:crypto";

describe("CredentialCipher", () => {
  it("encrypts and decrypts round-trip", () => {
    const cipher = new CredentialCipher(randomBytes(32));
    const secret = "sk-test-super-secret-value-123456";
    const enc = cipher.encrypt(secret);
    expect(enc.ciphertext).not.toContain(secret);
    expect(enc.algorithm).toBe("aes-256-gcm");
    const dec = cipher.decrypt(enc);
    expect(dec).toBe(secret);
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const cipher = new CredentialCipher(randomBytes(32));
    const a = cipher.encrypt("same");
    const b = cipher.encrypt("same");
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt with a different key", () => {
    const cipher1 = new CredentialCipher(randomBytes(32));
    const cipher2 = new CredentialCipher(randomBytes(32));
    const enc = cipher1.encrypt("top secret");
    expect(() => cipher2.decrypt(enc)).toThrow();
  });

  it("tampered ciphertext fails authentication", () => {
    const cipher = new CredentialCipher(randomBytes(32));
    const enc = cipher.encrypt("integrity matters");
    const tampered = { ...enc, ciphertext: Buffer.from(Buffer.from(enc.ciphertext, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64") };
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it("hint exposes at most last 4 characters", () => {
    expect(CredentialCipher.hint("sk-abcdefghij1234")).toBe("••••1234");
  });
});

describe("redactSecrets", () => {
  it("redacts common API key patterns", () => {
    expect(redactSecrets("key is sk-abc123456789012")).not.toContain("sk-abc123456789012");
  });
  it("redacts bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abcdef123456xyz");
    expect(out).not.toContain("abcdef123456xyz");
  });
  it("leaves ordinary text intact", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
  });
});
