import { randomUUID } from "crypto";
import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MCP_PORT } from "../config.js";
import {
  getMasterIndex,
  getMonthIndex,
  getTagIndex,
  getTagItems,
  getItem,
  listMonths,
} from "../storage/store.js";

const INSTRUCTIONS = `The user saves X/Twitter bookmarks and screenshots into a personal knowledge base. Use these tools to find and retrieve their saved knowledge.

How to search effectively:
1. Start with list_recent to see what's been saved lately
2. Use list_tags to discover topics, then get_by_tag to drill into one
3. Use get_item to see full details on a specific item
4. Use list_month to browse a specific month

The user's bookmarks tend to be technical content — papers, tools, code, architecture discussions. Screenshots may contain code snippets, conversations, diagrams, or articles.

When referencing items, cite the source naturally: "From a tweet by @handle you bookmarked..." or "In a screenshot you saved..."`;

// Active MCP sessions keyed by session ID
const sessions: Record<string, { server: McpServer; transport: StreamableHTTPServerTransport }> = {};

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "bookmark-brain", version: "0.1.0" },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool(
    "list_recent",
    {
      description:
        "List recently saved bookmarks and screenshots. Call this first to see what the user has been saving. Returns titles, tags, and source info.",
      inputSchema: {},
    },
    async () => {
      const index = await getMasterIndex();
      if (!index.trim()) {
        return { content: [{ type: "text", text: "No items saved yet." }] };
      }
      return { content: [{ type: "text", text: index }] };
    }
  );

  server.registerTool(
    "list_tags",
    {
      description:
        "List all tags with item counts. Use this to discover what topics the user has been saving content about.",
      inputSchema: {},
    },
    async () => {
      const index = await getTagIndex();
      if (!index.trim()) {
        return { content: [{ type: "text", text: "No tags yet." }] };
      }
      return { content: [{ type: "text", text: index }] };
    }
  );

  server.registerTool(
    "get_by_tag",
    {
      description:
        "Get all items with a specific tag. Use after list_tags to drill into a topic.",
      inputSchema: {
        tag: z.string().describe("The tag to filter by (e.g. 'llm', 'rust', 'architecture')"),
      },
    },
    async ({ tag }) => {
      const items = await getTagItems(tag);
      if (!items.trim()) {
        return { content: [{ type: "text", text: `No items found with tag "${tag}".` }] };
      }
      return { content: [{ type: "text", text: items }] };
    }
  );

  server.registerTool(
    "get_item",
    {
      description:
        "Get full details for a specific item by ID (e.g. 'bk-a1b2c3d4e5f6' or 'ss-d4e5f6a1b2c3'). Returns the complete metadata, extracted text, and for screenshots the image.",
      inputSchema: {
        id: z.string().describe("The item ID from an index listing"),
      },
    },
    async ({ id }) => {
      const result = await getItem(id);
      if (!result) {
        return { content: [{ type: "text", text: `Item "${id}" not found.` }], isError: true };
      }

      const { item, rawContent, imagePath } = result;
      const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      parts.push({
        type: "text",
        text: [
          `# ${item.title || "Untitled"}`,
          `Source: ${item.source === "x_bookmark" ? "X Bookmark" : "Screenshot"}`,
          item.author ? `Author: ${item.author}` : null,
          item.url ? `URL: ${item.url}` : null,
          `Tags: ${item.tags.join(", ") || "none"}`,
          `Created: ${item.createdAt}`,
          "",
          `## Summary`,
          item.summary,
          "",
          item.concepts.length > 0
            ? `## Concepts\n${item.concepts.map((c) => `- ${c.name} (${c.category}, ${Math.round(c.confidence * 100)}%)`).join("\n")}`
            : null,
          item.entities.length > 0
            ? `## Entities\n${item.entities.map((e) => `- ${e.name} (${e.type}${e.handle ? `, ${e.handle}` : ""})`).join("\n")}`
            : null,
          rawContent ? `\n## Raw Content\n${rawContent}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      });

      if (imagePath) {
        try {
          const fs = await import("fs/promises");
          const imageData = await fs.readFile(imagePath);
          const ext = imagePath.split(".").pop()?.toLowerCase() || "png";
          const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
          parts.push({ type: "image", data: imageData.toString("base64"), mimeType });
        } catch {
          // image file missing, skip
        }
      }

      return { content: parts };
    }
  );

  server.registerTool(
    "list_month",
    {
      description:
        "List all items saved in a specific month. Use to browse by time period.",
      inputSchema: {
        month: z.string().optional().describe("Month in YYYY-MM format. Omit to list available months."),
      },
    },
    async ({ month }) => {
      if (!month) {
        const months = await listMonths();
        if (months.length === 0) {
          return { content: [{ type: "text", text: "No items saved yet." }] };
        }
        return { content: [{ type: "text", text: `Available months:\n${months.join("\n")}` }] };
      }

      const index = await getMonthIndex(month);
      if (!index.trim()) {
        return { content: [{ type: "text", text: `No items found for month "${month}".` }] };
      }
      return { content: [{ type: "text", text: index }] };
    }
  );

  return server;
}

// --- HTTP handling ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const sessionId = String(req.headers["mcp-session-id"] || "").trim();
  const existing = sessionId ? sessions[sessionId] : undefined;

  // GET/DELETE on existing session
  if (req.method === "GET" || req.method === "DELETE") {
    if (!existing) {
      sendJson(res, 400, { error: "Invalid or missing session ID." });
      return;
    }
    await existing.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // Parse body for POST
  const rawBody = await readBody(req);
  const body = JSON.parse(rawBody);

  // Existing session
  if (existing) {
    await existing.transport.handleRequest(req, res, body);
    return;
  }

  // New session — must be initialize
  if (sessionId || body?.method !== "initialize") {
    sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "No valid session. Send initialize first." }, id: null });
    return;
  }

  let mcpServer!: McpServer;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (newId) => {
      sessions[newId] = { server: mcpServer, transport };
    },
  });

  mcpServer = createMcpServer();
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) delete sessions[id];
    void mcpServer.close();
  };

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

/**
 * Start the MCP HTTP server. Returns the http.Server instance.
 */
export function startMcpServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS for remote tunnel access
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/health") {
      sendJson(res, 200, { ok: true, sessions: Object.keys(sessions).length });
      return;
    }

    if (req.url === "/mcp") {
      try {
        await handleMcp(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32001, message }, id: null });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.listen(MCP_PORT, "127.0.0.1", () => {
    console.log(`[mcp] listening on http://127.0.0.1:${MCP_PORT}`);
    console.log(`[mcp] endpoint: POST http://127.0.0.1:${MCP_PORT}/mcp`);
  });

  return server;
}
