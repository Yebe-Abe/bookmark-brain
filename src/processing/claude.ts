import fs from "fs/promises";
import path from "path";
import { PROCESS_API_URL, STATE_DIR } from "../config.js";
import type { Concept, Entity } from "../storage/store.js";
import { getAccessToken } from "../ingestion/x-bookmarks.js";

interface AuthInfo {
  headers: Record<string, string>;
  xAccessToken: string;
}

async function loadAuth(): Promise<AuthInfo> {
  try {
    const auth = JSON.parse(await fs.readFile(path.join(STATE_DIR, "x-auth.json"), "utf8"));
    // Get a fresh (refreshed if needed) X access token
    const { token } = await getAccessToken();
    if (auth.apiKey && auth.userId) {
      return {
        headers: { "Authorization": `Bearer ${auth.apiKey}`, "X-User-Id": auth.userId },
        xAccessToken: token,
      };
    }
  } catch {}
  return { headers: {}, xAccessToken: "" };
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

export async function processBookmark(text: string, expandedUrls: string[] = []): Promise<ExtractResult> {
  const auth = await loadAuth();
  const res = await fetch(`${PROCESS_API_URL}/api/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth.headers },
    body: JSON.stringify({ type: "bookmark", text, expandedUrls, xAccessToken: auth.xAccessToken }),
  });
  if (!res.ok) {
    throw new Error(`Processing failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ExtractResult;
}
