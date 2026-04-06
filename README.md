# bookmark-brain

Personal knowledge base that pulls in your X/Twitter bookmarks and iCloud screenshots, processes them through Claude, and makes everything searchable via MCP.

Your bookmarks and screenshots stay on your machine. Claude navigates them through a read-only peephole — it reads text indexes, decides what's relevant, and drills into specific items.

## How it works

```
X Bookmarks ──→ ┌──────────────────────┐      ┌──────────────────┐
                │  Your Mac (daemon)   │      │  Server (Railway) │
iCloud Photos ─→│                      │ ───→ │  Claude processing │
                │  Local storage       │ ←─── │  X OAuth          │
                │  MCP server (:9876)  │      │  Tunnel provision │
                └──────────┬───────────┘      └──────────────────┘
                           │
                  Cloudflare Tunnel
                           │
                    Claude Desktop / Code
```

- **Daemon** runs on your Mac, polls for new bookmarks and screenshots
- **Server** handles Claude API calls and X OAuth (you host it, users don't need API keys)
- **MCP server** is read-only, locked to one directory, bearer token required
- **Cloudflare tunnel** gives each user a stable URL that never changes

## Setup

### Prerequisites

- Node.js 18+
- Python 3 + `pip install osxphotos` (for iCloud screenshot ingestion)
- `brew install cloudflared` (for remote MCP access, optional)

### Install

```bash
git clone https://github.com/you/bookmark-brain
cd bookmark-brain
npm install && npm run setup
source ~/.zshrc  # if first time, to pick up PATH change
```

### First-time setup

```bash
# Login with X
bookmark-brain login
```

Opens your browser to authorize with X. Credentials are saved automatically.

```bash
# Start the background daemon
bookmark-brain start
```

The daemon installs as a macOS Login Item. It:
- Pulls the last 2 months of screenshots from iCloud Photos
- Pulls all your X bookmarks
- Processes everything through Claude
- Starts the MCP server
- Runs forever, survives reboots

```bash
# Get your MCP config
bookmark-brain config
```

Prints a JSON block to paste into your Claude Desktop or Claude Code config. Done.

### Commands

```
bookmark-brain login    Sign in with X (opens browser)
bookmark-brain start    Install and start background daemon
bookmark-brain stop     Stop and uninstall daemon
bookmark-brain status   Check if daemon is running
bookmark-brain config   Print MCP config for Claude
```

### Configuration

Settings go in `~/.bookmark-brain/config`:

```
BOOKMARK_BRAIN_API_URL=https://your-server.up.railway.app
TUNNEL_MODE=named
```

## Server deployment

The server handles X OAuth, Claude processing, and tunnel provisioning. Users never need API keys.

### Deploy to Railway

1. Push to GitHub
2. New Project → Deploy from GitHub → set Root Directory to `server`
3. Set environment variables:

| Variable | Description |
|---|---|
| `SERVER_SECRET` | Random hex string. Derives all user keys. |
| `SERVER_URL` | Your Railway public URL |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `X_CLIENT_ID` | From X developer portal |
| `X_CLIENT_SECRET` | From X developer portal |
| `CF_API_TOKEN` | Cloudflare API token (Tunnel:Edit + DNS:Edit) |
| `CF_ACCOUNT_ID` | Cloudflare account ID |
| `CF_ZONE_ID` | Cloudflare zone ID |
| `CF_TUNNEL_DOMAIN` | e.g. `mcp.yourdomain.com` |

Generate `SERVER_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Verify

```bash
curl https://your-server.up.railway.app/health
```

## Security

- **Data stays local.** Bookmarks and screenshots are stored on the user's machine, never on the server.
- **Read-only MCP.** The peephole server (~200 lines) only reads files from `~/.bookmark-brain/`. No writes, no path traversal.
- **Bearer token auth.** MCP requests require a token. Without it, the tunnel endpoint returns 401.
- **HMAC-derived keys.** API keys and tokens are computed from a server secret + user ID. Zero database, stateless, deterministic.
- **Rate limiting.** All server endpoints are rate limited.
- **Tunnel subdomains are not guessable.** Derived via HMAC, not based on usernames or sequential IDs.

## How Claude searches your knowledge

There's no search engine — Claude IS the search engine. The MCP tools give Claude access to plain-text index files:

1. `list_recent` — what's been saved lately?
2. `list_tags` — what topics exist?
3. `get_by_tag` — all items with a specific tag
4. `get_item` — full details + images for one item
5. `list_month` — browse by time

Claude reads the indexes, decides what's relevant, and drills down.

## Data format

```
~/.bookmark-brain/
├── index.txt              # 50 most recent items
├── tags/
│   ├── index.txt          # all tags with counts
│   └── llm.txt            # items tagged "llm"
├── items/
│   └── 2026-04/
│       ├── index.txt      # month index
│       ├── bk-a1b2c3.../  # bookmark (meta.json + raw.json)
│       └── ss-d4e5f6.../  # screenshot (meta.json + image + extracted.txt)
├── inbox/                 # manual drops + osxphotos exports
├── state/                 # auth, sync, tunnel credentials
└── logs/                  # daemon logs
```

## License

MIT
