import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import { CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, CF_TUNNEL_DOMAIN } from "../config.js";

const router = Router();

const CF_API = "https://api.cloudflare.com/client/v4";

async function cfFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Cloudflare API error: ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * POST /api/tunnel/provision
 * Body: { userId: string }
 * Creates a named tunnel and DNS record for {userId}.{CF_TUNNEL_DOMAIN}
 * Returns: { tunnelId, tunnelToken, hostname }
 *
 * The client app uses the tunnelToken to run: cloudflared tunnel run --token <token>
 */
router.post("/provision", async (req: Request, res: Response) => {
  const { userId } = req.body as { userId?: string };

  if (!userId) {
    res.status(400).json({ error: "userId required" });
    return;
  }

  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_ZONE_ID || !CF_TUNNEL_DOMAIN) {
    res.status(500).json({ error: "Cloudflare not configured on server" });
    return;
  }

  const tunnelName = `bb-${userId}`;
  const hostname = `${userId}.${CF_TUNNEL_DOMAIN}`;

  try {
    // 1. Create the tunnel
    const tunnelSecret = crypto.randomBytes(32).toString("base64");
    const createResult = (await cfFetch(`/accounts/${CF_ACCOUNT_ID}/tunnels`, {
      method: "POST",
      body: JSON.stringify({
        name: tunnelName,
        tunnel_secret: tunnelSecret,
      }),
    })) as { result: { id: string; token: string } };

    const tunnelId = createResult.result.id;
    const tunnelToken = createResult.result.token;

    // 2. Configure the tunnel to route to the client's local MCP server
    await cfFetch(`/accounts/${CF_ACCOUNT_ID}/tunnels/${tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname, service: "http://localhost:9876" },
            { service: "http_status:404" },
          ],
        },
      }),
    });

    // 3. Create DNS CNAME record pointing hostname → tunnel
    await cfFetch(`/zones/${CF_ZONE_ID}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
      }),
    });

    console.log(`[tunnel] provisioned ${hostname} → tunnel ${tunnelId}`);

    res.json({
      tunnelId,
      tunnelToken,
      hostname,
      mcpEndpoint: `https://${hostname}/mcp`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[tunnel] provision error:", message);
    res.status(500).json({ error: message });
  }
});

export default router;
