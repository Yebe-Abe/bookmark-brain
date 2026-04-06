import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import { X_CLIENT_ID, X_CLIENT_SECRET, SERVER_URL } from "../config.js";

const router = Router();

// In-memory store for pending OAuth flows (code_verifier keyed by state)
// In production, use Redis or a database with TTL
const pendingFlows = new Map<string, { codeVerifier: string; createdAt: number }>();

// Clean up expired flows every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, flow] of pendingFlows) {
    if (now - flow.createdAt > 10 * 60 * 1000) pendingFlows.delete(state);
  }
}, 5 * 60 * 1000);

/**
 * GET /auth/x/start
 * Returns a URL the client should open in the user's browser.
 * Uses OAuth 2.0 PKCE so the client never sees our client_secret.
 */
router.get("/start", (_req: Request, res: Response) => {
  if (!X_CLIENT_ID) {
    res.status(500).json({ error: "X_CLIENT_ID not configured on server" });
    return;
  }

  const state = crypto.randomUUID();
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  pendingFlows.set(state, { codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: X_CLIENT_ID,
    redirect_uri: `${SERVER_URL}/auth/x/callback`,
    scope: "bookmark.read tweet.read users.read offline.access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authorizeUrl = `https://x.com/i/oauth2/authorize?${params}`;
  res.json({ authorizeUrl, state });
});

/**
 * GET /auth/x/callback
 * X redirects here after the user authorizes.
 * Exchanges the code for tokens and returns them to the client.
 */
router.get("/callback", async (req: Request, res: Response) => {
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const error = String(req.query.error || "");

  if (error) {
    res.status(400).send(`Authorization failed: ${error}. You can close this window.`);
    return;
  }

  const flow = pendingFlows.get(state);
  if (!flow) {
    res.status(400).send("Invalid or expired state. Please try again.");
    return;
  }
  pendingFlows.delete(state);

  try {
    const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: `${SERVER_URL}/auth/x/callback`,
        code_verifier: flow.codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error("[x-oauth] token exchange failed:", errText);
      res.status(502).send("Token exchange failed. Please try again.");
      return;
    }

    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    // Fetch the user's ID and username
    const meResponse = await fetch("https://api.x.com/2/users/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    let userId = "";
    let username = "";
    if (meResponse.ok) {
      const me = (await meResponse.json()) as { data: { id: string; username: string } };
      userId = me.data.id;
      username = me.data.username;
    }

    // Return an HTML page that sends the tokens back to the app via a deep link or displays them
    res.send(`<!DOCTYPE html>
<html>
<head><title>bookmark-brain</title></head>
<body style="font-family: system-ui; max-width: 500px; margin: 80px auto; text-align: center;">
  <h2>Connected to X as @${username}</h2>
  <p>Copy this token back to the bookmark-brain app:</p>
  <pre style="background: #f0f0f0; padding: 16px; border-radius: 8px; word-break: break-all; text-align: left; font-size: 12px;">${JSON.stringify({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresIn: tokens.expires_in, userId, username })}</pre>
  <p style="color: #888; font-size: 14px;">You can close this window after copying.</p>
</body>
</html>`);
  } catch (err) {
    console.error("[x-oauth] error:", err);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

/**
 * POST /auth/x/refresh
 * Refresh an expired access token. Client sends { refreshToken }.
 */
router.post("/refresh", async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) {
    res.status(400).json({ error: "refreshToken required" });
    return;
  }

  try {
    const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error("[x-oauth] refresh failed:", errText);
      res.status(502).json({ error: "Token refresh failed" });
      return;
    }

    const tokens = await tokenResponse.json();
    res.json(tokens);
  } catch (err) {
    console.error("[x-oauth] refresh error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
