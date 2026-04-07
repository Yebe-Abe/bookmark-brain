export const PORT = Number(process.env.PORT || 3000);
export const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

// Secret used to derive API keys. MUST be set in production.
export const SERVER_SECRET = process.env.SERVER_SECRET || "";

// X/Twitter OAuth 2.0
export const X_CLIENT_ID = process.env.X_CLIENT_ID || "";
export const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET || "";

// Anthropic
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
