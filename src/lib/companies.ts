import pool from "./db.js";

export function normalizeCompanyName(raw: string) {
  return raw.trim().replace(/\s+/g, " ");
}

export async function getOrCreateCompany(userId: string, rawName: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("Invalid user.");
  }
  const name = normalizeCompanyName(rawName);
  if (name.length < 2 || name.length > 200) {
    throw new Error("Company name must be between 2 and 200 characters.");
  }

  const existing = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM companies
     WHERE user_id = $1 AND lower(trim(name)) = lower(trim($2))`,
    [userId, name],
  );
  if (existing.rows[0]) {
    return { id: String(existing.rows[0].id), name: String(existing.rows[0].name) };
  }

  const inserted = await pool.query<{ id: string; name: string }>(
    `INSERT INTO companies (user_id, name) VALUES ($1, $2) RETURNING id, name`,
    [userId, name],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("Failed to create company.");
  return { id: String(row.id), name: String(row.name) };
}

export async function listCompaniesByUser(userId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    return [];
  }
  const { rows } = await pool.query(
    `SELECT id, name, created_at FROM companies
     WHERE user_id = $1
     ORDER BY lower(trim(name)) ASC`,
    [userId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
