import { Router, type Request, type Response } from "express";
import { CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, CF_TUNNEL_DOMAIN } from "../config.js";
import { requireAuth, rateLimit } from "../auth/middleware.js";
import { deriveSubdomain, deriveTunnelSecret } from "../auth/keys.js";

const router = Router();

// Auth required + rate limit: 5 tunnel operations per minute per IP
router.use(requireAuth);
router.use(rateLimit(60_000, 5));

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
  if (!res.ok) throw new Error(`Cloudflare API error: ${JSON.stringify(body)}`);
  return body;
}

/**
 * Find an existing tunnel by name.
 */
async function findTunnel(name: string): Promise<{ id: string } | null> {
  const result = (await cfFetch(
    `/accounts/${CF_ACCOUNT_ID}/tunnels?name=${encodeURIComponent(name)}&is_deleted=false`
  )) as { result: Array<{ id: string; name: string }> };
  return result.result.find((t) => t.name === name) || null;
}

/**
 * Find an existing DNS record by name.
 */
async function findDnsRecord(hostname: string): Promise<{ id: string } | null> {
  const result = (await cfFetch(
    `/zones/${CF_ZONE_ID}/dns_records?name=${encodeURIComponent(hostname)}&type=CNAME`
  )) as { result: Array<{ id: string }> };
  return result.result[0] || null;
}

/**
 * POST /api/tunnel/provision
 * Creates (or reuses) a named tunnel for the authenticated user.
 * Subdomain is derived from server secret + user ID — not guessable.
 */
router.post("/provision", async (req: Request, res: Response) => {
  const userId = (req as Request & { userId: string }).userId;

  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_ZONE_ID || !CF_TUNNEL_DOMAIN) {
    res.status(500).json({ error: "Cloudflare not configured on server" });
    return;
  }

  const subdomain = deriveSubdomain(userId);
  const tunnelName = `bb-${subdomain}`;
  const hostname = `${subdomain}.${CF_TUNNEL_DOMAIN}`;

  try {
    // Check if tunnel already exists
    let tunnel = await findTunnel(tunnelName);
    let tunnelId: string;

    if (tunnel) {
      // Tunnel exists — delete and recreate to get a fresh token
      // (Cloudflare only returns the token at creation time)
      tunnelId = tunnel.id;
      console.log(`[tunnel] deleting existing tunnel ${tunnelName} (${tunnelId}) for re-provision`);
      await cfFetch(`/accounts/${CF_ACCOUNT_ID}/tunnels/${tunnelId}`, { method: "DELETE" }).catch(() => {});
    }

    // Create tunnel with a deterministic secret
    const tunnelSecret = deriveTunnelSecret(userId).toString("base64");
    const createResult = (await cfFetch(`/accounts/${CF_ACCOUNT_ID}/tunnels`, {
      method: "POST",
      body: JSON.stringify({ name: tunnelName, tunnel_secret: tunnelSecret }),
    })) as { result: { id: string; token: string } };

    tunnelId = createResult.result.id;
    const tunnelToken = createResult.result.token;

    // Configure tunnel ingress
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

    // Create or update DNS CNAME
    const existingDns = await findDnsRecord(hostname);
    if (existingDns) {
      await cfFetch(`/zones/${CF_ZONE_ID}/dns_records/${existingDns.id}`, {
        method: "PUT",
        body: JSON.stringify({
          type: "CNAME",
          name: hostname,
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true,
        }),
      });
    } else {
      await cfFetch(`/zones/${CF_ZONE_ID}/dns_records`, {
        method: "POST",
        body: JSON.stringify({
          type: "CNAME",
          name: hostname,
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true,
        }),
      });
    }

    console.log(`[tunnel] provisioned ${hostname} → tunnel ${tunnelId}`);

    res.json({
      tunnelId,
      tunnelToken,
      hostname,
      mcpEndpoint: `https://${hostname}/mcp`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[tunnel] provision error:", msg);
    res.status(500).json({ error: "Tunnel provisioning failed" });
  }
});

/**
 * DELETE /api/tunnel/revoke
 * Delete the authenticated user's tunnel and DNS record.
 */
router.delete("/revoke", async (req: Request, res: Response) => {
  const userId = (req as Request & { userId: string }).userId;

  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_ZONE_ID || !CF_TUNNEL_DOMAIN) {
    res.status(500).json({ error: "Cloudflare not configured" });
    return;
  }

  const subdomain = deriveSubdomain(userId);
  const tunnelName = `bb-${subdomain}`;
  const hostname = `${subdomain}.${CF_TUNNEL_DOMAIN}`;

  try {
    // Delete DNS record
    const dns = await findDnsRecord(hostname);
    if (dns) {
      await cfFetch(`/zones/${CF_ZONE_ID}/dns_records/${dns.id}`, { method: "DELETE" });
    }

    // Delete tunnel
    const tunnel = await findTunnel(tunnelName);
    if (tunnel) {
      await cfFetch(`/accounts/${CF_ACCOUNT_ID}/tunnels/${tunnel.id}`, { method: "DELETE" });
    }

    console.log(`[tunnel] revoked ${hostname}`);
    res.json({ ok: true, hostname });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[tunnel] revoke error:", msg);
    res.status(500).json({ error: "Revocation failed" });
  }
});

export default router;
