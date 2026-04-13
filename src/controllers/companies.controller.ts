import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.js";
import { getOrCreateCompany, listCompaniesByUser } from "../lib/companies.js";

export async function listCompaniesHandler(req: AuthRequest, res: Response) {
  try {
    const userId = String(req.query.userId ?? "").trim();
    if (!userId) {
      return res.status(400).json({ error: "userId is required." });
    }
    if (userId !== req.auth!.sub) {
      return res.status(403).json({ error: "Access denied." });
    }
    const companies = await listCompaniesByUser(userId);
    return res.json({ companies });
  } catch (error) {
    console.error("Companies list error:", error);
    return res.status(500).json({ error: "Failed to list companies." });
  }
}

export async function createCompanyHandler(req: AuthRequest, res: Response) {
  try {
    const body = req.body as { userId?: string; name?: string };
    const userId = String(body.userId ?? "").trim();
    const name = String(body.name ?? "");
    if (!userId) {
      return res.status(400).json({ error: "userId is required." });
    }
    if (userId !== req.auth!.sub) {
      return res.status(403).json({ error: "Access denied." });
    }
    const company = await getOrCreateCompany(userId, name);
    return res.json({ company });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save company.";
    const status =
      message === "Invalid user." || message.startsWith("Company name") ? 400 : 500;
    return res.status(status).json({ error: message });
  }
}
