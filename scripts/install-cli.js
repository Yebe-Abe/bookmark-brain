#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { execSync } from "child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CONFIG_DIR = path.join(os.homedir(), ".bookmark-brain");
const CONFIG_FILE = path.join(CONFIG_DIR, "config");
const BIN_NAME = "bookmark-brain";

// --- Helpers ---

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function setConfigKey(key, value) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  let content = "";
  try { content = fs.readFileSync(CONFIG_FILE, "utf8"); } catch {}
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    if (content.length && !content.endsWith("\n")) content += "\n";
    content += `${key}=${value}\n`;
  }
  fs.writeFileSync(CONFIG_FILE, content);
}

function run(cmd) {
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

// --- 1. Ask about screenshots before installing anything ---

let enableScreenshots = false;

if (process.platform === "darwin") {
  console.log();
  const answer = await ask("Import screenshots from iCloud Photos into bookmark-brain? [y/N] ");
  enableScreenshots = answer === "y" || answer === "yes";
} else {
  console.log("\n[setup] screenshot ingestion is macOS-only, skipping");
}

setConfigKey("SCREENSHOTS", enableScreenshots ? "true" : "false");

// --- 2. Install dependencies (skip chokidar if no screenshots) ---

console.log("\n[setup] installing dependencies...");
if (enableScreenshots) {
  run("npm install");
} else {
  run("npm install --omit=optional");
}

// --- 3. Install osxphotos if screenshots enabled ---

if (enableScreenshots) {
  try {
    execSync("osxphotos version", { stdio: "pipe" });
    console.log("[setup] osxphotos already installed");
  } catch {
    console.log("[setup] installing osxphotos (reads your Photos library)...");
    try {
      run("pip3 install osxphotos");
      console.log("[setup] osxphotos installed");
    } catch {
      console.log("[setup] could not install osxphotos automatically");
      console.log("[setup] install manually: pip3 install osxphotos");
      console.log("[setup] without it, you can still drop images into ~/.bookmark-brain/inbox/");
    }
  }
}

// --- 4. Build ---

console.log("\n[setup] building...");
run("npm run build");

// --- 5. Install CLI symlink ---

const ENTRY = path.join(ROOT, "dist", "index.js");

const candidates = [
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), "bin"),
];

function isOnPath(dir) {
  return (process.env.PATH || "").split(":").includes(dir);
}

function shellrc() {
  const shell = path.basename(process.env.SHELL || "zsh");
  if (shell === "bash") return path.join(os.homedir(), ".bashrc");
  if (shell === "fish") return path.join(os.homedir(), ".config", "fish", "config.fish");
  return path.join(os.homedir(), ".zshrc");
}

let binDir = candidates.find((d) => isOnPath(d));

if (!binDir) {
  binDir = candidates[0]; // ~/.local/bin
  fs.mkdirSync(binDir, { recursive: true });

  const rc = shellrc();
  const exportLine = `\nexport PATH="$HOME/.local/bin:$PATH"\n`;
  try {
    const existing = fs.readFileSync(rc, "utf8");
    if (!existing.includes(".local/bin")) {
      fs.appendFileSync(rc, exportLine);
      console.log(`[setup] added ~/.local/bin to PATH in ${rc}`);
      console.log(`[setup] run: source ${rc}`);
    }
  } catch {
    fs.writeFileSync(rc, exportLine);
    console.log(`[setup] created ${rc} with PATH entry`);
    console.log(`[setup] run: source ${rc}`);
  }
}

const wrapper = `#!/bin/sh\nexec node "${ENTRY}" "$@"\n`;
const dest = path.join(binDir, BIN_NAME);

fs.writeFileSync(dest, wrapper, { mode: 0o755 });
console.log(`[setup] installed ${dest}`);

// --- Done ---

if (enableScreenshots) {
  console.log("\n[setup] done! screenshots enabled");
} else {
  console.log("\n[setup] done! screenshots disabled (re-run setup to change)");
}
console.log("[setup] try: bookmark-brain help");
