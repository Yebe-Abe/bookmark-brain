import crypto from "crypto";
import { SERVER_SECRET } from "../config.js";

/**
 * All keys are derived from SERVER_SECRET + X user ID via HMAC.
 * Zero database. Same inputs always produce same outputs.
 * Rotate SERVER_SECRET to invalidate all keys.
 */

function hmac(purpose: string, userId: string): string {
  if (!SERVER_SECRET) throw new Error("SERVER_SECRET not set");
  return crypto.createHmac("sha256", SERVER_SECRET).update(`${purpose}:${userId}`).digest("hex");
}

/** API key for server endpoints. Client sends as Authorization: Bearer <key>. */
export function deriveApiKey(userId: string): string {
  return `bbk_${hmac("api", userId)}`;
}

/** Token for MCP peephole auth. Claude sends as Authorization: Bearer <token>. */
export function deriveMcpToken(userId: string): string {
  return `bbm_${hmac("mcp", userId)}`;
}

/** Deterministic subdomain for a user. 12 hex chars — not guessable without the secret. */
export function deriveSubdomain(userId: string): string {
  return hmac("sub", userId).slice(0, 12);
}

/** Tunnel secret for Cloudflare tunnel creation. */
export function deriveTunnelSecret(userId: string): Buffer {
  return crypto.createHmac("sha256", SERVER_SECRET).update(`tunnel:${userId}`).digest();
}

/**
 * Validate an API key. Returns the X user ID if valid, null otherwise.
 * Works by checking if the key matches what we'd derive for the claimed user.
 */
export function validateApiKey(key: string, claimedUserId: string): boolean {
  if (!key.startsWith("bbk_")) return false;
  const expected = deriveApiKey(claimedUserId);
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
}

/**
 * Extract user ID from a request's API key by checking against a provided user ID.
 * For endpoints where the user ID is in the request body or path.
 */
export function validateMcpToken(token: string, claimedUserId: string): boolean {
  if (!token.startsWith("bbm_")) return false;
  const expected = deriveMcpToken(claimedUserId);
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
