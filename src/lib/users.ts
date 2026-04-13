import crypto from "crypto";
import pool from "./db.js";

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  passwordHint: string | null;
  marketingUpdates: boolean;
  agreeTerms: boolean;
  passwordHash: string;
  createdAt: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  createdAt: Date;
}

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    role: row.role as string,
    passwordHint: (row.password_hint as string | null) ?? null,
    marketingUpdates: Boolean(row.marketing_updates),
    agreeTerms: Boolean(row.agree_terms),
    passwordHash: row.password_hash as string,
    createdAt: row.created_at as Date,
  };
}

export async function findUserByEmail(
  email: string,
): Promise<User | undefined> {
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1",
    [email],
  );
  return rows.length > 0 ? rowToUser(rows[0]) : undefined;
}

export function verifyPassword(user: User, password: string): boolean {
  return user.passwordHash === hashPassword(password);
}

export async function createUser(data: {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  role: string;
  passwordHint?: string;
  marketingUpdates?: boolean;
  agreeTerms?: boolean;
}): Promise<User> {
  const { rows } = await pool.query(
    `INSERT INTO users (
      email,
      first_name,
      last_name,
      password_hash,
      role,
      password_hint,
      marketing_updates,
      agree_terms
    )
     VALUES (LOWER($1), $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.email,
      data.firstName,
      data.lastName,
      hashPassword(data.password),
      data.role,
      data.passwordHint || null,
      data.marketingUpdates ?? false,
      data.agreeTerms ?? false,
    ],
  );
  return rowToUser(rows[0]);
}

export async function updateUserPasswordByEmail(email: string, password: string) {
  const passwordHash = hashPassword(password);
  const { rowCount } = await pool.query(
    `UPDATE users
     SET password_hash = $2
     WHERE LOWER(email) = LOWER($1)`,
    [email, passwordHash],
  );
  return (rowCount ?? 0) > 0;
}

export async function listUsers(): Promise<PublicUser[]> {
  const { rows } = await pool.query(
    `SELECT id, email, first_name, last_name, role, created_at
     FROM users
     ORDER BY created_at DESC`,
  );

  return rows.map((row) => ({
    id: row.id as string,
    email: row.email as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    role: row.role as string,
    createdAt: row.created_at as Date,
  }));
}

export async function deleteUserById(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [id]);
  return rows.length > 0 ? rowToUser(rows[0]) : undefined;
}

export async function updateUserById(
  id: string,
  data: {
    firstName: string;
    lastName: string;
    email: string;
    role: string;
  },
): Promise<PublicUser | undefined> {
  const { rows } = await pool.query(
    `UPDATE users
     SET first_name = $2,
         last_name = $3,
         email = LOWER($4),
         role = $5
     WHERE id = $1
     RETURNING id, email, first_name, last_name, role, created_at`,
    [id, data.firstName, data.lastName, data.email, data.role],
  );

  if (rows.length === 0) return undefined;
  const row = rows[0];
  return {
    id: row.id as string,
    email: row.email as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    role: row.role as string,
    createdAt: row.created_at as Date,
  };
}

export async function listRoles(): Promise<string[]> {
  const { rows } = await pool.query(
    "SELECT name FROM roles ORDER BY LOWER(name) ASC",
  );
  return rows.map((row) => row.name as string);
}

export async function createRole(name: string): Promise<string> {
  const normalizedName = name.trim();
  const existing = await pool.query(
    "SELECT name FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1",
    [normalizedName],
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].name as string;
  }

  const { rows } = await pool.query(
    `INSERT INTO roles (name)
     VALUES ($1)
     RETURNING name`,
    [normalizedName],
  );
  return rows[0].name as string;
}

export async function roleExists(name: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1",
    [name],
  );
  return rows.length > 0;
}

export async function renameRole(oldName: string, newName: string): Promise<string> {
  const sourceName = oldName.trim();
  const targetName = newName.trim();

  const existingTarget = await pool.query(
    "SELECT 1 FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1",
    [targetName],
  );
  if (existingTarget.rows.length > 0) {
    return targetName;
  }

  const updateRoleResult = await pool.query(
    `UPDATE roles
     SET name = $2
     WHERE LOWER(name) = LOWER($1)
     RETURNING name`,
    [sourceName, targetName],
  );

  if (updateRoleResult.rows.length === 0) {
    throw new Error("Role not found");
  }

  await pool.query(
    `UPDATE users
     SET role = $2
     WHERE LOWER(role) = LOWER($1)`,
    [sourceName, targetName],
  );

  return updateRoleResult.rows[0].name as string;
}

export async function countUsersByRole(name: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE LOWER(role) = LOWER($1)",
    [name],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function deleteRole(name: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "DELETE FROM roles WHERE LOWER(name) = LOWER($1)",
    [name],
  );
  return (rowCount ?? 0) > 0;
}
