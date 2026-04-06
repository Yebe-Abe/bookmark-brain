export const PORT = Number(process.env.PORT || 3000);
export const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

// Secret used to derive API keys and MCP tokens. MUST be set in production.
export const SERVER_SECRET = process.env.SERVER_SECRET || "";

// X/Twitter OAuth 2.0
export const X_CLIENT_ID = process.env.X_CLIENT_ID || "";
export const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET || "";

// Anthropic
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// Cloudflare (tunnel provisioning)
export const CF_API_TOKEN = process.env.CF_API_TOKEN || "";
export const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
export const CF_ZONE_ID = process.env.CF_ZONE_ID || "";
export const CF_TUNNEL_DOMAIN = process.env.CF_TUNNEL_DOMAIN || "";
