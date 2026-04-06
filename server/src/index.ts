import express from "express";
import { PORT, X_CLIENT_ID, ANTHROPIC_API_KEY, CF_API_TOKEN } from "./config.js";
import xOauthRouter from "./auth/x-oauth.js";
import processRouter from "./api/process.js";
import tunnelRouter from "./api/tunnel.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    services: {
      xOauth: !!X_CLIENT_ID,
      processing: !!ANTHROPIC_API_KEY,
      tunnels: !!CF_API_TOKEN,
    },
  });
});

// Routes
app.use("/auth/x", xOauthRouter);
app.use("/api/process", processRouter);
app.use("/api/tunnel", tunnelRouter);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] X OAuth:    ${X_CLIENT_ID ? "enabled" : "DISABLED (set X_CLIENT_ID)"}`);
  console.log(`[server] Processing: ${ANTHROPIC_API_KEY ? "enabled" : "DISABLED (set ANTHROPIC_API_KEY)"}`);
  console.log(`[server] Tunnels:    ${CF_API_TOKEN ? "enabled" : "DISABLED (set CF_API_TOKEN)"}`);
});
