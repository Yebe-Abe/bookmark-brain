import { execFile, spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { INBOX_DIR, STATE_DIR, SCREENSHOT_POLL_INTERVAL_MS } from "../config.js";
import { ingestItem, contentHash } from "../storage/store.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic"]);
const ONBOARD_MONTHS = 2;

// --- osxphotos integration (macOS + iCloud Photos) ---

async function hasOsxphotos(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("osxphotos", ["version"], (err) => resolve(!err));
  });
}

function osxphotosExportDir(): string {
  return path.join(INBOX_DIR, ".osxphotos-export");
}

/**
 * Export screenshots from Photos library using osxphotos.
 * --update flag makes it only export new photos on subsequent runs.
 * --screenshot filters to screenshots only (including iPhone screenshots via iCloud).
 */
async function runOsxphotosExport(fromDate?: string): Promise<void> {
  const exportDir = osxphotosExportDir();
  await fs.mkdir(exportDir, { recursive: true });

  const args = [
    "export", exportDir,
    "--screenshot",
    "--update",
    "--convert-to-jpeg",
  ];

  if (fromDate) {
    args.push("--from-date", fromDate);
  }

  return new Promise((resolve, reject) => {
    console.log(`[screenshots] running osxphotos export${fromDate ? ` (from ${fromDate})` : ""}...`);
    const proc = spawn("osxphotos", args, { stdio: "pipe" });

    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.stdout?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[screenshots] ${line}`);
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`osxphotos exited with code ${code}: ${stderr.slice(0, 200)}`));
    });
    proc.on("error", reject);
  });
}

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().split("T")[0]!;
}

async function hasOnboarded(): Promise<boolean> {
  try {
    await fs.access(path.join(STATE_DIR, "screenshots-onboarded"));
    return true;
  } catch {
    return false;
  }
}

async function markOnboarded(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(path.join(STATE_DIR, "screenshots-onboarded"), new Date().toISOString());
}

// --- Ingestion (shared by all sources) ---

async function ingestImageFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return false;

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
      return true;
    }
  } catch (err) {
    console.error(`[screenshots] error processing ${filePath}:`, err);
  }
  return false;
}

async function ingestDir(dir: string): Promise<number> {
  let count = 0;
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (file.startsWith(".")) continue;
      const full = path.join(dir, file);
      const stat = await fs.stat(full);
      if (stat.isFile() && (await ingestImageFile(full))) count++;
    }
  } catch {}
  return count;
}

// --- Main entry point ---

/**
 * Start screenshot ingestion.
 *
 * If osxphotos is available (macOS):
 *   1. On first run: export last 2 months of screenshots from Photos
 *   2. Ongoing: poll for new screenshots every 60s
 *
 * Always: watch inbox folder for manually dropped images.
 */
export async function startScreenshots(): Promise<void> {
  await fs.mkdir(INBOX_DIR, { recursive: true });

  const useOsxphotos = process.platform === "darwin" && (await hasOsxphotos());

  if (useOsxphotos) {
    console.log("[screenshots] osxphotos detected — pulling from Photos library");

    if (!(await hasOnboarded())) {
      console.log(`[screenshots] onboarding: importing last ${ONBOARD_MONTHS} months of screenshots...`);
      try {
        await runOsxphotosExport(monthsAgo(ONBOARD_MONTHS));
        const count = await ingestDir(osxphotosExportDir());
        console.log(`[screenshots] onboarding complete: ${count} screenshot(s) ingested`);
        await markOnboarded();
      } catch (err) {
        console.error("[screenshots] onboarding failed:", (err as Error).message);
        console.log("[screenshots] will retry on next start. You can also drop images into the inbox.");
      }
    }

    setInterval(async () => {
      try {
        await runOsxphotosExport();
        const count = await ingestDir(osxphotosExportDir());
        if (count > 0) console.log(`[screenshots] polled ${count} new screenshot(s) from Photos`);
      } catch (err) {
        console.error("[screenshots] poll error:", (err as Error).message);
      }
    }, SCREENSHOT_POLL_INTERVAL_MS);
  } else {
    if (process.platform === "darwin") {
      console.log("[screenshots] osxphotos not found — install with: pip install osxphotos");
      console.log("[screenshots] falling back to inbox folder watching");
    }
  }

  console.log(`[screenshots] watching ${INBOX_DIR}`);
  try {
    const mod = "chokidar";
    const { watch } = await import(/* webpackIgnore: true */ mod);
    const watcher = watch(INBOX_DIR, {
      ignoreInitial: false,
      ignored: (p: string) => path.basename(p).startsWith("."),
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
      depth: 0,
    });

    watcher.on("add", (filePath: string) => { ingestImageFile(filePath); });
  } catch {
    console.log("[screenshots] chokidar not installed — inbox folder watching disabled");
    console.log("[screenshots] install with: npm install chokidar");
  }
}
