import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "../config.js";
import { requireAuth, rateLimit } from "../auth/middleware.js";
import { extractFromUrls } from "./extract.js";

const router = Router();

// Auth required + rate limit: 30 processing requests per minute per IP
router.use(requireAuth);
router.use(rateLimit(60_000, 30));

const EXTRACT_PROMPT = `Analyze the following content (a tweet and optionally a linked article) and extract metadata only.

Return JSON only, no markdown fencing:
{
  "title": "Short descriptive title (< 10 words)",
  "tags": ["tag1", "tag2"],
  "concepts": [
    {"name": "concept name", "category": "ml_concept|tool|technique|pattern|architecture|workflow|other", "confidence": 0.9}
  ],
  "entities": [
    {"name": "Entity Name", "type": "person|tool|company|paper|repo", "handle": "@handle or null"}
  ]
}

Rules:
- 3-7 lowercase tags, use underscores for multi-word (e.g. "transformer_architecture" not "ai")
- Be specific with tags — prefer precise technical terms
- Only include entities you're confident about`;

const MAX_TEXT_LENGTH = 20_000;

/**
 * POST /api/process
 * Requires: Authorization: Bearer bbk_<key> + X-User-Id header
 */
router.post("/", async (req: Request, res: Response) => {
  const { type, text, expandedUrls, xAccessToken } = req.body as {
    type?: string;
    text?: string;
    expandedUrls?: string[];
    xAccessToken?: string;
  };

  if (type !== "bookmark") {
    res.status(400).json({ error: "type must be 'bookmark'" });
    return;
  }

  if (!text) { res.status(400).json({ error: "text required" }); return; }
  if (text.length > MAX_TEXT_LENGTH) { res.status(400).json({ error: `text exceeds ${MAX_TEXT_LENGTH} chars` }); return; }

  try {
    if (!ANTHROPIC_API_KEY) { res.status(500).json({ error: "Processing not configured" }); return; }

    // Extract content from any URLs in the tweet
    console.log(`[process] processing text (${text.length} chars), xAccessToken: ${xAccessToken ? "present" : "MISSING"}`);
    let extracted: { sourceUrl: string; text: string } | null = null;
    try {
      extracted = await extractFromUrls(expandedUrls || [], xAccessToken || "");
      if (extracted) {
        console.log(`[process] extracted ${extracted.text.length} chars from ${extracted.sourceUrl}`);
      } else {
        console.log(`[process] no content extracted from URLs`);
      }
    } catch (err) {
      console.error("[process] URL extraction failed:", (err as Error).message);
    }

    // Build the content for Claude
    let contentForClaude = `Tweet:\n${text}`;
    if (extracted) {
      contentForClaude += `\n\nLinked article (from ${extracted.sourceUrl}):\n${extracted.text}`;
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [{ role: "user", content: `${EXTRACT_PROMPT}\n\n${contentForClaude}` }],
    });

    const responseText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text).join("");

    const cleaned = responseText.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    const parsed = JSON.parse(cleaned);

    // Pass through the raw extracted article content and source URL
    parsed.articleContent = extracted ? extracted.text : "";
    parsed.sourceUrl = extracted ? extracted.sourceUrl : "";

    res.json(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[process] error:", msg);
    res.status(500).json({ error: "Processing failed" });
  }
});

export default router;
