#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BIN_NAME = "bookmark-brain";

function run(cmd) {
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

// --- 1. Install dependencies ---

console.log("[setup] installing dependencies...");
run("npm install");

// --- 2. Build ---

console.log("\n[setup] building...");
run("npm run build");

// --- 3. Install CLI symlink ---

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

console.log("\n[setup] done! run: bookmark-brain login");
