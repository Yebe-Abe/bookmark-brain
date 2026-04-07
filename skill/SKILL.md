# bb - Bookmark Brain Skill

IMMEDIATE TRIGGER: When the user types "bb" (alone or in a message), or asks about something they bookmarked, saved, screenshotted, or "saw on Twitter" — immediately call the bookmark-brain MCP tools. Do NOT ask clarifying questions first. Look it up.

## When to use this

Activate whenever the user:
- Types "bb" alone or in a message
- Asks "what did I bookmark about X?"
- Asks "did I save anything about X?"
- Says "I saw a tweet about X" or "I bookmarked something about X"
- Asks "what's that screenshot I took of X?"
- Asks about a topic and you suspect their bookmarks/screenshots have relevant context
- Asks "what have I been reading about lately?"
- References a person, tool, or concept that might be in their saved content

## PROACTIVE MODE — Apply knowledge to the user's current work

This is the most valuable thing you can do. Don't just retrieve — **connect**.

When the user is working on a project, coding, or discussing a technical problem:
1. Think about whether their saved bookmarks/screenshots might be relevant
2. Check the "Apply when" field in index entries — it tells you exactly when each item is useful
3. If you find something relevant, surface it: "You bookmarked a thread about this exact pattern — here's what it suggests..."

Examples of proactive application:
- User is building a RAG pipeline → check tags like `rag`, `retrieval`, `embeddings` → find bookmarks about chunking strategies or reranking
- User hits a deployment error → check recent screenshots for similar errors, check tags like `devops`, `docker`, `deployment`
- User is designing an API → check tags like `api_design`, `rest`, `architecture` → find bookmarked best practices
- User mentions a library → check if they bookmarked anything about it, maybe a tweet about gotchas or tips
- User is stuck on a problem → scan recent bookmarks for relevant techniques or approaches they saved but may have forgotten about

The "Apply when" field on each item is your guide. It tells you the specific situation where that knowledge is actionable. Match it against what the user is currently doing.

## Search patterns

You have 5 tools. Use them in this order depending on the query:

### "bb" alone or "what's new?" → Start broad
```
1. list_recent → scan the 50 most recent items
2. Summarize what they've been saving, highlight anything relevant to recent conversations
```

### Topic query ("bb transformers", "what did I save about rust?") → Tag-first
```
1. list_tags → find matching tags
2. get_by_tag(tag) → get all items with that tag
3. get_item(id) → drill into the most relevant ones
```

### Person query ("anything from @karpathy?") → Scan recent, then tags
```
1. list_recent → scan for the person's name/handle
2. If not found, list_tags → look for related topic tags
3. get_item(id) → get full details
```

### Time query ("what did I bookmark last month?") → Month-first
```
1. list_month → see available months
2. list_month(month="2026-03") → browse that month's items
3. get_item(id) → drill into specific items
```

### Current work query ("anything relevant to what I'm building?") → Cross-reference
```
1. Identify the key concepts/technologies in the user's current work
2. list_tags → find matching tags
3. get_by_tag for the most relevant tags
4. Read the "Apply when" fields — surface items whose use case matches
5. get_item on the best matches
```

## Multi-round lookups

Don't stop after one tool call. Most useful answers require 2-3 rounds:

1. **Discover** — list_recent or list_tags to find what exists
2. **Narrow** — get_by_tag or list_month to filter
3. **Detail** — get_item to get the full content
4. **Connect** — relate what you found to the user's current context

## Response style

- Cite sources naturally: "From a tweet by @karpathy you bookmarked..."
- For screenshots: "In a screenshot you saved on April 3rd..."
- When applying to current work: "You bookmarked a thread about this — the key insight was..."
- Connect dots across items when multiple bookmarks relate to the same problem
- If an item has a clear use case that matches what they're doing, lead with that
- Include the item ID in case the user wants to reference it later

## Important

- ALWAYS check before asking the user to re-explain. Their saved content likely has the answer.
- Don't just retrieve and list. **Synthesize and apply.**
- When the user is working on something, think: "did they bookmark anything that would help here?"
- Bookmarks are usually technical — papers, tools, architecture, code patterns.
- Screenshots may contain code, conversations, error messages, diagrams, or articles.
- Items prefixed with `bk-` are bookmarks. Items prefixed with `ss-` are screenshots.
- The "Apply when" field is your best signal for relevance to the user's current task.
