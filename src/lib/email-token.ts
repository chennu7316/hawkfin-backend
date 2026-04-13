import crypto from "crypto";

function getSecretKey() {
  const raw = process.env.RESET_EMAIL_SECRET ?? "";
  if (!raw) {
    throw new Error("RESET_EMAIL_SECRET is not configured.");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptEmailToken(email: string): string {
  const key = getSecretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(email, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${encrypted.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptEmailToken(token: string): string | null {
  try {
    const [ivPart, dataPart, tagPart] = token.split(".");
    if (!ivPart || !dataPart || !tagPart) return null;
    const key = getSecretKey();
    const iv = Buffer.from(ivPart, "base64url");
    const encrypted = Buffer.from(dataPart, "base64url");
    const tag = Buffer.from(tagPart, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

