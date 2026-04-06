import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import { X_CLIENT_ID, X_CLIENT_SECRET, SERVER_URL } from "../config.js";

const router = Router();

// Pending OAuth flows: state → { codeVerifier, createdAt }
const pendingFlows = new Map<string, { codeVerifier: string; createdAt: number }>();

// Completed flows: state → tokens (client polls for these)
const completedFlows = new Map<string, { tokens: unknown; createdAt: number }>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, flow] of pendingFlows) {
    if (now - flow.createdAt > 10 * 60 * 1000) pendingFlows.delete(state);
  }
  for (const [state, flow] of completedFlows) {
    if (now - flow.createdAt > 10 * 60 * 1000) completedFlows.delete(state);
  }
}, 5 * 60 * 1000);

/**
 * GET /auth/x/start
 * Client calls this, gets back { authorizeUrl, state }.
 * Client opens authorizeUrl in user's browser, then polls /auth/x/status?state=...
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

  res.json({ authorizeUrl: `https://x.com/i/oauth2/authorize?${params}`, state });
});

/**
 * GET /auth/x/callback
 * X redirects here after user authorizes. Exchanges code for tokens,
 * stores them for the client to pick up via /auth/x/status.
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

    // Store for client to pick up
    completedFlows.set(state, {
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        userId,
        username,
      },
      createdAt: Date.now(),
    });

    res.send(`<!DOCTYPE html>
<html>
<head><title>bookmark-brain</title></head>
<body style="font-family: system-ui; max-width: 400px; margin: 80px auto; text-align: center;">
  <h2>Connected as @${username}</h2>
  <p>You can close this window. The app will pick up your credentials automatically.</p>
</body>
</html>`);
  } catch (err) {
    console.error("[x-oauth] error:", err);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

/**
 * GET /auth/x/status?state=...
 * Client polls this after opening the browser. Returns tokens once the user authorizes.
 */
router.get("/status", (req: Request, res: Response) => {
  const state = String(req.query.state || "");
  if (!state) {
    res.status(400).json({ error: "state required" });
    return;
  }

  const completed = completedFlows.get(state);
  if (completed) {
    completedFlows.delete(state);
    res.json({ status: "complete", ...completed.tokens as object });
    return;
  }

  if (pendingFlows.has(state)) {
    res.json({ status: "pending" });
    return;
  }

  res.json({ status: "expired" });
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
