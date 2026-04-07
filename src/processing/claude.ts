import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import { PROCESS_API_URL, STATE_DIR } from "../config.js";
import type { KnowledgeItem, Concept, Entity } from "../storage/store.js";

async function loadAuthHeaders(): Promise<Record<string, string>> {
  try {
    const auth = JSON.parse(await fs.readFile(path.join(STATE_DIR, "x-auth.json"), "utf8"));
    if (auth.apiKey && auth.userId) {
      return { "Authorization": `Bearer ${auth.apiKey}`, "X-User-Id": auth.userId };
    }
  } catch {}
  return {};
}

const EXTRACT_PROMPT = `Analyze this content and extract structured knowledge.

Return JSON only, no markdown fencing:
{
  "title": "Short descriptive title (< 10 words)",
  "summary": "1-2 sentence summary of the key insight or information",
  "useCase": "When would someone apply this? What problem does it solve? What kind of project or situation makes this relevant? Be specific.",
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
- Only include entities you're confident about
- useCase is the most important field — think about WHEN this knowledge becomes actionable`;

export interface ExtractResult {
  title: string;
  summary: string;
  useCase: string;
  tags: string[];
  concepts: Concept[];
  entities: Entity[];
}

function parseExtractResponse(text: string): ExtractResult {
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  const parsed = JSON.parse(cleaned) as ExtractResult;
  return {
    title: parsed.title || "Untitled",
    summary: parsed.summary || "",
    useCase: parsed.useCase || "",
    tags: (parsed.tags || []).map((t) => t.toLowerCase().trim()).filter(Boolean),
    concepts: parsed.concepts || [],
    entities: parsed.entities || [],
  };
}

// --- Remote processing (calls your server instead of Claude directly) ---

async function processViaRemoteApi(payload: {
  type: "bookmark";
  text: string;
}): Promise<ExtractResult> {
  const authHeaders = await loadAuthHeaders();
  const res = await fetch(`${PROCESS_API_URL}/api/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
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

// --- Public API: automatically picks local vs remote ---

export async function processBookmark(item: KnowledgeItem): Promise<ExtractResult> {
  if (PROCESS_API_URL) {
    return processViaRemoteApi({ type: "bookmark", text: item.rawText || "" });
  }
  return processBookmarkLocal(item);
}
