import { PROCESS_INTERVAL_MS } from "../config.js";
import {
  getUnprocessedItems,
  saveProcessedItem,
  markItemError,
  type PendingItem,
} from "../storage/store.js";
import { processBookmark } from "./claude.js";

async function processOne(item: PendingItem): Promise<void> {
  console.log(`[processor] processing ${item.sourceId}`);

  try {
    // For X Articles, send title + first ~2000 chars for metadata extraction
    // (the full text is already stored in item.articleText)
    let textForProcessing = item.text;
    if (item.articleTitle && item.articleText) {
      textForProcessing = `${item.articleTitle}\n\n${item.articleText.slice(0, 2000)}`;
    }
    const result = await processBookmark(textForProcessing, item.expandedUrls || []);

    // For articles, use the article title from X if Claude's title is generic
    if (item.articleTitle && result.title.toLowerCase().includes("link")) {
      result.title = item.articleTitle;
    }

    await saveProcessedItem(item, result);
    console.log(`[processor] done: "${result.title}"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[processor] error on ${item.sourceId}: ${message}`);
    await markItemError(item, message);
  }
}

/**
 * Process all pending items, then return.
 */
export async function processAll(): Promise<number> {
  const items = await getUnprocessedItems();
  if (items.length === 0) return 0;

  console.log(`[processor] ${items.length} item(s) to process`);
  for (const item of items) {
    await processOne(item);
  }
  return items.length;
}

/**
 * Process items on a loop forever.
 */
export function startProcessingLoop(): void {
  console.log(`[processor] watching for new items (every ${PROCESS_INTERVAL_MS / 1000}s)`);

  const tick = async () => {
    try {
      const items = await getUnprocessedItems();
      if (items.length > 0) {
        console.log(`[processor] ${items.length} item(s) to process`);
        await processOne(items[0]!);
      }
    } catch (err) {
      console.error("[processor] loop error:", err);
    }
  };

  tick();
  setInterval(tick, PROCESS_INTERVAL_MS);
}
