import nodemailer from "nodemailer";
import {
  createUser,
  findUserByEmail,
  roleExists,
  updateUserPasswordByEmail,
  verifyPassword,
} from "../lib/users.js";
import { decryptEmailToken, encryptEmailToken } from "../lib/email-token.js";
import {
  createPasswordResetCode,
  generateResetCode,
  markPasswordResetCodeUsed,
  verifyPasswordResetCode,
} from "../lib/password-reset.js";
import { signAccessToken } from "../lib/jwt.js";

const passwordPolicy =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

function getMailerConfig() {
  const host = process.env.SMTP_HOST ?? "smtppro.zoho.in";
  const port = Number(process.env.SMTP_PORT ?? "587");
  const secure = String(process.env.SMTP_SECURE ?? "false").toLowerCase() === "true";
  const user = process.env.SMTP_USER ?? "sales@hawkfin.io";
  const pass = process.env.SMTP_PASS ?? "";
  const from = process.env.SMTP_FROM ?? user;
  const appBaseUrl =
    process.env.FRONTEND_APP_URL?.replace(/\/+$/, "") ??
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ??
    "http://localhost:3000";
  return { host, port, secure, user, pass, from, appBaseUrl };
}

export async function loginService(email: string, password: string) {
  if (!email || !password) {
    return { ok: false as const, status: 400, error: "Email and password are required" };
  }

  const user = await findUserByEmail(email);
  if (!user || !verifyPassword(user, password)) {
    return { ok: false as const, status: 401, error: "Invalid email or password" };
  }

  const token = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
  });

  return {
    ok: true as const,
    message: "Login successful",
    token,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
  };
}

export async function registerService(body: {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  role: string;
  passwordHint?: string;
  marketingUpdates?: boolean;
  agreeTerms?: boolean;
}) {
  const {
    email,
    firstName,
    lastName,
    password,
    role,
    passwordHint,
    marketingUpdates,
    agreeTerms,
  } = body;

  if (!email || !firstName || !lastName || !password || !role) {
    return { ok: false as const, status: 400, error: "All fields are required" };
  }
  if (!passwordPolicy.test(password)) {
    return {
      ok: false as const,
      status: 400,
      error:
        "Password must be at least 8 chars and include uppercase, lowercase, number, and special character.",
    };
  }
  if (!agreeTerms) {
    return {
      ok: false as const,
      status: 400,
      error: "Terms and Privacy consent is required.",
    };
  }

  const isValidRole = await roleExists(role);
  if (!isValidRole) {
    return { ok: false as const, status: 400, error: "Selected role is not available." };
  }
  if (String(role).toLowerCase() === "admin") {
    return {
      ok: false as const,
      status: 403,
      error: "Admin account cannot be created from signup.",
    };
  }

  if (await findUserByEmail(email)) {
    return {
      ok: false as const,
      status: 409,
      error: "A user with this email already exists",
    };
  }

  const user = await createUser({
    email,
    firstName,
    lastName,
    password,
    role,
    passwordHint,
    marketingUpdates,
    agreeTerms,
  });

  const token = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
  });

  return {
    ok: true as const,
    status: 201,
    message: "Registration successful",
    token,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
  };
}

export async function forgotPasswordService(email: string) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!normalizedEmail) {
    return { ok: false as const, status: 400, error: "Email is required" };
  }

  const cfg = getMailerConfig();
  if (!cfg.pass) {
    return { ok: false as const, status: 500, error: "SMTP password is not configured." };
  }

  const user = await findUserByEmail(normalizedEmail);
  if (!user) {
    return {
      ok: true as const,
      message:
        "If an account exists for this email, a password reset link has been sent.",
    };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure && cfg.port === 587,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  const resetCode = generateResetCode();
  await createPasswordResetCode(normalizedEmail, resetCode);
  const emailToken = encodeURIComponent(encryptEmailToken(normalizedEmail));
  const resetPage = `${cfg.appBaseUrl}/reset-password?token=${emailToken}`;

  const sentAt = new Date();
  const sentLabel = sentAt.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
  const refId = `HF-${sentAt.getTime().toString(36)}-${resetCode.slice(-2)}`;

  await transporter.sendMail({
    from: cfg.from,
    to: normalizedEmail,
    subject: `Hawkfin.io — Password reset (${sentLabel})`,
    html: `
        <!-- ${refId} -->
        <div style="font-family: Arial, sans-serif; color: #111827;">
          <p style="font-size: 12px; color: #6b7280; margin: 0 0 16px 0;">
            Request ${refId} · ${sentLabel}
          </p>
          <h2 style="margin-bottom: 8px;">Reset your password</h2>
          <p style="margin-bottom: 16px;">
            Use this verification code to reset your Hawkfin.io password:
          </p>
          <p style="font-size: 28px; font-weight: 700; letter-spacing: 3px; margin: 0 0 18px 0;">${resetCode}</p>
          <p style="margin-bottom: 12px;">
            <a href="${resetPage}" style="background:#111827;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block;">
              Open reset page
            </a>
          </p>
          <p style="font-size: 12px; color: #374151; margin: 0 0 16px 0; word-break: break-all;">
            If the button above is collapsed in Gmail, open this link:<br />
            <a href="${resetPage}" style="color: #1d4ed8;">${resetPage}</a>
          </p>
          <p style="font-size: 13px; color: #4b5563;">
            This code expires in 5 minutes. If you did not request this, you can ignore this email.
          </p>
        </div>
      `,
    text: [
      `Request ${refId} · ${sentLabel}`,
      ``,
      `Your Hawkfin.io reset code is ${resetCode}.`,
      ``,
      `Open the reset page: ${resetPage}`,
      ``,
      `This code expires in 5 minutes.`,
    ].join("\n"),
  });

  return {
    ok: true as const,
    message:
      "If an account exists for this email, a password reset link has been sent.",
  };
}

export async function resetPasswordService(token: string, code: string, newPassword: string) {
  const decryptedEmail = decryptEmailToken(String(token ?? "").trim());
  const normalizedEmail = String(decryptedEmail ?? "").trim().toLowerCase();
  const normalizedCode = String(code ?? "").trim();
  const password = String(newPassword ?? "");

  if (!normalizedEmail || !normalizedCode || !password) {
    return { ok: false as const, status: 400, error: "Invalid reset link or missing fields." };
  }

  if (!passwordPolicy.test(password)) {
    return {
      ok: false as const,
      status: 400,
      error:
        "Password must be at least 8 chars and include uppercase, lowercase, number, and special character.",
    };
  }

  const verification = await verifyPasswordResetCode(normalizedEmail, normalizedCode);
  if (!verification.ok) {
    return { ok: false as const, status: 400, error: "Invalid or expired code." };
  }

  const updated = await updateUserPasswordByEmail(normalizedEmail, password);
  if (!updated) {
    return { ok: false as const, status: 404, error: "User not found." };
  }

  await markPasswordResetCodeUsed(verification.id);
  return { ok: true as const, message: "Password reset successful." };
}
