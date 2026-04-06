export const PORT = Number(process.env.PORT || 3000);
export const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

// X/Twitter OAuth 2.0 (your developer app credentials)
export const X_CLIENT_ID = process.env.X_CLIENT_ID || "";
export const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET || "";

// Anthropic (you pay for processing)
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// Cloudflare (for provisioning named tunnels)
export const CF_API_TOKEN = process.env.CF_API_TOKEN || "";
export const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
export const CF_ZONE_ID = process.env.CF_ZONE_ID || "";
export const CF_TUNNEL_DOMAIN = process.env.CF_TUNNEL_DOMAIN || ""; // e.g. "mcp.yourdomain.com"
