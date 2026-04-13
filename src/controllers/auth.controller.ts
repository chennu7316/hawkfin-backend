import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.js";
import {
  forgotPasswordService,
  loginService,
  registerService,
  resetPasswordService,
} from "../services/auth.service.js";

export async function login(req: AuthRequest, res: Response) {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    const result = await loginService(String(email ?? ""), String(password ?? ""));
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.json({
      message: result.message,
      token: result.token,
      user: result.user,
    });
  } catch (e) {
    console.error("Login error:", e);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function register(req: AuthRequest, res: Response) {
  try {
    const result = await registerService(req.body);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.status(result.status).json({
      message: result.message,
      token: result.token,
      user: result.user,
    });
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function forgotPassword(req: AuthRequest, res: Response) {
  try {
    const { email } = req.body as { email?: string };
    const result = await forgotPasswordService(String(email ?? ""));
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.json({ message: result.message });
  } catch (e) {
    console.error("Forgot password error:", e);
    return res.status(500).json({ error: "Failed to send reset email." });
  }
}

export async function resetPassword(req: AuthRequest, res: Response) {
  try {
    const { token, code, newPassword } = req.body as {
      token?: string;
      code?: string;
      newPassword?: string;
    };
    const result = await resetPasswordService(
      String(token ?? ""),
      String(code ?? ""),
      String(newPassword ?? ""),
    );
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.json({ message: result.message });
  } catch (e) {
    console.error("Reset password error:", e);
    return res.status(500).json({ error: "Failed to reset password." });
  }
}
