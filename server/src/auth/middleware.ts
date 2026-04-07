import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { SERVER_SECRET } from "../config.js";

// --- Rate limiting ---

const hits = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of hits) {
    if (now > val.resetAt) hits.delete(key);
  }
}, 60_000);

export function rateLimit(windowMs: number, maxRequests: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count++;
    if (entry.count > maxRequests) {
      res.status(429).json({ error: "Too many requests. Try again later." });
      return;
    }

    next();
  };
}

// --- Auth ---

/** Derive an API key from SERVER_SECRET + user ID. Stateless, no database. */
export function deriveApiKey(userId: string): string {
  return `bbk_${crypto.createHmac("sha256", SERVER_SECRET).update(`api:${userId}`).digest("hex")}`;
}

/**
 * Auth middleware. Requires Authorization: Bearer bbk_<key> + X-User-Id header.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!SERVER_SECRET) {
    res.status(500).json({ error: "Server not configured" });
    return;
  }

  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const userId = String(req.headers["x-user-id"] || "");

  if (!token || !userId) {
    res.status(401).json({ error: "Missing Authorization or X-User-Id header" });
    return;
  }

  const expected = deriveApiKey(userId);
  if (token.length !== expected.length || token !== expected) {
    res.status(403).json({ error: "Invalid API key" });
    return;
  }

  (req as Request & { userId: string }).userId = userId;
  next();
}
