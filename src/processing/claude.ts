import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import { PROCESS_API_URL } from "../config.js";
import type { KnowledgeItem, Concept, Entity } from "../storage/store.js";

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

export interface ExtractResult {
  title: string;
  summary: string;
  tags: string[];
  concepts: Concept[];
  entities: Entity[];
  rawText?: string;
}

function parseExtractResponse(text: string): ExtractResult {
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  const parsed = JSON.parse(cleaned) as ExtractResult;
  return {
    title: parsed.title || "Untitled",
    summary: parsed.summary || "",
    tags: (parsed.tags || []).map((t) => t.toLowerCase().trim()).filter(Boolean),
    concepts: parsed.concepts || [],
    entities: parsed.entities || [],
    rawText: parsed.rawText,
  };
}

// --- Remote processing (calls your server instead of Claude directly) ---

async function processViaRemoteApi(payload: {
  type: "bookmark" | "screenshot";
  text?: string;
  imageBase64?: string;
  imageMimeType?: string;
}): Promise<ExtractResult> {
  const res = await fetch(`${PROCESS_API_URL}/api/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Remote processing failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ExtractResult;
}

// --- Local processing (calls Claude API directly) ---

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set. Set it in your environment or .env file.");
  }
  return new Anthropic({ apiKey });
}

async function processBookmarkLocal(item: KnowledgeItem): Promise<ExtractResult> {
  const client = getClient();
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `${EXTRACT_PROMPT}\n\nContent to analyze:\n${item.rawText}`,
    }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  return parseExtractResponse(text);
}

async function processScreenshotLocal(imagePath: string): Promise<ExtractResult> {
  const client = getClient();
  const imageData = await fs.readFile(imagePath);
  const base64 = imageData.toString("base64");
  const ext = imagePath.split(".").pop()?.toLowerCase() || "png";
  const mediaType =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp"
        : ext === "gif" ? "image/gif"
          : "image/png";

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: `${EXTRACT_PROMPT}\n\nAlso include a "rawText" field with any text visible in the screenshot.` },
      ],
    }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  return parseExtractResponse(text);
}

// --- Public API: automatically picks local vs remote ---

export async function processBookmark(item: KnowledgeItem): Promise<ExtractResult> {
  if (PROCESS_API_URL) {
    return processViaRemoteApi({ type: "bookmark", text: item.rawText || "" });
  }
  return processBookmarkLocal(item);
}

export async function processScreenshot(item: KnowledgeItem, imagePath: string): Promise<ExtractResult> {
  if (PROCESS_API_URL) {
    const imageData = await fs.readFile(imagePath);
    const ext = imagePath.split(".").pop()?.toLowerCase() || "png";
    return processViaRemoteApi({
      type: "screenshot",
      imageBase64: imageData.toString("base64"),
      imageMimeType: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`,
    });
  }
  return processScreenshotLocal(imagePath);
}
