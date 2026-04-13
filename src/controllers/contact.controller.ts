import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.js";
import { singleParam } from "../utils/route-params.js";
import {
  createContactMessage,
  findContactMessageByEmail,
  listContactMessages,
  updateContactMessageStatus,
} from "../lib/contact-messages.js";

function toSafePage(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.floor(parsed);
}

function toSafeLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 10;
  return Math.min(100, Math.floor(parsed));
}

export async function createContactMessageHandler(req: AuthRequest, res: Response) {
  try {
    const body = req.body as {
      fullName?: string;
      fullname?: string;
      email?: string;
      emailAddress?: string;
      phoneNumber?: string;
      companyName?: string;
      interestedIn?: string;
      message?: string;
    };

    const fullName = String(body.fullName ?? body.fullname ?? "").trim();
    const emailAddress = String(body.emailAddress ?? body.email ?? "").trim();
    const phoneNumber = String(body.phoneNumber ?? "").trim();
    const companyName = String(body.companyName ?? "").trim();
    const interestedIn = String(body.interestedIn ?? "").trim();
    const message = String(body.message ?? "").trim();

    if (!fullName || !emailAddress) {
      return res.status(400).json({
        error: "Full name and email address are required.",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailAddress)) {
      return res.status(400).json({ error: "Please provide a valid email address." });
    }

    const existing = await findContactMessageByEmail(emailAddress);
    if (existing) {
      return res.status(200).json({ message: "Message received successfully." });
    }

    const created = await createContactMessage({
      fullName,
      emailAddress,
      phoneNumber,
      companyName,
      interestedIn: interestedIn || "General Inquiry",
      message: message || "No message provided.",
    });

    return res.status(201).json({
      message: "Message received successfully.",
      contactMessage: {
        id: created.id,
        fullName: created.fullName,
        emailAddress: created.emailAddress,
        phoneNumber: created.phoneNumber,
        companyName: created.companyName,
        interestedIn: created.interestedIn,
        message: created.message,
        status: created.status,
        createdAt: created.createdAt,
      },
    });
  } catch (error) {
    console.error("Contact message create error:", error);
    return res.status(500).json({ error: "Failed to submit message." });
  }
}

export async function listContactMessagesHandler(req: AuthRequest, res: Response) {
  try {
    const page = toSafePage(req.query.page as string | undefined);
    const limit = toSafeLimit(req.query.limit as string | undefined);

    const { messages, total } = await listContactMessages({ page, limit });
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.json({
      messages: messages.map((entry) => ({
        id: entry.id,
        fullName: entry.fullName,
        emailAddress: entry.emailAddress,
        phoneNumber: entry.phoneNumber,
        companyName: entry.companyName,
        interestedIn: entry.interestedIn,
        message: entry.message,
        status: entry.status,
        createdAt: entry.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Contact message list error:", error);
    return res.status(500).json({ error: "Failed to load contact messages." });
  }
}

export async function patchContactMessageHandler(req: AuthRequest, res: Response) {
  try {
    const id = singleParam(req.params.id);
    const body = req.body as { status?: string };

    const statusRaw = String(body.status ?? "").trim().toLowerCase();
    const status = statusRaw === "contacted" ? "contacted" : statusRaw === "new" ? "new" : "";

    if (!id) {
      return res.status(400).json({ error: "Message id is required." });
    }

    if (!status) {
      return res.status(400).json({
        error: "Status must be either 'new' or 'contacted'.",
      });
    }

    const updated = await updateContactMessageStatus({ id, status });
    if (!updated) {
      return res.status(404).json({ error: "Contact message not found." });
    }

    return res.json({
      contactMessage: {
        id: updated.id,
        fullName: updated.fullName,
        emailAddress: updated.emailAddress,
        phoneNumber: updated.phoneNumber,
        companyName: updated.companyName,
        interestedIn: updated.interestedIn,
        message: updated.message,
        status: updated.status,
        createdAt: updated.createdAt,
      },
    });
  } catch (error) {
    console.error("Contact message update error:", error);
    return res.status(500).json({ error: "Failed to update contact message." });
  }
}
