// Read-only MCP peephole. Only reads from DATA_ROOT. No writes. No path traversal.
// This is the only thing exposed via the tunnel — audit it in 5 minutes.

import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// Hardcoded root. This server cannot read anything outside this directory.
const DATA_ROOT = process.env.BOOKMARK_BRAIN_ROOT || path.join(process.env.HOME || "/tmp", ".bookmark-brain");
const PORT = Number(process.env.MCP_PORT || 9876);

// --- Safe read helpers (all paths validated against DATA_ROOT) ---

function safePath(untrusted: string): string {
  const resolved = path.resolve(DATA_ROOT, untrusted);
  if (!resolved.startsWith(DATA_ROOT + path.sep) && resolved !== DATA_ROOT) {
    throw new Error("Path outside data root");
  }
  return resolved;
}

async function readText(relativePath: string): Promise<string> {
  try { return await fs.readFile(safePath(relativePath), "utf8"); }
  catch { return ""; }
}

async function readJson(relativePath: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(safePath(relativePath), "utf8")); }
  catch { return null; }
}

async function readImage(relativePath: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const full = safePath(relativePath);
    const buf = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    return { data: buf.toString("base64"), mimeType };
  } catch { return null; }
}

async function listDirs(relativePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(safePath(relativePath), { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch { return []; }
}

async function listFiles(relativePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(safePath(relativePath), { withFileTypes: true });
    return entries.filter(e => e.isFile()).map(e => e.name).sort();
  } catch { return []; }
}

// --- MCP tools (read-only) ---

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolResult = { content: (TextContent | ImageContent)[]; isError?: boolean };

function text(t: string): ToolResult { return { content: [{ type: "text", text: t }] }; }

function createMcpServer(): McpServer {
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
    // ID must be bk-* or ss-* with only hex chars
    if (!/^(bk|ss)-[a-f0-9]{12}$/.test(id)) return { ...text(`Invalid item ID "${id}".`), isError: true };

    // Find which month directory contains this item
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

    // Include extracted text for screenshots
    const extracted = await readText(`items/${monthDir}/${id}/extracted.txt`);
    if (extracted.trim()) parts.push({ type: "text", text: `## Extracted Text\n${extracted}` });

    // Include image if it exists
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

  return server;
}

// --- HTTP server (minimal, read-only routes) ---

const sessions: Record<string, { server: McpServer; transport: StreamableHTTPServerTransport }> = {};

export function startMcpServer(): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Accept");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.url === "/health") { json(200, { ok: true }); return; }

    if (req.url !== "/mcp") { json(404, { error: "Not found" }); return; }

    try {
      const sessionId = String(req.headers["mcp-session-id"] || "").trim();
      const existing = sessionId ? sessions[sessionId] : undefined;

      if (req.method === "GET" || req.method === "DELETE") {
        if (!existing) { json(400, { error: "No session" }); return; }
        await existing.transport.handleRequest(req, res);
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (existing) { await existing.transport.handleRequest(req, res, body); return; }

      if (body?.method !== "initialize") { json(400, { error: "Send initialize first" }); return; }

      let mcpServer!: McpServer;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => { sessions[id] = { server: mcpServer, transport }; },
      });
      mcpServer = createMcpServer();
      transport.onclose = () => { if (transport.sessionId) delete sessions[transport.sessionId]; void mcpServer.close(); };
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      json(500, { error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.log(`[mcp] read-only peephole on http://127.0.0.1:${PORT}/mcp`);
    console.log(`[mcp] data root: ${DATA_ROOT}`);
  });

  return httpServer;
}
