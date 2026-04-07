import { PROCESS_INTERVAL_MS } from "../config.js";
import {
  getUnprocessedItems,
  saveProcessedItem,
  markItemError,
  type KnowledgeItem,
} from "../storage/store.js";
import { processBookmark } from "./claude.js";

async function processOne(item: KnowledgeItem): Promise<void> {
  console.log(`[processor] processing ${item.id}`);

  try {
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
    item.useCase = result.useCase || "";
    item.tags = result.tags;
    item.concepts = result.concepts;
    item.entities = result.entities;
    await saveProcessedItem(item);

    console.log(`[processor] done: ${item.id} → "${item.title}"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[processor] error on ${item.id}: ${message}`);
    await markItemError(item, message);
  }
}

export function startProcessingLoop(): void {
  console.log(`[processor] started (checking every ${PROCESS_INTERVAL_MS / 1000}s)`);

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
