/**
 * Extract content from URLs found in tweet text.
 *
 * For X/Twitter URLs: fetch the tweet via X API v2 (includes note_tweet for
 * long-form, referenced_tweets for quotes).
 * For other URLs: fetch HTML and extract readable text.
 */

const URL_RE = /https?:\/\/[^\s)]+/g;

// Matches x.com or twitter.com status URLs → extract tweet ID
const X_STATUS_RE = /(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/;

// Tags that typically contain the main content
const CONTENT_TAGS = new Set(["article", "main", "section"]);

// Tags to strip entirely (content and all)
const STRIP_TAGS = new Set([
  "script", "style", "nav", "header", "footer", "aside",
  "noscript", "iframe", "svg", "form", "button",
]);

export interface ExtractedContent {
  sourceUrl: string;
  text: string;
}

/**
 * Find URLs in text and extract content from the first one that works.
 * xAccessToken is needed to fetch tweets via the X API.
 */
export async function extractFromUrls(
  text: string,
  xAccessToken: string,
): Promise<ExtractedContent | null> {
  const urls = text.match(URL_RE);
  if (!urls || urls.length === 0) return null;

  for (const rawUrl of urls) {
    try {
      // Step 1: resolve t.co (or any) redirect to get the real URL
      console.log(`[extract] resolving ${rawUrl}`);
      const resolved = await resolveRedirect(rawUrl);
      const targetUrl = resolved || rawUrl;
      console.log(`[extract] resolved to ${targetUrl}`);

      // Step 2: check if it's an X/Twitter status URL
      const tweetId = extractTweetId(targetUrl);
      if (tweetId) {
        console.log(`[extract] detected tweet ID ${tweetId}, fetching via X API`);
        const result = await fetchTweetViaApi(tweetId, xAccessToken);
        if (result && result.text.length > 0) {
          console.log(`[extract] got ${result.text.length} chars from tweet ${tweetId}`);
          return result;
        }
        console.log(`[extract] X API returned no content for tweet ${tweetId}`);
        continue;
      }

      // Step 3: non-X URL — fetch HTML and extract text
      console.log(`[extract] fetching HTML from ${targetUrl}`);
      const result = await fetchAndExtractHtml(targetUrl);
      if (result && result.text.length > 50) {
        console.log(`[extract] got ${result.text.length} chars from ${targetUrl}`);
        return result;
      }
      console.log(`[extract] no usable content from ${targetUrl}`);
    } catch (err) {
      console.error(`[extract] failed for ${rawUrl}:`, (err as Error).message);
    }
  }

  return null;
}

// --- URL resolution ---

/**
 * Follow redirects to get the final URL. Uses HEAD to avoid downloading the body.
 */
async function resolveRedirect(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    // res.url is the final URL after all redirects
    return res.url !== url ? res.url : null;
  } catch {
    return null;
  }
}

function extractTweetId(url: string): string | null {
  const match = url.match(X_STATUS_RE);
  return match ? match[1]! : null;
}

// --- X API tweet lookup ---

interface TweetLookupResponse {
  data?: {
    id: string;
    text: string;
    author_id?: string;
    created_at?: string;
    note_tweet?: { text: string };
    referenced_tweets?: Array<{ type: string; id: string }>;
  };
  includes?: {
    tweets?: Array<{
      id: string;
      text: string;
      author_id?: string;
      note_tweet?: { text: string };
    }>;
    users?: Array<{
      id: string;
      username: string;
      name: string;
    }>;
  };
}

/**
 * Fetch a tweet by ID using X API v2.
 * Includes note_tweet (long-form), referenced tweets (quotes), and author info.
 */
async function fetchTweetViaApi(
  tweetId: string,
  accessToken: string,
): Promise<ExtractedContent | null> {
  const params = new URLSearchParams({
    "tweet.fields": "author_id,created_at,note_tweet,referenced_tweets,entities",
    "user.fields": "username,name",
    expansions: "author_id,referenced_tweets.id,referenced_tweets.id.author_id",
  });

  const res = await fetch(
    `https://api.x.com/2/tweets/${tweetId}?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    console.error(`[extract] X API ${res.status} for tweet ${tweetId}`);
    return null;
  }

  const body = (await res.json()) as TweetLookupResponse;
  if (!body.data) return null;

  const users = new Map<string, string>();
  for (const u of body.includes?.users || []) {
    users.set(u.id, `@${u.username}`);
  }

  // Use note_tweet.text for long-form tweets, fall back to text
  const mainText = body.data.note_tweet?.text || body.data.text;
  const mainAuthor = body.data.author_id ? users.get(body.data.author_id) || "" : "";

  const lines: string[] = [];
  if (mainAuthor) lines.push(`${mainAuthor}:`);
  lines.push(mainText);

  // Append quoted / referenced tweets
  const refTweets = body.includes?.tweets || [];
  for (const ref of body.data.referenced_tweets || []) {
    const expanded = refTweets.find((t) => t.id === ref.id);
    if (!expanded) continue;

    const refText = expanded.note_tweet?.text || expanded.text;
    const refAuthor = expanded.author_id ? users.get(expanded.author_id) || "" : "";
    const label = ref.type === "quoted" ? "Quoted" : ref.type === "retweeted" ? "Retweeted" : "Replied to";

    lines.push("");
    lines.push(`[${label}${refAuthor ? ` ${refAuthor}` : ""}]`);
    lines.push(refText);
  }

  const sourceUrl = `https://x.com/i/status/${tweetId}`;
  return { sourceUrl, text: lines.join("\n") };
}

// --- HTML extraction (for non-X URLs) ---

async function fetchAndExtractHtml(url: string): Promise<ExtractedContent | null> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return null;

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("xhtml")) return null;

  const html = await res.text();
  const sourceUrl = res.url;

  const text = htmlToText(html);
  if (text && text.length > 50) return { sourceUrl, text };

  // Fallback: try meta description / og:description
  const metaText = extractMetaDescription(html);
  if (metaText) return { sourceUrl, text: metaText };

  return null;
}

function extractMetaDescription(html: string): string | null {
  const ogMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
  if (ogMatch && ogMatch[1] && ogMatch[1].length > 20) return ogMatch[1];

  const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  if (metaMatch && metaMatch[1] && metaMatch[1].length > 20) return metaMatch[1];

  return null;
}

function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");

  let content = extractContentBlock(s);
  if (!content || content.length < 100) {
    const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    content = bodyMatch ? bodyMatch[1]! : s;
  }

  for (const tag of STRIP_TAGS) {
    const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, "gi");
    content = content.replace(re, "");
  }

  content = content.replace(/<[^>]+>/g, " ");

  content = content
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));

  content = content
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

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
