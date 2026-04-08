import fs from "fs/promises";
import path from "path";
import { DATA_ROOT, BOOKMARKS_DIR, TAGS_DIR, STATE_DIR } from "../config.js";

// ----- Types -----

export interface PendingItem {
  sourceId: string;
  text: string;
  author: string | null;
  url: string | null;
  createdAt: string;
  expandedUrls: string[];
}

export interface Concept {
  name: string;
  category: string;
  confidence: number;
}

export interface Entity {
  name: string;
  type: "person" | "tool" | "company" | "paper" | "repo";
  handle?: string;
}

export interface ProcessedResult {
  title: string;
  articleContent: string;
  sourceUrl: string;
  tags: string[];
  concepts: Concept[];
  entities: Entity[];
}

// ----- In-memory state (loaded once, flushed on mutation) -----

const PENDING_FILE = path.join(STATE_DIR, "pending.json");
const SEEN_FILE = path.join(STATE_DIR, "seen.json");

let seen: Set<string> | null = null;
let pending: PendingItem[] | null = null;

async function load(): Promise<void> {
  if (seen !== null) return;
  seen = new Set((await readJsonSafe<string[]>(SEEN_FILE)) || []);
  pending = (await readJsonSafe<PendingItem[]>(PENDING_FILE)) || [];
}

async function flushSeen(): Promise<void> {
  await writeJson(SEEN_FILE, [...seen!]);
}

async function flushPending(): Promise<void> {
  await writeJson(PENDING_FILE, pending!);
}

// ----- Helpers -----

function slugify(text: string, maxLen = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen)
    .replace(/-$/, "");
}

function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n");
}

// ----- Public: ingest -----

export async function ingestItem(opts: {
  sourceId: string;
  text: string;
  author: string | null;
  url: string | null;
  createdAt: string;
  expandedUrls: string[];
}): Promise<PendingItem | null> {
  await load();

  if (seen!.has(opts.sourceId)) return null;

  // Mutate in memory (synchronous — no yield, no race)
  seen!.add(opts.sourceId);
  const item: PendingItem = {
    sourceId: opts.sourceId,
    text: opts.text,
    author: opts.author,
    url: opts.url,
    createdAt: opts.createdAt,
    expandedUrls: opts.expandedUrls || [],
  };
  pending!.push(item);

  // Flush to disk
  await flushSeen();
  await flushPending();

  return item;
}

// ----- Public: processing -----

export async function getUnprocessedItems(): Promise<PendingItem[]> {
  await load();
  return [...pending!];
}

export async function saveProcessedItem(
  item: PendingItem,
  result: ProcessedResult,
): Promise<void> {
  await load();

  const month = monthKey(item.createdAt);
  const monthDir = path.join(BOOKMARKS_DIR, month);
  await fs.mkdir(monthDir, { recursive: true });

  const slug = slugify(result.title) || "bookmark";
  const shortId = item.sourceId.slice(-6);
  const filename = `${slug}-${shortId}.md`;

  await fs.writeFile(
    path.join(monthDir, filename),
    renderMarkdown(item, result),
    "utf8",
  );

  // Remove from pending (in memory, synchronous)
  pending = pending!.filter((i) => i.sourceId !== item.sourceId);
  await flushPending();

  await rebuildIndexes();
}

export async function markItemError(item: PendingItem, error: string): Promise<void> {
  await load();
  console.error(`[store] error processing ${item.sourceId}: ${error}`);

  // Remove from seen so it retries, remove from pending (both synchronous)
  seen!.delete(item.sourceId);
  pending = pending!.filter((i) => i.sourceId !== item.sourceId);

  await flushSeen();
  await flushPending();
}

// ----- Markdown rendering -----

function renderMarkdown(item: PendingItem, result: ProcessedResult): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(`title: ${JSON.stringify(result.title)}`);
  lines.push(`date: ${item.createdAt.split("T")[0]}`);
  if (item.author) lines.push(`author: ${JSON.stringify(item.author)}`);
  if (item.url) lines.push(`url: ${JSON.stringify(item.url)}`);
  if (result.sourceUrl) lines.push(`source_url: ${JSON.stringify(result.sourceUrl)}`);
  if (result.tags.length) lines.push(`tags: [${result.tags.join(", ")}]`);
  lines.push("---");
  lines.push("");

  if (item.text) {
    for (const line of item.text.split("\n")) {
      lines.push(`> ${line}`);
    }
    lines.push("");
  }

  if (result.articleContent) {
    lines.push(result.articleContent);
    lines.push("");
  }

  if (result.concepts.length) {
    lines.push("## Concepts");
    for (const c of result.concepts) {
      lines.push(`- ${c.name} (${c.category})`);
    }
    lines.push("");
  }

  if (result.entities.length) {
    lines.push("## Entities");
    for (const e of result.entities) {
      const handle = e.handle ? ` ${e.handle}` : "";
      lines.push(`- ${e.name}${handle} (${e.type})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ----- Index generation -----

interface IndexEntry {
  title: string;
  date: string;
  author: string;
  tags: string[];
  sourceUrl: string;
  file: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return fm;
  for (const line of match[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return fm;
}

async function loadAllBookmarks(): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = [];
  let months: string[];
  try {
    const dirEntries = await fs.readdir(BOOKMARKS_DIR, { withFileTypes: true });
    months = dirEntries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }

  for (const month of months) {
    const monthDir = path.join(BOOKMARKS_DIR, month);
    const files = await fs.readdir(monthDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = await fs.readFile(path.join(monthDir, file), "utf8");
      const fm = parseFrontmatter(content);
      const tagsStr = fm.tags || "";
      const tags = tagsStr
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const entry: IndexEntry = {
        title: fm.title || file,
        date: fm.date || month,
        author: fm.author || "",
        tags,
        sourceUrl: fm.source_url || "",
        file: `${month}/${file}`,
      };
      entries.push(entry);
    }
  }

  return entries;
}

function formatIndexLine(e: IndexEntry): string {
  const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
  const author = e.author ? ` by ${e.author}` : "";
  const source = e.sourceUrl ? `\n  ${e.sourceUrl}` : "";
  return `${e.file}${author} — ${e.title}${tags}${source}`;
}

async function rebuildIndexes(): Promise<void> {
  const all = await loadAllBookmarks();

  // Master index (50 most recent)
  const recent = all
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 50);
  await fs.mkdir(DATA_ROOT, { recursive: true });
  await fs.writeFile(
    path.join(DATA_ROOT, "index.txt"),
    recent.map(formatIndexLine).join("\n") + "\n",
    "utf8",
  );

  // Tag indexes
  await fs.mkdir(TAGS_DIR, { recursive: true });
  const tagMap = new Map<string, IndexEntry[]>();
  for (const entry of all) {
    for (const tag of entry.tags) {
      const existing = tagMap.get(tag) || [];
      existing.push(entry);
      tagMap.set(tag, existing);
    }
  }

  // Clean old tag files then write fresh
  try {
    const oldFiles = await fs.readdir(TAGS_DIR);
    for (const f of oldFiles) {
      await fs.unlink(path.join(TAGS_DIR, f));
    }
  } catch {}

  for (const [tag, entries] of tagMap) {
    const lines = entries
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(formatIndexLine);
    await fs.writeFile(
      path.join(TAGS_DIR, `${slugify(tag)}.txt`),
      lines.join("\n") + "\n",
      "utf8",
    );
  }

  const tagCounts = [...tagMap.entries()]
    .map(([tag, entries]) => [tag, entries.length] as [string, number])
    .sort((a, b) => b[1] - a[1]);
  await fs.writeFile(
    path.join(TAGS_DIR, "index.txt"),
    tagCounts.map(([tag, count]) => `${tag} (${count})`).join("\n") + "\n",
    "utf8",
  );
}
