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
  summary: string;
  useCase: string;
  tags: string[];
  concepts: Concept[];
  entities: Entity[];
}

// ----- Helpers -----

const PENDING_FILE = path.join(STATE_DIR, "pending.json");
const SEEN_FILE = path.join(STATE_DIR, "seen.json");

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

// ----- Seen set (dedup by tweet ID) -----

async function loadSeen(): Promise<Set<string>> {
  const arr = await readJsonSafe<string[]>(SEEN_FILE);
  return new Set(arr || []);
}

async function saveSeen(seen: Set<string>): Promise<void> {
  await writeJson(SEEN_FILE, [...seen]);
}

// ----- Pending queue -----

async function loadPending(): Promise<PendingItem[]> {
  return (await readJsonSafe<PendingItem[]>(PENDING_FILE)) || [];
}

async function savePending(items: PendingItem[]): Promise<void> {
  await writeJson(PENDING_FILE, items);
}

// ----- Public: ingest -----

export async function ingestItem(opts: {
  sourceId: string;
  text: string;
  author: string | null;
  url: string | null;
  createdAt: string;
}): Promise<PendingItem | null> {
  // Dedup by tweet ID
  const seen = await loadSeen();
  if (seen.has(opts.sourceId)) return null;

  seen.add(opts.sourceId);
  await saveSeen(seen);

  const item: PendingItem = {
    sourceId: opts.sourceId,
    text: opts.text,
    author: opts.author,
    url: opts.url,
    createdAt: opts.createdAt,
  };

  const pending = await loadPending();
  pending.push(item);
  await savePending(pending);

  return item;
}

// ----- Public: processing -----

export async function getUnprocessedItems(): Promise<PendingItem[]> {
  return loadPending();
}

export async function saveProcessedItem(
  pending: PendingItem,
  result: ProcessedResult,
): Promise<void> {
  const month = monthKey(pending.createdAt);
  const monthDir = path.join(BOOKMARKS_DIR, month);
  await fs.mkdir(monthDir, { recursive: true });

  const slug = slugify(result.title) || "bookmark";
  const shortId = pending.sourceId.slice(-6);
  const filename = `${slug}-${shortId}.md`;

  await fs.writeFile(
    path.join(monthDir, filename),
    renderMarkdown(pending, result),
    "utf8",
  );

  // Remove from pending queue
  const items = await loadPending();
  await savePending(items.filter((i) => i.sourceId !== pending.sourceId));

  // Update indexes
  await rebuildIndexes();
}

export async function markItemError(pending: PendingItem, error: string): Promise<void> {
  console.error(`[store] error processing ${pending.sourceId}: ${error}`);

  // Remove from seen so it can be retried on next poll
  const seen = await loadSeen();
  seen.delete(pending.sourceId);
  await saveSeen(seen);

  // Remove from pending
  const items = await loadPending();
  await savePending(items.filter((i) => i.sourceId !== pending.sourceId));
}

// ----- Markdown rendering -----

function renderMarkdown(pending: PendingItem, result: ProcessedResult): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(`title: ${JSON.stringify(result.title)}`);
  lines.push(`date: ${pending.createdAt.split("T")[0]}`);
  if (pending.author) lines.push(`author: ${JSON.stringify(pending.author)}`);
  if (pending.url) lines.push(`url: ${JSON.stringify(pending.url)}`);
  if (result.tags.length) lines.push(`tags: [${result.tags.join(", ")}]`);
  lines.push("---");
  lines.push("");

  lines.push(`# ${result.title}`);
  lines.push("");

  if (pending.text) {
    for (const line of pending.text.split("\n")) {
      lines.push(`> ${line}`);
    }
    lines.push("");
  }

  if (result.summary) {
    lines.push(result.summary);
    lines.push("");
  }

  if (result.useCase) {
    lines.push(`**Apply when:** ${result.useCase}`);
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
  summary: string;
  useCase: string;
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

function parseSummaryFromBody(content: string): string {
  const afterFm = content.replace(/^---[\s\S]*?---\n*/, "");
  const lines = afterFm.split("\n");
  let pastTitle = false;
  let pastQuote = false;
  for (const line of lines) {
    if (line.startsWith("# ")) { pastTitle = true; continue; }
    if (!pastTitle) continue;
    if (line.startsWith("> ")) { pastQuote = true; continue; }
    if (!pastQuote) continue;
    if (line.trim() === "") continue;
    if (line.startsWith("**") || line.startsWith("## ")) break;
    return line.trim();
  }
  return "";
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
        summary: parseSummaryFromBody(content),
        useCase: "",
        file: `${month}/${file}`,
      };
      const ucMatch = content.match(/\*\*Apply when:\*\* (.+)/);
      if (ucMatch) entry.useCase = ucMatch[1]!;
      entries.push(entry);
    }
  }

  return entries;
}

function formatIndexLine(e: IndexEntry): string {
  const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
  const author = e.author ? ` by ${e.author}` : "";
  const useCase = e.useCase ? `\n  Apply when: ${e.useCase}` : "";
  return `${e.file}${author} — ${e.title}${tags}\n  ${e.summary}${useCase}`;
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
