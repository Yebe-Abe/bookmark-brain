import { PROCESS_INTERVAL_MS } from "../config.js";
import {
  getUnprocessedItems,
  saveProcessedItem,
  markItemError,
  type PendingItem,
} from "../storage/store.js";
import { processBookmark } from "./claude.js";

async function processOne(item: PendingItem): Promise<void> {
  console.log(`[processor] processing ${item.id}`);

  try {
    // Parse raw text from stored JSON
    let text = item.rawText;
    try {
      const parsed = JSON.parse(text) as { text?: string };
      if (parsed.text) text = parsed.text;
    } catch {
      // already plain text
    }

    const result = await processBookmark(text);
    await saveProcessedItem(item, {
      ...result,
      rawText: text,
      author: item.author,
      url: item.url,
      createdAt: item.createdAt,
    });

    console.log(`[processor] done: ${item.id} → "${result.title}"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[processor] error on ${item.id}: ${message}`);
    await markItemError(item, message);
  }
}

/**
 * Process all unprocessed items, then return.
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
