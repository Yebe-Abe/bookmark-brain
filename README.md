# bookmark-brain

Pull your X/Twitter bookmarks, process them with Claude, and save as markdown files on your local filesystem.

Every bookmark gets tagged, summarized, and annotated with 'when it's useful' structured knowledge you can grep, browse, or feed into other tools.

Your data stays on your machine. No cloud database, no uploads.

## Install

```bash
git clone https://github.com/yebe-abe/bookmark-brain
cd bookmark-brain
npm run setup
```

## Usage

```bash
bookmark-brain login      # sign in with X (opens browser)
bookmark-brain            # pull new bookmarks, process, save as markdown, exit
bookmark-brain --watch    # same, but keep polling every 60s
```

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

## License

MIT
