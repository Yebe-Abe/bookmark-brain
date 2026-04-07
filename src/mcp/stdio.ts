#!/usr/bin/env node

// Stdio MCP server for Claude Desktop.
// Claude Desktop spawns this process directly — no HTTP, no tunnel needed.
// Same read-only tools as the HTTP peephole, same filesystem, same security.

import fs from "fs/promises";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DATA_ROOT = process.env.BOOKMARK_BRAIN_ROOT || path.join(process.env.HOME || "/tmp", ".bookmark-brain");

// --- Safe read helpers (identical to HTTP peephole) ---

function safePath(untrusted: string): string {
  const resolved = path.resolve(DATA_ROOT, untrusted);
  if (!resolved.startsWith(DATA_ROOT + path.sep) && resolved !== DATA_ROOT) {
    throw new Error("Path outside data root");
  }
  return resolved;
}

async function readText(rel: string): Promise<string> {
  try { return await fs.readFile(safePath(rel), "utf8"); } catch { return ""; }
}

async function readJson(rel: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(safePath(rel), "utf8")); } catch { return null; }
}

async function readImage(rel: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const full = safePath(rel);
    const buf = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    return { data: buf.toString("base64"), mimeType };
  } catch { return null; }
}

async function listDirs(rel: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(safePath(rel), { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch { return []; }
}

async function listFiles(rel: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(safePath(rel), { withFileTypes: true });
    return entries.filter(e => e.isFile()).map(e => e.name).sort();
  } catch { return []; }
}

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolResult = { content: (TextContent | ImageContent)[]; isError?: boolean };
function text(t: string): ToolResult { return { content: [{ type: "text", text: t }] }; }

// --- Server ---

const server = new McpServer(
  { name: "bookmark-brain", version: "0.1.0" },
  { instructions: "Read-only knowledge base of the user's X bookmarks and screenshots. Start with list_recent, then drill into tags or specific items." }
);

server.registerTool("list_recent", {
  description: "List recently saved bookmarks and screenshots with titles, tags, and source info.",
  inputSchema: {},
}, async () => text((await readText("index.txt")).trim() || "No items saved yet."));

server.registerTool("list_tags", {
  description: "List all tags with item counts.",
  inputSchema: {},
}, async () => text((await readText("tags/index.txt")).trim() || "No tags yet."));

server.registerTool("get_by_tag", {
  description: "Get all items with a specific tag.",
  inputSchema: { tag: z.string().describe("Tag to filter by") },
}, async ({ tag }) => {
  const safe = tag.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const items = (await readText(`tags/${safe}.txt`)).trim();
  return text(items || `No items with tag "${tag}".`);
});

server.registerTool("get_item", {
  description: "Get full details for a specific item by ID. Returns metadata, extracted text, and screenshot image if available.",
  inputSchema: { id: z.string().describe("Item ID from an index listing (e.g. bk-a1b2c3d4e5f6)") },
}, async ({ id }): Promise<ToolResult> => {
  if (!/^(bk|ss)-[a-f0-9]{12}$/.test(id)) return { ...text(`Invalid item ID "${id}".`), isError: true };

  const months = await listDirs("items");
  let meta: Record<string, unknown> | null = null;
  let monthDir = "";
  for (const m of months) {
    const candidate = await readJson(`items/${m}/${id}/meta.json`) as Record<string, unknown> | null;
    if (candidate) { meta = candidate; monthDir = m; break; }
  }
  if (!meta) return { ...text(`Item "${id}" not found.`), isError: true };

  const parts: (TextContent | ImageContent)[] = [];
  parts.push({ type: "text", text: JSON.stringify(meta, null, 2) });

  const extracted = await readText(`items/${monthDir}/${id}/extracted.txt`);
  if (extracted.trim()) parts.push({ type: "text", text: `## Extracted Text\n${extracted}` });

  const files = await listFiles(`items/${monthDir}/${id}`);
  const rawImage = files.find(f => f.startsWith("raw."));
  if (rawImage) {
    const img = await readImage(`items/${monthDir}/${id}/${rawImage}`);
    if (img) parts.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }

  return { content: parts };
});

server.registerTool("list_month", {
  description: "List items saved in a specific month, or list available months.",
  inputSchema: { month: z.string().optional().describe("YYYY-MM format, or omit to list months") },
}, async ({ month }) => {
  if (!month) {
    const months = await listDirs("items");
    return text(months.length ? `Available months:\n${months.reverse().join("\n")}` : "No items yet.");
  }
  if (!/^\d{4}-\d{2}$/.test(month)) return text("Invalid format. Use YYYY-MM.");
  return text((await readText(`items/${month}/index.txt`)).trim() || `No items for ${month}.`);
});

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
