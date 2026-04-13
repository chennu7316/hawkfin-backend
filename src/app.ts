import cors from "cors";
import express from "express";
import { apiRouter } from "./routes/api.routes.js";

const configuredOrigins = (process.env.FRONTEND_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function resolveAllowedOrigin(requestOrigin: string | undefined): string {
  if (configuredOrigins.includes("*")) return "*";
  if (requestOrigin && configuredOrigins.includes(requestOrigin)) return requestOrigin;
  return configuredOrigins[0] ?? "*";
}

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin(origin, callback) {
        callback(null, resolveAllowedOrigin(origin));
      },
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: false,
    }),
  );

  app.use(express.json({ limit: "2mb" }));
  app.use("/api", apiRouter);

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
