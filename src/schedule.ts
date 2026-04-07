import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { STATE_DIR } from "./config.js";

const SCHEDULE_FILE = path.join(STATE_DIR, "schedule.json");
const CRON_TAG = "# bookmark-brain";

interface ScheduleState {
  time: string;
  hour: number;
  minute: number;
}

// --- Time parsing ---

function parseTime(input: string): { hour: number; minute: number } {
  const s = input.trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) throw new Error(`Can't parse time "${input}". Try: 7am, 2:30pm, 14:30`);

  let hour = parseInt(m[1]!, 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];

  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time "${input}"`);
  }

  return { hour, minute };
}

function formatTime(hour: number, minute: number): string {
  const h = hour % 12 || 12;
  const ampm = hour < 12 ? "AM" : "PM";
  const min = minute > 0 ? `:${String(minute).padStart(2, "0")}` : "";
  return `${h}${min} ${ampm}`;
}

// --- Crontab management ---

function requireCrontab(): void {
  try {
    execSync("which crontab", { stdio: "pipe" });
  } catch {
    const install =
      process.platform === "linux"
        ? "Install it with: sudo apt-get install cron  (or your distro's equivalent)"
        : "It should be available by default on macOS.";
    console.error(`crontab not found. ${install}`);
    process.exit(1);
  }
}

function getNodePath(): string {
  try {
    return execSync("which node", { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
}

function getScriptPath(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "index.js");
}

function readCrontab(): string {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
  } catch {
    return "";
  }
}

function writeCrontab(content: string): void {
  execSync("crontab -", { input: content });
}

function removeBbLines(crontab: string): string {
  return crontab
    .split("\n")
    .filter((line) => !line.includes(CRON_TAG))
    .join("\n");
}

// --- Public API ---

export async function installSchedule(timeStr: string): Promise<void> {
  requireCrontab();
  const { hour, minute } = parseTime(timeStr);
  const nodePath = getNodePath();
  const scriptPath = getScriptPath();

  const cronLine = `${minute} ${hour} * * * ${nodePath} ${scriptPath} ${CRON_TAG}`;

  let crontab = removeBbLines(readCrontab()).trimEnd();
  if (crontab.length) crontab += "\n";
  crontab += cronLine + "\n";

  writeCrontab(crontab);

  // Save state
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(
    SCHEDULE_FILE,
    JSON.stringify({ time: timeStr, hour, minute }, null, 2) + "\n",
  );

  console.log(`Scheduled: daily at ${formatTime(hour, minute)}`);
}

export async function removeSchedule(): Promise<void> {
  requireCrontab();
  const crontab = removeBbLines(readCrontab());
  writeCrontab(crontab);

  try { await fs.unlink(SCHEDULE_FILE); } catch {}

  console.log("Schedule removed");
}

export async function showSchedule(): Promise<void> {
  try {
    const state = JSON.parse(await fs.readFile(SCHEDULE_FILE, "utf8")) as ScheduleState;
    console.log(`Scheduled: daily at ${formatTime(state.hour, state.minute)}`);
  } catch {
    console.log("No schedule set. Usage: bookmark-brain schedule 7am");
  }
}
