import fs from "fs/promises";
import path from "path";
import { PROCESS_API_URL, STATE_DIR } from "../config.js";
import type { Concept, Entity } from "../storage/store.js";

async function loadAuthHeaders(): Promise<Record<string, string>> {
  try {
    const auth = JSON.parse(await fs.readFile(path.join(STATE_DIR, "x-auth.json"), "utf8"));
    if (auth.apiKey && auth.userId) {
      return { "Authorization": `Bearer ${auth.apiKey}`, "X-User-Id": auth.userId };
    }
  } catch {}
  return {};
}

export interface ExtractResult {
  title: string;
  articleContent: string;
  sourceUrl: string;
  tags: string[];
  concepts: Concept[];
  entities: Entity[];
}

function parseExtractResponse(text: string): ExtractResult {
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  const parsed = JSON.parse(cleaned) as ExtractResult;
  return {
    title: parsed.title || "Untitled",
    articleContent: parsed.articleContent || "",
    sourceUrl: parsed.sourceUrl || "",
    tags: (parsed.tags || []).map((t) => t.toLowerCase().trim()).filter(Boolean),
    concepts: parsed.concepts || [],
    entities: parsed.entities || [],
  };
}

export async function processBookmark(text: string): Promise<ExtractResult> {
  const authHeaders = await loadAuthHeaders();
  const res = await fetch(`${PROCESS_API_URL}/api/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ type: "bookmark", text }),
  });
  if (!res.ok) {
    throw new Error(`Processing failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ExtractResult;
}
