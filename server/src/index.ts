import express from "express";
import { PORT, SERVER_SECRET, X_CLIENT_ID, ANTHROPIC_API_KEY } from "./config.js";
import xOauthRouter from "./auth/x-oauth.js";
import processRouter from "./api/process.js";
import { rateLimit } from "./auth/middleware.js";

if (!SERVER_SECRET) {
  console.error("[server] FATAL: SERVER_SECRET must be set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(rateLimit(60_000, 100));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    services: {
      xOauth: !!X_CLIENT_ID,
      processing: !!ANTHROPIC_API_KEY,
    },
  });
});

app.use("/auth/x", xOauthRouter);
app.use("/api/process", processRouter);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] X OAuth:    ${X_CLIENT_ID ? "enabled" : "DISABLED"}`);
  console.log(`[server] Processing: ${ANTHROPIC_API_KEY ? "enabled" : "DISABLED"}`);
});
