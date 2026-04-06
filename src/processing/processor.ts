import path from "path";
import { ITEMS_DIR, PROCESS_INTERVAL_MS } from "../config.js";
import {
  getUnprocessedItems,
  saveProcessedItem,
  markItemError,
  type KnowledgeItem,
} from "../storage/store.js";
import { processBookmark, processScreenshot } from "./claude.js";

/**
 * Find the raw image file for a screenshot item.
 */
async function findImagePath(item: KnowledgeItem): Promise<string | null> {
  const { default: fs } = await import("fs/promises");
  const month = item.createdAt.slice(0, 7);
  const itemDir = path.join(ITEMS_DIR, month, item.id);

  try {
    const files = await fs.readdir(itemDir);
    const rawFile = files.find((f) => f.startsWith("raw."));
    return rawFile ? path.join(itemDir, rawFile) : null;
  } catch {
    return null;
  }
}

/**
 * Process a single item through Claude.
 */
async function processOne(item: KnowledgeItem): Promise<void> {
  console.log(`[processor] processing ${item.id} (${item.source})`);

  try {
    if (item.source === "x_bookmark") {
      // Parse raw text from the stored JSON
      if (item.rawText) {
        try {
          const parsed = JSON.parse(item.rawText) as { text?: string };
          if (parsed.text) item.rawText = parsed.text;
        } catch {
          // rawText is already plain text
        }
      }

      const result = await processBookmark(item);
      item.title = result.title;
      item.summary = result.summary;
      item.tags = result.tags;
      item.concepts = result.concepts;
      item.entities = result.entities;
      await saveProcessedItem(item, {});
    } else {
      const imagePath = await findImagePath(item);
      if (!imagePath) {
        await markItemError(item, "Raw image file not found");
        return;
      }

      const result = await processScreenshot(item, imagePath);
      item.title = result.title;
      item.summary = result.summary;
      item.tags = result.tags;
      item.concepts = result.concepts;
      item.entities = result.entities;
      item.rawText = result.rawText || null;
      await saveProcessedItem(item, { rawText: result.rawText });
    }

    console.log(`[processor] done: ${item.id} → "${item.title}"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[processor] error on ${item.id}: ${message}`);
    await markItemError(item, message);
  }
}

/**
 * Start the processing loop. Checks for unprocessed items on an interval.
 */
export function startProcessingLoop(): void {
  console.log(`[processor] started (checking every ${PROCESS_INTERVAL_MS / 1000}s)`);

  const tick = async () => {
    try {
      const items = await getUnprocessedItems();
      if (items.length > 0) {
        console.log(`[processor] ${items.length} item(s) to process`);
        // Process one at a time to avoid hammering the API
        await processOne(items[0]!);
      }
    } catch (err) {
      console.error("[processor] loop error:", err);
    }
  };

  // Run immediately, then on interval
  tick();
  setInterval(tick, PROCESS_INTERVAL_MS);
}
