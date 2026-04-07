import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { DATA_ROOT, ITEMS_DIR, TAGS_DIR } from "../config.js";

// ----- Types -----

export interface KnowledgeItem {
  id: string;
  source: "x_bookmark" | "screenshot";
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
  // "2026-04-06T..." -> "2026-04"
  return isoDate.slice(0, 7);
}

function itemDirName(source: "x_bookmark" | "screenshot", hash: string): string {
  const prefix = source === "x_bookmark" ? "bk" : "ss";
  return `${prefix}-${hash.slice(0, 12)}`;
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
  source: "x_bookmark" | "screenshot";
  sourceId: string;
  rawContent: string; // text for bookmarks, file path for screenshots
  author?: string;
  url?: string;
  createdAt?: string;
}): Promise<KnowledgeItem | null> {
  const hash = contentHash(opts.rawContent);
  const dirName = itemDirName(opts.source, hash);
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

  // Write raw content
  if (opts.source === "screenshot") {
    // rawContent is the path to the screenshot file — copy it
    const ext = path.extname(opts.rawContent) || ".png";
    await fs.copyFile(opts.rawContent, path.join(itemDir, `raw${ext}`));
  } else {
    await fs.writeFile(path.join(itemDir, "raw.json"), opts.rawContent, "utf8");
  }

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
    rawText: opts.source === "x_bookmark" ? opts.rawContent : null,
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
export async function saveProcessedItem(
  item: KnowledgeItem,
  extracted: { rawText?: string }
): Promise<void> {
  const month = monthKey(item.createdAt);
  const itemDir = path.join(ITEMS_DIR, month, item.id);

  item.processedAt = new Date().toISOString();
  item.status = "processed";

  await fs.writeFile(
    path.join(itemDir, "meta.json"),
    JSON.stringify(item, null, 2) + "\n",
    "utf8"
  );

  // Write extracted text for screenshots
  if (extracted.rawText) {
    await fs.writeFile(
      path.join(itemDir, "extracted.txt"),
      extracted.rawText,
      "utf8"
    );
  }

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

// ----- Index generation -----

/**
 * Rebuild a month's index.txt from all meta.json files in that month.
 */
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

/**
 * Rebuild a tag file with all items that have that tag.
 */
async function updateTagIndexes(item: KnowledgeItem): Promise<void> {
  await fs.mkdir(TAGS_DIR, { recursive: true });

  for (const tag of item.tags) {
    const tagFile = path.join(TAGS_DIR, `${sanitizeFilename(tag)}.txt`);
    const existing = await readTextSafe(tagFile);

    // Avoid duplicates: check if item ID already in file
    if (existing.includes(item.id)) continue;

    const line = formatIndexLine(item);
    await fs.appendFile(tagFile, line + "\n", "utf8");
  }

  // Rebuild tag index (tag → count)
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

/**
 * Rebuild master index.txt with the most recent processed items.
 */
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

/**
 * Find all items with status="ingested" (ready for processing).
 */
export async function getUnprocessedItems(): Promise<KnowledgeItem[]> {
  const allItems = await loadAllItems();
  return allItems.filter((item) => item.status === "ingested");
}

/**
 * Load a single item by its ID (e.g. "bk-a1b2c3d4e5f6").
 */
export async function getItem(itemId: string): Promise<{
  item: KnowledgeItem;
  rawContent: string | null;
  imagePath: string | null;
} | null> {
  const allMonths = await listMonthDirs();
  for (const monthDir of allMonths) {
    const itemDir = path.join(monthDir, itemId);
    const meta = await readJsonSafe<KnowledgeItem>(path.join(itemDir, "meta.json"));
    if (!meta) continue;

    let rawContent: string | null = null;
    let imagePath: string | null = null;

    if (meta.source === "x_bookmark") {
      rawContent = await readTextSafe(path.join(itemDir, "raw.json"));
    } else {
      // Find the raw image file
      const files = await fs.readdir(itemDir).catch(() => []);
      const rawFile = (files as string[]).find((f) => f.startsWith("raw."));
      if (rawFile) {
        imagePath = path.join(itemDir, rawFile);
      }
      rawContent = await readTextSafe(path.join(itemDir, "extracted.txt"));
    }

    return { item: meta, rawContent, imagePath };
  }
  return null;
}

/** Read the master index.txt */
export async function getMasterIndex(): Promise<string> {
  return readTextSafe(path.join(DATA_ROOT, "index.txt"));
}

/** Read a month's index.txt */
export async function getMonthIndex(month: string): Promise<string> {
  return readTextSafe(path.join(ITEMS_DIR, month, "index.txt"));
}

/** Read the tag index */
export async function getTagIndex(): Promise<string> {
  return readTextSafe(path.join(TAGS_DIR, "index.txt"));
}

/** Read a specific tag's items */
export async function getTagItems(tag: string): Promise<string> {
  return readTextSafe(path.join(TAGS_DIR, `${sanitizeFilename(tag)}.txt`));
}

/** List available months */
export async function listMonths(): Promise<string[]> {
  const dirs = await listMonthDirs();
  return dirs.map((d) => path.basename(d)).sort().reverse();
}

// ----- Internal helpers -----

function formatIndexLine(item: KnowledgeItem): string {
  const source = item.source === "x_bookmark" ? "bookmark" : "screenshot";
  const tags = item.tags.length > 0 ? ` [${item.tags.join(", ")}]` : "";
  const author = item.author ? ` by ${item.author}` : "";
  const useCase = item.useCase ? `\n  Apply when: ${item.useCase}` : "";
  return `[${item.id}] (${source}${author}) ${item.title || "(unprocessed)"}${tags}\n  ${item.summary || item.rawText?.slice(0, 120) || ""}${useCase}`;
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
