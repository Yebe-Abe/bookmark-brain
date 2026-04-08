import fs from "fs/promises";
import path from "path";
import { STATE_DIR, PROCESS_API_URL } from "../config.js";
import { ingestItem } from "../storage/store.js";

const AUTH_FILE = path.join(STATE_DIR, "x-auth.json");
const SYNC_FILE = path.join(STATE_DIR, "x-sync.json");

interface AuthState {
  accessToken: string;
  refreshToken: string;
  userId: string;
  username: string;
  expiresAt: number; // epoch ms
}

interface SyncState {
  lastPollTime: string | null;
}

interface BookmarkTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  note_tweet?: { text: string };
  article?: unknown;
  entities?: {
    urls?: Array<{ url: string; expanded_url: string; display_url: string }>;
  };
}

interface BookmarkUser {
  id: string;
  username: string;
  name: string;
}

interface BookmarkResponse {
  data?: BookmarkTweet[];
  includes?: { users?: BookmarkUser[] };
  meta?: { next_token?: string; result_count?: number };
}

// --- Auth state ---

export async function loadAuth(): Promise<AuthState | null> {
  try {
    const text = await fs.readFile(AUTH_FILE, "utf8");
    return JSON.parse(text) as AuthState;
  } catch {
    return null;
  }
}

async function saveAuth(auth: AuthState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(AUTH_FILE, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Refresh the access token via the server.
 */
async function refreshTokens(auth: AuthState): Promise<AuthState> {
  if (!PROCESS_API_URL) {
    throw new Error("Cannot refresh tokens without BOOKMARK_BRAIN_API_URL");
  }

  const res = await fetch(`${PROCESS_API_URL}/auth/x/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: auth.refreshToken }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const updated: AuthState = {
    ...auth,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };

  await saveAuth(updated);
  return updated;
}

/**
 * Get a valid access token, refreshing if needed.
 */
export async function getAccessToken(): Promise<{ token: string; userId: string }> {
  let auth = await loadAuth();
  if (!auth) {
    throw new Error("Not authenticated with X. Run: bookmark-brain login");
  }

  // Refresh if token expires within 5 minutes
  if (Date.now() > auth.expiresAt - 5 * 60 * 1000) {
    console.log("[x-bookmarks] refreshing access token...");
    auth = await refreshTokens(auth);
  }

  return { token: auth.accessToken, userId: auth.userId };
}

// --- Sync state ---

async function loadSync(): Promise<SyncState> {
  try {
    const text = await fs.readFile(SYNC_FILE, "utf8");
    return JSON.parse(text) as SyncState;
  } catch {
    return { lastPollTime: null };
  }
}

async function saveSync(state: SyncState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(SYNC_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// --- Polling ---

/**
 * Poll X bookmarks API for new bookmarks.
 * Returns count of newly ingested bookmarks.
 */
export async function pollBookmarks(): Promise<number> {
  const { token, userId } = await getAccessToken();

  const params = new URLSearchParams({
    "tweet.fields": "created_at,author_id,text,entities,note_tweet,article",
    "user.fields": "username",
    expansions: "author_id",
    max_results: "100",
  });

  const response = await fetch(
    `https://api.x.com/2/users/${userId}/bookmarks?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const wait = retryAfter ? parseInt(retryAfter, 10) : 60;
    console.log(`[x-bookmarks] rate limited, retry after ${wait}s`);
    return 0;
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[x-bookmarks] API error ${response.status}: ${errorText}`);
    return 0;
  }

  const body = (await response.json()) as BookmarkResponse;

  if (!body.data || body.data.length === 0) {
    await saveSync({ lastPollTime: new Date().toISOString() });
    return 0;
  }

  const users = new Map<string, BookmarkUser>();
  for (const user of body.includes?.users || []) {
    users.set(user.id, user);
  }

  let ingested = 0;
  const tweets = body.data.reverse(); // oldest first

  for (const tweet of tweets) {
    const author = tweet.author_id ? users.get(tweet.author_id) : undefined;

    // Use article plain_text for X Articles, note_tweet for long tweets, fall back to text
    const fullText = (tweet.article as any)?.plain_text || tweet.note_tweet?.text || tweet.text;

    // Log article field if present
    if (tweet.article) {
      console.log(`[x-bookmarks] tweet ${tweet.id} article:`, JSON.stringify(tweet.article));
    }

    // Extract expanded URLs from entities (resolved by X)
    const rawEntities = tweet.entities?.urls || [];
    console.log(`[x-bookmarks] tweet ${tweet.id} entities.urls:`, JSON.stringify(rawEntities));
    const expandedUrls = rawEntities
      .map((u) => u.expanded_url)
      .filter(Boolean);

    const result = await ingestItem({
      sourceId: tweet.id,
      text: fullText,
      author: author ? `@${author.username}` : null,
      url: author
        ? `https://x.com/${author.username}/status/${tweet.id}`
        : null,
      createdAt: tweet.created_at || new Date().toISOString(),
      expandedUrls,
    });

    if (result) {
      ingested++;
      console.log(`[x-bookmarks] ingested: ${tweet.text.slice(0, 80)}...`);
    }
  }

  await saveSync({ lastPollTime: new Date().toISOString() });
  return ingested;
}
