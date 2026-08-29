import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const encryptionKey = (material, errorCode) => {
  if (!material || String(material).length < 16) {
    const error = new Error(errorCode);
    error.statusCode = 503;
    throw error;
  }
  return createHash("sha256").update(String(material)).digest();
};

export const isSecretEnvelope = (value) =>
  /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
    String(value || ""),
  );

export const encryptSecret = (
  plainText,
  { material, context = "", errorCode = "ENCRYPTION_KEY_REQUIRED" },
) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    encryptionKey(material, errorCode),
    iv,
  );
  if (context) cipher.setAAD(Buffer.from(context, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
};

export const decryptSecret = (
  payload,
  {
    material,
    context = "",
    keyErrorCode = "ENCRYPTION_KEY_REQUIRED",
    decryptErrorCode = "SECRET_DECRYPT_FAILED",
  },
) => {
  const [version, iv, tag, encrypted] = String(payload || "").split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) {
    throw new Error(decryptErrorCode);
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(material, keyErrorCode),
      Buffer.from(iv, "base64url"),
    );
    if (context) decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error.message === keyErrorCode) throw error;
    throw new Error(decryptErrorCode);
  }
};
