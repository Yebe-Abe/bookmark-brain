# bookmark-brain

Personal knowledge base that automatically pulls your X/Twitter bookmarks, processes them with Claude, and makes everything searchable from Claude Desktop and Claude Code. Optionally imports screenshots from iCloud Photos too.

Every item gets tagged, summarized, and annotated with **when it's useful** — so Claude can proactively surface relevant bookmarks while you're working on a project.

Your data stays on your machine. Claude reads local indexes and drills into items — no cloud database, no uploads.

## How it works

```
X Bookmarks ───→ ┌──────────────────────┐      ┌──────────────────┐
                 │  Your Mac (daemon)   │      │  Server (Railway) │
iCloud Photos ─→ │                      │ ───→ │  Claude processing │
  (optional)     │  Local storage       │ ←─── │  X OAuth          │
                 │  MCP server (stdio)  │      └──────────────────┘
                 └──────────────────────┘
                          ↑
                   Claude Desktop / Code
                   (spawns MCP directly)
```

- **Daemon** runs in the background on your Mac, pulling new bookmarks automatically (and screenshots, if enabled)
- **Server** handles X OAuth and Claude API calls so you don't need any API keys
- **MCP server** is a local stdio process — Claude Desktop/Code spawns it directly to read your data

## Install

```bash
git clone https://github.com/you/bookmark-brain
cd bookmark-brain
npm run setup
source ~/.zshrc
```

Setup installs dependencies, builds the project, and installs the `bookmark-brain` CLI. It asks whether you want screenshot ingestion from iCloud Photos — if you say no, the screenshot dependencies (chokidar, osxphotos) are skipped entirely.

## Getting started

### 1. Login with X

```bash
bookmark-brain login
```

Your browser opens. Authorize with X. That's it — credentials are saved automatically.

### 2. Start the daemon

```bash
bookmark-brain start
```

This installs a background service that runs forever and survives reboots. On first run it:
- Pulls your X bookmarks
- If screenshots are enabled: imports the last 2 months of screenshots from iCloud Photos
- Processes everything through Claude — extracts tags, summaries, concepts, entities, and **use cases** (when each item is actionable)
- After that, new bookmarks (and screenshots) are picked up automatically every 60 seconds

Check daemon status anytime:
```bash
bookmark-brain status
tail -f ~/.bookmark-brain/logs/stdout.log
```

### 3. Connect Claude

```bash
bookmark-brain config
```

This auto-installs the MCP server into Claude Desktop (restart Claude Desktop to pick it up). For Claude Code, it prints a command you paste into your terminal.

### 4. Use it

Ask Claude anything about your saved content:

- "What have I been bookmarking about LLMs?"
- "I saved a screenshot of an error message yesterday, can you find it?" *(if screenshots enabled)*
- "What did @karpathy tweet about that I bookmarked?"
- "Show me everything tagged rust"
- "Is there anything in my bookmarks relevant to what I'm building right now?"

Claude doesn't just retrieve — it **connects your saved knowledge to your current work**. Every processed item includes an "Apply when" annotation, so Claude knows when a bookmark about RAG chunking strategies is relevant to the retrieval pipeline you're debugging right now.

### 5. Install the Claude skill (optional)

For the best experience, install the `bb` skill in Claude:

1. Zip the `skill/` folder from this repo
2. In Claude.ai → Settings → Capabilities → Skills → Upload
3. Toggle the skill on

With the skill installed, just type `bb` in any conversation to pull up your knowledge base, or `bb transformers` to search for a topic. Claude will also proactively check your bookmarks when it thinks they're relevant to what you're working on.

## Commands

```
bookmark-brain login    Sign in with X (opens browser)
bookmark-brain start    Install and start background daemon
bookmark-brain stop     Stop and uninstall daemon
bookmark-brain status   Check if daemon is running
bookmark-brain config   Connect Claude Desktop / Code to your data
bookmark-brain help     Show all commands
```

Run without a command for foreground mode (useful for debugging):
```bash
bookmark-brain
```

## What Claude can do

Claude has 5 MCP tools to navigate your knowledge base:

| Tool | What it does |
|---|---|
| `list_recent` | Shows the 50 most recently saved items with titles, tags, and use cases |
| `list_tags` | Shows all tags with item counts — discover what topics you've saved |
| `get_by_tag` | Shows all items with a specific tag |
| `get_item` | Full details for one item — metadata, extracted text, and images |
| `list_month` | Browse items by month |

There's no search engine. Claude IS the search engine — it reads the indexes, decides what's relevant, and drills into specific items. The "Apply when" annotation on each item helps Claude match saved knowledge to your current context.

## How data is stored

Everything lives in `~/.bookmark-brain/` on your machine:

```
~/.bookmark-brain/
├── index.txt              # 50 most recent items with summaries + use cases
├── tags/
│   ├── index.txt          # all tags with counts
│   └── llm.txt            # items tagged "llm"
├── items/
│   └── 2026-04/
│       ├── index.txt      # month index
│       ├── bk-a1b2c3.../  # bookmark (meta.json + raw.json)
│       └── ss-d4e5f6.../  # screenshot (meta.json + image + extracted.txt)
├── inbox/                 # manual screenshot drops + osxphotos exports
├── state/                 # auth + sync state
└── logs/                  # daemon logs
```

If screenshots are enabled, you can also drop images manually into `~/.bookmark-brain/inbox/` — they'll be picked up and processed automatically. To change your screenshot preference, re-run `npm run setup`.

## Roadmap

- **Obsidian export** — convert bookmarks and screenshots into markdown notes for your Obsidian vault. Tweets already have structured text (can be converted directly); screenshots will be run through Claude vision to extract content into markdown.

## Server deployment (for operators)

The server handles X OAuth and Claude processing so end users don't need API keys. Deploy once, serves all users.

### Deploy to Railway

1. Push to GitHub
2. New Project → Deploy from GitHub → set Root Directory to `server`
3. Set environment variables:

| Variable | Description |
|---|---|
| `SERVER_SECRET` | Random hex string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `SERVER_URL` | Your Railway public URL |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `X_CLIENT_ID` | From X developer portal |
| `X_CLIENT_SECRET` | From X developer portal |

### Verify

```bash
curl https://your-server.up.railway.app/health
# → {"ok":true,"services":{"xOauth":true,"processing":true}}
```

## Security

- **Data stays on your machine.** Bookmarks (and screenshots, if enabled) are never stored on the server.
- **Screenshots are opt-in.** Setup asks before accessing your Photos library or installing osxphotos. Say no and none of the screenshot dependencies are installed.
- **Read-only MCP.** The stdio server only reads files from `~/.bookmark-brain/`. No writes, no network access, no path traversal.
- **No API keys needed.** The server handles X OAuth and Claude API calls. Users never see or manage tokens.
- **Rate limiting** on all server endpoints.
- **Auth on processing.** API keys are derived via HMAC — stateless, no database.

## License

MIT
