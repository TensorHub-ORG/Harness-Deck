#!/usr/bin/env node
/**
 * Builds a clean, self-contained portable Harness-Deck distribution bundle
 * in `dist-bundle/harness-deck/` so ANY Agent tool can unpack it and start
 * interactive zero-to-one onboarding from `START_HERE.md`.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "dist-bundle", "harness-deck");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const includeEntries = [
  "START_HERE.md",
  "AGENTS.md",
  ".agents",
  "README.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".env.example",
  ".gitignore",
  "docs",
  "skills",
  "deploy",
  "packs",
  "scripts",
  "protocol",
  "packages",
  "mcps",
  "adapters",
];

function copyFiltered(src, dest) {
  const stat = fs.statSync(src);
  const base = path.basename(src);
  if (
    base === "node_modules" ||
    base === ".deck" ||
    base === ".env" ||
    base === "dist-bundle" ||
    base === "data" ||
    base.endsWith(".sqlite") ||
    base.endsWith(".sqlite-wal") ||
    base.endsWith(".sqlite-shm")
  ) {
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyFiltered(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

for (const entry of includeEntries) {
  const srcPath = path.join(root, entry);
  if (fs.existsSync(srcPath)) {
    copyFiltered(srcPath, path.join(outDir, entry));
  }
}

const manifest = {
  name: "harness-deck",
  version: "1.0.0",
  protocol_version: "1.0",
  entry_for_agents: "START_HERE.md",
  onboarding_skill: "skills/deck-onboarding/SKILL.md",
  trust_tiers: ["T0:boss", "T1:secretary", "T2:worker", "T3:frontline"],
  skills: fs
    .readdirSync(path.join(root, "skills"))
    .map((dir) => `skills/${dir}/SKILL.md`)
    .filter((p) => fs.existsSync(path.join(root, p))),
  mcps: ["mcps/deck-comm", "mcps/deck-dispatch", "mcps/deck-qq", "mcps/deck-kb"],
  adapters: ["adapters/dsh-plugin"],
  deploy_kits: ["deploy/local/docker-compose.qq.yml", "deploy/remote/docker-compose.vps.yml"],
  generated_at: new Date().toISOString(),
};

fs.writeFileSync(path.join(outDir, "harness-deck.bundle.json"), JSON.stringify(manifest, null, 2));
console.log(`Portable Harness-Deck bundle created at: ${outDir}`);
console.log(`Manifest written: ${path.join(outDir, "harness-deck.bundle.json")}`);
