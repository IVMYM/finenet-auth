import { publicEncrypt, constants, createPublicKey } from "node:crypto";

/**
 * Normalize a WeCom-pasted RSA public key into PEM.
 * Accepts PEM, or base64/body-only blobs with optional wrapping.
 */
export function normalizePublicKey(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("公钥为空");
  }

  let key = raw.trim().replace(/\r\n/g, "\n").replace(/\\n/g, "\n");

  if (!key.includes("BEGIN")) {
    // Strip whitespace and wrap as SPKI PEM
    const body = key.replace(/\s+/g, "");
    const lines = body.match(/.{1,64}/g)?.join("\n") || body;
    key = `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
  }

  // Validate
  createPublicKey(key);
  return key;
}

/**
 * Build the plaintext that gets RSA-encrypted into `sign`:
 * `{ usercode, username, timestamp }` as a compact JSON string.
 */
export function buildSignPayload({ usercode, username, timestamp }) {
  const ts = timestamp ?? Date.now();
  return JSON.stringify({
    usercode: String(usercode ?? ""),
    username: String(username ?? ""),
    timestamp: ts,
  });
}

/**
 * RSA-encrypt sign payload with the WeCom-issued public key (PKCS#1 v1.5).
 * Returns base64 ciphertext. Empty string if key/payload invalid.
 */
export function encryptSign(publicKeyPem, fields) {
  try {
    const pem = normalizePublicKey(publicKeyPem);
    const plain = Buffer.from(buildSignPayload(fields), "utf8");
    const encrypted = publicEncrypt(
      {
        key: pem,
        padding: constants.RSA_PKCS1_PADDING,
      },
      plain
    );
    return encrypted.toString("base64");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`RSA 签名加密失败: ${msg}`);
  }
}

/**
 * Try both PKCS1 and OAEP; some gateways accept either.
 * Prefer PKCS1 (matches typical Java/Android enterprise SPA clients).
 */
export function encryptSignFlexible(publicKeyPem, fields) {
  try {
    return encryptSign(publicKeyPem, fields);
  } catch (first) {
    try {
      const pem = normalizePublicKey(publicKeyPem);
      const plain = Buffer.from(buildSignPayload(fields), "utf8");
      const encrypted = publicEncrypt(
        {
          key: pem,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        plain
      );
      return encrypted.toString("base64");
    } catch {
      throw first;
    }
  }
}
