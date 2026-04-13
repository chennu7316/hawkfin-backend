import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.js";
import { findUserByEmail } from "../lib/users.js";

export async function checkEmail(req: AuthRequest, res: Response) {
  try {
    const { email } = req.body as { email?: unknown };
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required" });
    }
    const user = await findUserByEmail(email);
    return res.json({ exists: !!user });
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
}
