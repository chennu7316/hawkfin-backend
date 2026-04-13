import crypto from "crypto";
import pool from "./db.js";

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function generateResetCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function createPasswordResetCode(email: string, code: string) {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  await pool.query(
    `INSERT INTO password_reset_codes (email, code_hash, expires_at)
     VALUES (LOWER($1), $2, $3)`,
    [email, hashCode(code), expiresAt],
  );
}

export async function verifyPasswordResetCode(email: string, code: string) {
  const { rows } = await pool.query(
    `SELECT id, code_hash, expires_at, used_at
     FROM password_reset_codes
     WHERE LOWER(email) = LOWER($1)
     ORDER BY created_at DESC
     LIMIT 1`,
    [email],
  );

  if (rows.length === 0) return { ok: false as const, reason: "not_found" as const };
  const row = rows[0] as {
    id: string;
    code_hash: string;
    expires_at: Date;
    used_at: Date | null;
  };

  if (row.used_at) return { ok: false as const, reason: "used" as const };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false as const, reason: "expired" as const };
  }
  if (hashCode(code) !== row.code_hash) {
    return { ok: false as const, reason: "invalid" as const };
  }

  return { ok: true as const, id: row.id };
}

export async function markPasswordResetCodeUsed(id: string) {
  await pool.query(
    `UPDATE password_reset_codes
     SET used_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

