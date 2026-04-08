/**
 * Extract readable content from URLs found in tweet text.
 */

const URL_RE = /https?:\/\/[^\s)]+/g;

// Tags that typically contain the main content
const CONTENT_TAGS = new Set(["article", "main", "section"]);

// Tags to strip entirely (content and all)
const STRIP_TAGS = new Set([
  "script", "style", "nav", "header", "footer", "aside",
  "noscript", "iframe", "svg", "form", "button",
]);

interface ExtractedContent {
  sourceUrl: string;
  text: string;
}

/**
 * Find URLs in text and extract readable content from the first one.
 */
export async function extractFromUrls(text: string): Promise<ExtractedContent | null> {
  const urls = text.match(URL_RE);
  if (!urls || urls.length === 0) return null;

  for (const rawUrl of urls) {
    try {
      const result = await fetchAndExtract(rawUrl);
      if (result && result.text.length > 50) return result;
    } catch (err) {
      console.error(`[extract] failed for ${rawUrl}:`, (err as Error).message);
    }
  }

  return null;
}

async function fetchAndExtract(url: string): Promise<ExtractedContent | null> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; bookmark-brain/0.2)",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return null;

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("xhtml")) return null;

  const html = await res.text();
  const sourceUrl = res.url; // final URL after redirects

  const text = htmlToText(html);
  if (!text) return null;

  return { sourceUrl, text };
}

function htmlToText(html: string): string {
  // Remove comments
  let s = html.replace(/<!--[\s\S]*?-->/g, "");

  // Try to find a content container first
  let content = extractContentBlock(s);
  if (!content || content.length < 100) {
    // Fall back to body
    const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    content = bodyMatch ? bodyMatch[1]! : s;
  }

  // Strip tags we don't want
  for (const tag of STRIP_TAGS) {
    const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, "gi");
    content = content.replace(re, "");
  }

  // Strip all remaining HTML tags
  content = content.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  content = content
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));

  // Collapse whitespace, trim
  content = content
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  // Cap at ~15k chars to avoid huge payloads
  if (content.length > 15_000) {
    content = content.slice(0, 15_000) + "\n[content truncated]";
  }

  return content;
}

function extractContentBlock(html: string): string | null {
  for (const tag of CONTENT_TAGS) {
    const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, "i");
    const match = html.match(re);
    if (match && match[0].length > 200) return match[0];
  }
  return null;
}
