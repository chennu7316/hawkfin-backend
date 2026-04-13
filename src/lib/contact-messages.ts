import pool from "./db.js";

export interface ContactMessage {
  id: string;
  fullName: string;
  emailAddress: string;
  phoneNumber: string | null;
  companyName: string | null;
  interestedIn: string;
  message: string;
  status: "new" | "contacted";
  createdAt: Date;
}

export interface ContactMessageListResult {
  messages: ContactMessage[];
  total: number;
}

let contactMessagesTableReady = false;

async function ensureContactMessagesTable() {
  if (contactMessagesTableReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name     VARCHAR(150) NOT NULL,
      email_address VARCHAR(255) NOT NULL,
      phone_number  VARCHAR(30),
      company_name  VARCHAR(150),
      interested_in VARCHAR(120) NOT NULL,
      message       TEXT NOT NULL,
      status        VARCHAR(20) NOT NULL DEFAULT 'new',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE contact_messages
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'new';
  `);

  await pool.query(`
    UPDATE contact_messages
    SET status = 'new'
    WHERE status IS NULL OR status NOT IN ('new', 'contacted');
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contact_messages_created_at_idx
    ON contact_messages (created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contact_messages_email_lower_idx
    ON contact_messages (LOWER(email_address));
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contact_messages_status_created_idx
    ON contact_messages (status, created_at DESC);
  `);

  contactMessagesTableReady = true;
}

function rowToContactMessage(row: Record<string, unknown>): ContactMessage {
  return {
    id: row.id as string,
    fullName: row.full_name as string,
    emailAddress: row.email_address as string,
    phoneNumber: (row.phone_number as string | null) ?? null,
    companyName: (row.company_name as string | null) ?? null,
    interestedIn: row.interested_in as string,
    message: row.message as string,
    status:
      row.status === "contacted" ? "contacted" : "new",
    createdAt: row.created_at as Date,
  };
}

export async function createContactMessage(input: {
  fullName: string;
  emailAddress: string;
  phoneNumber?: string;
  companyName?: string;
  interestedIn: string;
  message: string;
}): Promise<ContactMessage> {
  await ensureContactMessagesTable();

  const { rows } = await pool.query(
    `INSERT INTO contact_messages (
      full_name,
      email_address,
      phone_number,
      company_name,
      interested_in,
      message,
      status
    )
    VALUES (TRIM($1), LOWER(TRIM($2)), NULLIF(TRIM($3), ''), NULLIF(TRIM($4), ''), TRIM($5), TRIM($6), 'new')
    RETURNING *`,
    [
      input.fullName,
      input.emailAddress,
      input.phoneNumber ?? "",
      input.companyName ?? "",
      input.interestedIn,
      input.message,
    ],
  );

  return rowToContactMessage(rows[0]);
}

export async function findContactMessageByEmail(
  emailAddress: string,
): Promise<ContactMessage | null> {
  await ensureContactMessagesTable();

  const { rows } = await pool.query(
    `SELECT *
     FROM contact_messages
     WHERE LOWER(email_address) = LOWER(TRIM($1))
     ORDER BY created_at DESC
     LIMIT 1`,
    [emailAddress],
  );

  if (rows.length === 0) return null;
  return rowToContactMessage(rows[0] as Record<string, unknown>);
}

export async function listContactMessages(params: {
  page: number;
  limit: number;
}): Promise<ContactMessageListResult> {
  await ensureContactMessagesTable();

  const offset = (params.page - 1) * params.limit;

  const [{ rows: countRows }, { rows: dataRows }] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM contact_messages"),
    pool.query(
      `SELECT *
       FROM contact_messages
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [params.limit, offset],
    ),
  ]);

  return {
    messages: dataRows.map((row) => rowToContactMessage(row as Record<string, unknown>)),
    total: Number(countRows[0]?.count ?? 0),
  };
}

export async function updateContactMessageStatus(params: {
  id: string;
  status: "new" | "contacted";
}): Promise<ContactMessage | null> {
  await ensureContactMessagesTable();

  const { rows } = await pool.query(
    `UPDATE contact_messages
     SET status = $2
     WHERE id = $1
     RETURNING *`,
    [params.id, params.status],
  );

  if (rows.length === 0) return null;
  return rowToContactMessage(rows[0] as Record<string, unknown>);
}
