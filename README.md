# bookmark-brain

Pull your X/Twitter bookmarks, process them with Claude, and save as markdown files on your local filesystem.

Every bookmark gets tagged and annotated — tweets, X Articles, and linked content all get captured. Your data stays on your machine.

## Quick Start (Claude Cowork)

If you use [Claude Cowork](https://claude.ai/cowork):

1. Download [`bookmark-brain.skill`](bookmark-brain.skill) and add it to your Cowork skills
2. Say "Set up bookmark brain"

The skill handles everything — cloning the repo, running setup, logging into X, and creating a daily scheduled task so your bookmarks sync automatically.

## Manual Install

```bash
git clone https://github.com/yebe-abe/bookmark-brain
cd bookmark-brain
npm run setup
```

## Usage

```bash
bookmark-brain login          # sign in with X (opens browser)
bookmark-brain                # pull new bookmarks, process, save as markdown, exit
bookmark-brain schedule 7am   # run every day at 7am (uses cron)
bookmark-brain schedule off   # stop scheduled runs
bookmark-brain --watch        # keep polling every 60s (instead of one-shot)
```

## Output

Each bookmark becomes a markdown file in `~/.bookmark-brain/bookmarks/`:

```markdown
---
title: "Chunking strategies for RAG pipelines"
date: 2026-04-07
author: "@karpathy"
url: "https://x.com/karpathy/status/123456"
tags: [rag, chunking, retrieval]
---

Original tweet text here...

## Concepts
- semantic chunking (technique)

## Entities
- Andrej Karpathy @karpathy (person)
```

X Articles (long-form posts) are saved with their full content. Linked articles are fetched and included when possible.

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
