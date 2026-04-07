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
  lastBookmarkId: string | null;
  lastPollTime: string | null;
}

interface BookmarkTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
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

export async function saveAuth(auth: AuthState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(AUTH_FILE, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
}

export async function isAuthConfigured(): Promise<boolean> {
  if (process.env.X_BEARER_TOKEN) return true;
  try { await fs.access(AUTH_FILE); return true; } catch { return false; }
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
async function getAccessToken(): Promise<{ token: string; userId: string }> {
  // Legacy: direct bearer token
  if (process.env.X_BEARER_TOKEN && process.env.X_USER_ID) {
    return { token: process.env.X_BEARER_TOKEN, userId: process.env.X_USER_ID };
  }

  let auth = await loadAuth();
  if (!auth) {
    throw new Error("Not authenticated with X. Run the OAuth flow first.");
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
    return { lastBookmarkId: null, lastPollTime: null };
  }
}

async function saveSync(state: SyncState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(SYNC_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// --- Polling ---

/**
 * Poll X bookmarks API for new bookmarks.
 * Returns count of newly ingested items.
 */
export async function pollBookmarks(): Promise<number> {
  const { token, userId } = await getAccessToken();
  const sync = await loadSync();

  const params = new URLSearchParams({
    "tweet.fields": "created_at,author_id,text",
    "user.fields": "username",
    expansions: "author_id",
    max_results: "100",
  });

  if (sync.lastBookmarkId) {
    params.set("since_id", sync.lastBookmarkId);
  }

  const response = await fetch(
    `https://api.x.com/2/users/${userId}/bookmarks?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[x-bookmarks] API error ${response.status}: ${errorText}`);
    return 0;
  }

  const body = (await response.json()) as BookmarkResponse;

  if (!body.data || body.data.length === 0) {
    sync.lastPollTime = new Date().toISOString();
    await saveSync(sync);
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

    const result = await ingestItem({
      source: "x_bookmark",
      sourceId: tweet.id,
      rawContent: JSON.stringify({
        id: tweet.id,
        text: tweet.text,
        author: author?.username || null,
        created_at: tweet.created_at || null,
      }),
      author: author ? `@${author.username}` : undefined,
      url: author
        ? `https://x.com/${author.username}/status/${tweet.id}`
        : undefined,
      createdAt: tweet.created_at,
    });

    if (result) {
      ingested++;
      console.log(`[x-bookmarks] ingested: ${tweet.text.slice(0, 80)}...`);
    }

    sync.lastBookmarkId = tweet.id;
  }

  sync.lastPollTime = new Date().toISOString();
  await saveSync(sync);
  return ingested;
}
