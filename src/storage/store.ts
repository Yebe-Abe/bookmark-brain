import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { DATA_ROOT, ITEMS_DIR, TAGS_DIR } from "../config.js";

// ----- Types -----

export interface KnowledgeItem {
  id: string;
  source: "x_bookmark";
  sourceId: string;
  contentHash: string;

  // Processed fields (filled after Claude processing)
  title: string;
  summary: string;
  useCase: string;
  tags: string[];
  concepts: Concept[];
  entities: Entity[];
  rawText: string | null;

  // Source metadata
  author: string | null;
  url: string | null;

  // Timestamps
  createdAt: string;
  ingestedAt: string;
  processedAt: string | null;
  status: "ingested" | "processing" | "processed" | "error";
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

// ----- Helpers -----

function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function itemDirName(hash: string): string {
  return `bk-${hash.slice(0, 12)}`;
}

export function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function readTextSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

// ----- Write operations -----

/**
 * Ingest a new item. Writes raw content + initial meta.json with status="ingested".
 * Returns the item if new, null if duplicate.
 */
export async function ingestItem(opts: {
  source: "x_bookmark";
  sourceId: string;
  rawContent: string;
  author?: string;
  url?: string;
  createdAt?: string;
}): Promise<KnowledgeItem | null> {
  const hash = contentHash(opts.rawContent);
  const dirName = itemDirName(hash);
  const month = monthKey(opts.createdAt || new Date().toISOString());
  const itemDir = path.join(ITEMS_DIR, month, dirName);

  // Dedup: if directory already exists, skip
  try {
    await fs.access(itemDir);
    return null; // already ingested
  } catch {
    // doesn't exist, proceed
  }

  await fs.mkdir(itemDir, { recursive: true });
  await fs.writeFile(path.join(itemDir, "raw.json"), opts.rawContent, "utf8");

  const item: KnowledgeItem = {
    id: dirName,
    source: opts.source,
    sourceId: opts.sourceId,
    contentHash: hash,
    title: "",
    summary: "",
    useCase: "",
    tags: [],
    concepts: [],
    entities: [],
    rawText: opts.rawContent,
    author: opts.author || null,
    url: opts.url || null,
    createdAt: opts.createdAt || new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    processedAt: null,
    status: "ingested",
  };

  await fs.writeFile(
    path.join(itemDir, "meta.json"),
    JSON.stringify(item, null, 2) + "\n",
    "utf8"
  );

  return item;
}

/**
 * Save processed results back to an item and update all indexes.
 */
export async function saveProcessedItem(item: KnowledgeItem): Promise<void> {
  const month = monthKey(item.createdAt);
  const itemDir = path.join(ITEMS_DIR, month, item.id);

  item.processedAt = new Date().toISOString();
  item.status = "processed";

  await fs.writeFile(
    path.join(itemDir, "meta.json"),
    JSON.stringify(item, null, 2) + "\n",
    "utf8"
  );

  // Write markdown file
  await fs.writeFile(
    path.join(itemDir, "bookmark.md"),
    renderMarkdown(item),
    "utf8"
  );

  // Update all indexes
  await updateMonthIndex(month);
  await updateTagIndexes(item);
  await updateMasterIndex();
}

/**
 * Mark an item as errored so it doesn't block the queue.
 */
export async function markItemError(item: KnowledgeItem, error: string): Promise<void> {
  const month = monthKey(item.createdAt);
  const itemDir = path.join(ITEMS_DIR, month, item.id);
  item.status = "error";
  (item as KnowledgeItem & { error?: string }).error = error;
  await fs.writeFile(
    path.join(itemDir, "meta.json"),
    JSON.stringify(item, null, 2) + "\n",
    "utf8"
  );
}

// ----- Markdown rendering -----

function renderMarkdown(item: KnowledgeItem): string {
  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`title: ${JSON.stringify(item.title)}`);
  lines.push(`date: ${item.createdAt.split("T")[0]}`);
  if (item.author) lines.push(`author: ${JSON.stringify(item.author)}`);
  if (item.url) lines.push(`url: ${JSON.stringify(item.url)}`);
  if (item.tags.length) lines.push(`tags: [${item.tags.join(", ")}]`);
  lines.push("---");
  lines.push("");

  // Title
  lines.push(`# ${item.title}`);
  lines.push("");

  // Original tweet as blockquote
  if (item.rawText) {
    for (const line of item.rawText.split("\n")) {
      lines.push(`> ${line}`);
    }
    lines.push("");
  }

  // Summary
  if (item.summary) {
    lines.push(item.summary);
    lines.push("");
  }

  // Use case
  if (item.useCase) {
    lines.push(`**Apply when:** ${item.useCase}`);
    lines.push("");
  }

  // Concepts
  if (item.concepts.length) {
    lines.push("## Concepts");
    for (const c of item.concepts) {
      lines.push(`- ${c.name} (${c.category})`);
    }
    lines.push("");
  }

  // Entities
  if (item.entities.length) {
    lines.push("## Entities");
    for (const e of item.entities) {
      const handle = e.handle ? ` ${e.handle}` : "";
      lines.push(`- ${e.name}${handle} (${e.type})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ----- Index generation -----

async function updateMonthIndex(month: string): Promise<void> {
  const monthDir = path.join(ITEMS_DIR, month);
  const items = await loadItemsInDir(monthDir);

  const lines = items
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item) => formatIndexLine(item));

  await fs.writeFile(
    path.join(monthDir, "index.txt"),
    lines.join("\n") + "\n",
    "utf8"
  );
}

async function updateTagIndexes(item: KnowledgeItem): Promise<void> {
  await fs.mkdir(TAGS_DIR, { recursive: true });

  for (const tag of item.tags) {
    const tagFile = path.join(TAGS_DIR, `${sanitizeFilename(tag)}.txt`);
    const existing = await readTextSafe(tagFile);

    if (existing.includes(item.id)) continue;

    const line = formatIndexLine(item);
    await fs.appendFile(tagFile, line + "\n", "utf8");
  }

  await rebuildTagIndex();
}

async function rebuildTagIndex(): Promise<void> {
  await fs.mkdir(TAGS_DIR, { recursive: true });
  const entries = await fs.readdir(TAGS_DIR);
  const tagCounts: [string, number][] = [];

  for (const entry of entries) {
    if (entry === "index.txt" || !entry.endsWith(".txt")) continue;
    const tag = entry.replace(".txt", "");
    const content = await readTextSafe(path.join(TAGS_DIR, entry));
    const count = content.trim().split("\n").filter(Boolean).length;
    tagCounts.push([tag, count]);
  }

  tagCounts.sort((a, b) => b[1] - a[1]);
  const lines = tagCounts.map(([tag, count]) => `${tag} (${count})`);
  await fs.writeFile(
    path.join(TAGS_DIR, "index.txt"),
    lines.join("\n") + "\n",
    "utf8"
  );
}

async function updateMasterIndex(): Promise<void> {
  const allItems = await loadAllProcessedItems();
  const recent = allItems
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50);

  const lines = recent.map((item) => formatIndexLine(item));
  await fs.mkdir(DATA_ROOT, { recursive: true });
  await fs.writeFile(
    path.join(DATA_ROOT, "index.txt"),
    lines.join("\n") + "\n",
    "utf8"
  );
}

// ----- Read operations -----

export async function getUnprocessedItems(): Promise<KnowledgeItem[]> {
  const allItems = await loadAllItems();
  return allItems.filter((item) => item.status === "ingested");
}

// ----- Internal helpers -----

function formatIndexLine(item: KnowledgeItem): string {
  const tags = item.tags.length > 0 ? ` [${item.tags.join(", ")}]` : "";
  const author = item.author ? ` by ${item.author}` : "";
  const useCase = item.useCase ? `\n  Apply when: ${item.useCase}` : "";
  return `[${item.id}] (bookmark${author}) ${item.title || "(unprocessed)"}${tags}\n  ${item.summary || item.rawText?.slice(0, 120) || ""}${useCase}`;
}

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

async function listMonthDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(ITEMS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map((e) => path.join(ITEMS_DIR, e.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

async function loadItemsInDir(dir: string): Promise<KnowledgeItem[]> {
  const items: KnowledgeItem[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readJsonSafe<KnowledgeItem>(
        path.join(dir, entry.name, "meta.json")
      );
      if (meta) items.push(meta);
    }
  } catch {
    // directory doesn't exist yet
  }
  return items;
}

async function loadAllItems(): Promise<KnowledgeItem[]> {
  const monthDirs = await listMonthDirs();
  const results = await Promise.all(monthDirs.map(loadItemsInDir));
  return results.flat();
}

async function loadAllProcessedItems(): Promise<KnowledgeItem[]> {
  const all = await loadAllItems();
  return all.filter((item) => item.status === "processed");
}
