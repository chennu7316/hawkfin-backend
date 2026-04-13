import type { NextFunction, Request, Response } from "express";
import type { JwtPayload } from "../lib/jwt.js";
import { verifyAccessToken } from "../lib/jwt.js";

export type AuthRequest = Request & { auth?: JwtPayload };

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = extractBearer(req);
  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }
  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  const token = extractBearer(req);
  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }
  try {
    const auth = verifyAccessToken(token);
    if (auth.role.toLowerCase() !== "admin") {
      return res.status(403).json({ error: "Admin access required." });
    }
    req.auth = auth;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}
