import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.js";
import {
  classifyUploadError,
  listStatementHistory,
  uploadStatementsBatch,
} from "../services/statements.service.js";
import { getOrCreateCompany } from "../lib/companies.js";

export async function uploadStatementsHandler(req: AuthRequest, res: Response) {
  try {
    const files = req.files;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "Please attach at least one file." });
    }

    const body = req.body as Record<string, string | string[] | undefined>;
    const yearsRaw = body.years;
    const years = Array.isArray(yearsRaw)
      ? yearsRaw.map((y) => String(y ?? ""))
      : yearsRaw
        ? [String(yearsRaw)]
        : [];

    const userEmail = String(body.userEmail ?? "unknown-user");
    const userId = String(body.userId ?? "").trim();
    const companyName = String(body.companyName ?? "").trim();

    if (years.length !== files.length) {
      return res.status(400).json({
        error: "Each uploaded file must have a matching year.",
      });
    }
    if (!companyName) {
      return res.status(400).json({ error: "Company name is required." });
    }
    if (userId !== req.auth!.sub) {
      return res.status(403).json({ error: "Access denied." });
    }

    let company: { id: string; name: string };
    try {
      company = await getOrCreateCompany(userId, companyName);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid company.";
      const status =
        message === "Invalid user." || message.startsWith("Company name") ? 400 : 500;
      return res.status(status).json({ error: message });
    }

    const statements = files.map((file, index) => {
      const webFile = new File([new Uint8Array(file.buffer)], file.originalname, {
        type: file.mimetype || "application/octet-stream",
      });
      return {
        file: webFile,
        year: years[index] ?? "",
      };
    });

    const upload = await uploadStatementsBatch({
      statements,
      userEmail,
      userId,
      companyId: company.id,
    });
    return res.json({ ...upload, company });
  } catch (error) {
    console.error("Statement upload error:", error);
    const failure = classifyUploadError(error);
    return res.status(failure.status).json({ error: failure.error });
  }
}

export async function statementHistoryHandler(req: AuthRequest, res: Response) {
  try {
    const userId = String(req.query.userId ?? "");
    const companyId = String(req.query.companyId ?? "");
    const year = req.query.year ? String(req.query.year) : undefined;
    const limitParam = req.query.limit;
    const limit = limitParam ? Number(limitParam) : undefined;

    if (!userId.trim()) {
      return res.status(400).json({ error: "userId is required." });
    }
    if (!companyId.trim()) {
      return res.status(400).json({ error: "companyId is required." });
    }
    if (userId !== req.auth!.sub) {
      return res.status(403).json({ error: "Access denied." });
    }

    const statements = await listStatementHistory({ userId, companyId, year, limit });
    return res.json({ statements });
  } catch (error) {
    console.error("Statement history fetch error:", error);
    return res.status(500).json({ error: "Failed to fetch statement history." });
  }
}
