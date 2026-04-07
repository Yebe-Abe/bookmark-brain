# bookmark-brain

Pull your X/Twitter bookmarks, process them with Claude, and save as markdown files on your local filesystem.

Every bookmark gets tagged, summarized, and annotated with 'when it's useful' structured knowledge you can grep, browse, or feed into other tools.

Your data stays on your machine. No cloud database, no uploads.

## Install

```bash
git clone https://github.com/you/bookmark-brain
cd bookmark-brain
npm run setup
```

## Usage

```bash
bookmark-brain login    # sign in with X (opens browser)
bookmark-brain          # run — pulls bookmarks, processes, saves as markdown
```

The process runs in the foreground, polling for new bookmarks every 60 seconds. Ctrl+C to stop.

## Output

Each bookmark becomes a markdown file with YAML frontmatter:

```markdown
---
title: "Chunking strategies for RAG pipelines"
date: 2026-04-07
author: "@karpathy"
url: "https://x.com/karpathy/status/123456"
tags: [rag, chunking, retrieval]
---

# Chunking strategies for RAG pipelines

> Original tweet text here...

Summary of the key insight.

**Apply when:** Building a RAG pipeline and retrieval quality is low.

## Concepts
- semantic chunking (technique)

## Entities
- Andrej Karpathy @karpathy (person)
```

Files live in `~/.bookmark-brain/items/YYYY-MM/bk-{hash}/bookmark.md`.

Index files for browsing:
- `~/.bookmark-brain/index.txt` — 50 most recent items
- `~/.bookmark-brain/tags/index.txt` — all tags with counts
- `~/.bookmark-brain/tags/{tag}.txt` — items with that tag

## Server deployment (for operators)

The server handles X OAuth and Claude processing so end users don't need API keys.

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

## License

MIT
