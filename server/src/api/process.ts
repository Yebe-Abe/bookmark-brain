import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "../config.js";

const router = Router();

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

function getClient(): Anthropic {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured on server");
  }
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

/**
 * POST /api/process
 * Body: { type: "bookmark" | "screenshot", text?: string, imageBase64?: string, imageMimeType?: string }
 * Returns: { title, summary, tags, concepts, entities, rawText? }
 */
router.post("/", async (req: Request, res: Response) => {
  const { type, text, imageBase64, imageMimeType } = req.body as {
    type: "bookmark" | "screenshot";
    text?: string;
    imageBase64?: string;
    imageMimeType?: string;
  };

  if (!type) {
    res.status(400).json({ error: "type required (bookmark or screenshot)" });
    return;
  }

  try {
    const client = getClient();
    let response: Anthropic.Message;

    if (type === "bookmark") {
      if (!text) {
        res.status(400).json({ error: "text required for bookmark processing" });
        return;
      }
      response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: `${EXTRACT_PROMPT}\n\nContent to analyze:\n${text}`,
        }],
      });
    } else {
      if (!imageBase64) {
        res.status(400).json({ error: "imageBase64 required for screenshot processing" });
        return;
      }
      response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: (imageMimeType || "image/png") as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
                data: imageBase64,
              },
            },
            {
              type: "text",
              text: `${EXTRACT_PROMPT}\n\nAlso include a "rawText" field with any text visible in the screenshot.`,
            },
          ],
        }],
      });
    }

    const responseText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Parse and forward the result
    const cleaned = responseText.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    const parsed = JSON.parse(cleaned);
    res.json(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[process] error:", message);
    res.status(500).json({ error: message });
  }
});

export default router;
