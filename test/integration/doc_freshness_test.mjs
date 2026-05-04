import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const targets = [
  "AGENTS.md",
  "README.md",
  "CLI_PIPELINE.md",
  "scripts",
  "src",
  "sui-move-wasm",
];

const skippedDirectories = new Set([
  ".git",
  ".sui-build",
  "dist",
  "generated",
  "node_modules",
  "pkg",
  "target",
]);

const checkedExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
]);

const forbiddenPatterns = [
  { label: "planned", pattern: /\bplanned\b/i },
  { label: "future migration", pattern: /\bfuture\s+migration\b/i },
  { label: "temporary", pattern: /\btemporary\b/i },
  { label: "workaround", pattern: /\bworkaround\b/i },
  { label: "previously", pattern: /\bpreviously\b/i },
  { label: "used to", pattern: /\bused\s+to\b/i },
  { label: "we changed", pattern: /\bwe\s+changed\b/i },
  { label: "migrated from", pattern: /\bmigrated\s+from\b/i },
];

async function collectFiles(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelativePath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) {
        continue;
      }
      files.push(...(await collectFiles(childRelativePath)));
    } else if (entry.isFile()) {
      if (checkedExtensions.has(path.extname(entry.name))) {
        files.push(childRelativePath);
      }
    }
  }
  return files;
}

async function targetFiles() {
  const files = [];
  for (const target of targets) {
    const absolutePath = path.join(repoRoot, target);
    const entries = await readdir(path.dirname(absolutePath), {
      withFileTypes: true,
    });
    const entry = entries.find(
      (candidate) => candidate.name === path.basename(target)
    );
    if (!entry) {
      throw new Error(`Freshness target is missing: ${target}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(target)));
    } else {
      files.push(target);
    }
  }
  return files;
}

const violations = [];
for (const relativePath of await targetFiles()) {
  const text = await readFile(path.join(repoRoot, relativePath), "utf8");
  const lines = text.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    for (const { label, pattern } of forbiddenPatterns) {
      if (pattern.test(line)) {
        violations.push(`${relativePath}:${lineIndex + 1}: ${label}`);
      }
    }
  }
}

if (violations.length > 0) {
  throw new Error(
    `Documentation/code contains work-log phrasing:\n${violations.join("\n")}`
  );
}

console.log("[OK] documentation and comments use current-state phrasing");
