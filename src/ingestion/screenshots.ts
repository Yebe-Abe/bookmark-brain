import path from "path";
import { watch } from "chokidar";
import { INBOX_DIR } from "../config.js";
import { ingestItem, contentHash } from "../storage/store.js";
import fs from "fs/promises";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * Watch the inbox directory for new screenshots.
 * Drop images into ~/.bookmark-brain/inbox/ and they'll be ingested automatically.
 */
export function watchScreenshots(onIngested?: (id: string) => void): void {
  // Ensure inbox exists
  fs.mkdir(INBOX_DIR, { recursive: true }).catch(() => {});

  console.log(`[screenshots] watching ${INBOX_DIR}`);

  const watcher = watch(INBOX_DIR, {
    ignoreInitial: false, // process existing files on startup
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  });

  watcher.on("add", async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return;

    try {
      const content = await fs.readFile(filePath);
      const hash = contentHash(content.toString("base64").slice(0, 10000));

      const result = await ingestItem({
        source: "screenshot",
        sourceId: hash.slice(0, 16),
        rawContent: filePath,
        createdAt: new Date().toISOString(),
      });

      if (result) {
        console.log(`[screenshots] ingested: ${path.basename(filePath)}`);
        onIngested?.(result.id);
      }
    } catch (err) {
      console.error(`[screenshots] error processing ${filePath}:`, err);
    }
  });
}
