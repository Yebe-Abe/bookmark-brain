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
bookmark-brain login          # sign in with X (opens browser)
bookmark-brain                # pull new bookmarks, process, save as markdown, exit
bookmark-brain --watch        # keep polling every 60s (instead of one-shot)
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

```
~/.bookmark-brain/
├── bookmarks/
│   └── 2026-04/
│       ├── chunking-strategies-a1b2c3.md
│       └── karpathy-on-transformers-d4e5f6.md
├── index.txt              # 50 most recent bookmarks
├── tags/
│   ├── index.txt          # all tags with counts
│   └── rag.txt            # bookmarks tagged "rag"
└── state/                 # auth, sync state (internal)
```

## License

MIT
