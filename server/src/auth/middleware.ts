import type { Request, Response, NextFunction } from "express";
import { SERVER_SECRET } from "../config.js";
import { deriveApiKey } from "./keys.js";

/**
 * Rate limiter. Tracks requests per IP with a sliding window.
 * No dependencies — just a Map with TTL cleanup.
 */
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

/**
 * Auth middleware. Requires Authorization: Bearer bbk_<key> header
 * and X-User-Id header. Validates the key matches the claimed user.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!SERVER_SECRET) {
    res.status(500).json({ error: "Server not configured (missing SERVER_SECRET)" });
    return;
  }

  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const userId = String(req.headers["x-user-id"] || "");

  if (!token || !userId) {
    res.status(401).json({ error: "Missing Authorization header or X-User-Id header" });
    return;
  }

  const expected = deriveApiKey(userId);
  if (token.length !== expected.length || token !== expected) {
    res.status(403).json({ error: "Invalid API key" });
    return;
  }

  // Attach userId to request for downstream use
  (req as Request & { userId: string }).userId = userId;
  next();
}
