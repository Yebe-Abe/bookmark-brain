import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "../config.js";
import { requireAuth, rateLimit } from "../auth/middleware.js";

const router = Router();

// Auth required + rate limit: 30 processing requests per minute per IP
router.use(requireAuth);
router.use(rateLimit(60_000, 30));

const EXTRACT_PROMPT = `Analyze this content and extract structured knowledge.

Return JSON only, no markdown fencing:
{
  "title": "Short descriptive title (< 10 words)",
  "summary": "1-2 sentence summary of the key insight or information",
  "tags": ["tag1", "tag2"],
  "concepts": [
    {"name": "concept name", "category": "ml_concept|tool|technique|pattern|other", "confidence": 0.9}
  ],
  "entities": [
    {"name": "Entity Name", "type": "person|tool|company|paper|repo", "handle": "@handle or null"}
  ]
}

Rules:
- 3-7 lowercase tags, use underscores for multi-word (e.g. "transformer_architecture" not "ai")
- Be specific with tags — prefer precise technical terms
- Only include entities you're confident about
- For screenshots, extract any visible text, code, or key information into the summary`;

const MAX_TEXT_LENGTH = 10_000;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB base64

/**
 * POST /api/process
 * Requires: Authorization: Bearer bbk_<key> + X-User-Id header
 */
router.post("/", async (req: Request, res: Response) => {
  const { type, text, imageBase64, imageMimeType } = req.body as {
    type?: string;
    text?: string;
    imageBase64?: string;
    imageMimeType?: string;
  };

  if (!type || (type !== "bookmark" && type !== "screenshot")) {
    res.status(400).json({ error: "type must be 'bookmark' or 'screenshot'" });
    return;
  }

  // Input validation
  if (type === "bookmark") {
    if (!text) { res.status(400).json({ error: "text required for bookmarks" }); return; }
    if (text.length > MAX_TEXT_LENGTH) { res.status(400).json({ error: `text exceeds ${MAX_TEXT_LENGTH} chars` }); return; }
  } else {
    if (!imageBase64) { res.status(400).json({ error: "imageBase64 required for screenshots" }); return; }
    if (imageBase64.length > MAX_IMAGE_SIZE) { res.status(400).json({ error: "image too large (max 5MB)" }); return; }
    const validMime = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    if (imageMimeType && !validMime.includes(imageMimeType)) {
      res.status(400).json({ error: "invalid imageMimeType" });
      return;
    }
  }

  try {
    if (!ANTHROPIC_API_KEY) { res.status(500).json({ error: "Processing not configured" }); return; }
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    let response: Anthropic.Message;

    if (type === "bookmark") {
      response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: `${EXTRACT_PROMPT}\n\nContent to analyze:\n${text}` }],
      });
    } else {
      response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: (imageMimeType || "image/png") as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: imageBase64! } },
            { type: "text", text: `${EXTRACT_PROMPT}\n\nAlso include a "rawText" field with any text visible in the screenshot.` },
          ],
        }],
      });
    }

    const responseText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text).join("");

    const cleaned = responseText.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    res.json(JSON.parse(cleaned));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[process] error:", msg);
    res.status(500).json({ error: "Processing failed" });
  }
});

export default router;
