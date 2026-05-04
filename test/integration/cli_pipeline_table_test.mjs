import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const suiVersion = require("../../sui-version.json");
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const pipelinePath = path.join(repoRoot, "CLI_PIPELINE.md");
const sourceRoot = path.join(repoRoot, ".sui-build/source");

const requiredHeaders = [
  "Stage",
  "Pinned CLI owner",
  "WASM owner",
  "Porting shape",
  "Current validation",
  "Version-up checkpoint",
];

const requiredStages = [
  "Input loading",
  "Dependency fetch",
  "`Move.toml`/env overlay",
  "`Move.lock`",
  "Manifest graph",
  "V4 graph",
  "Mode filtering/linkage",
  "Manifest digest",
  "Address resolution priority",
  "Intent dispatch",
  "Compiler input",
  "Source discovery",
  "Compiler flags",
  "Verifier",
  "Module/dependency/digest output",
  "`Move.lock` generation",
  "Test runner",
  "Legacy publication migration",
  "Publication update",
  "Unsupported host-only behavior",
];

const allowedShapes = new Set([
  "vendor pass-through",
  "rust self-impl",
  "TS host boundary",
  "not exposed",
  "WASM limitation",
]);

function parseTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractSharedConfiguration(text) {
  const heading = "### Shared Configuration";
  const headingIndex = text.indexOf(heading);
  if (headingIndex === -1) {
    throw new Error(`CLI_PIPELINE.md is missing ${heading}`);
  }
  const sectionEnd = text.indexOf("\n### ", headingIndex + heading.length);
  const section = text.slice(
    headingIndex,
    sectionEnd === -1 ? text.length : sectionEnd
  );
  const match = section.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error(`${heading} must include a JSON example`);
  }
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`${heading} JSON example is invalid: ${error.message}`);
  }
}

const text = await readFile(pipelinePath, "utf8");
const sharedConfig = extractSharedConfiguration(text);
for (const key of ["version", "tag", "commit"]) {
  if (sharedConfig[key] !== suiVersion[key]) {
    throw new Error(
      `CLI_PIPELINE.md Shared Configuration ${key} must match sui-version.json: expected ${suiVersion[key]}, got ${sharedConfig[key]}`
    );
  }
}
const unexpectedSharedKeys = Object.keys(sharedConfig).filter(
  (key) => !["version", "tag", "commit"].includes(key)
);
if (unexpectedSharedKeys.length > 0) {
  throw new Error(
    `CLI_PIPELINE.md Shared Configuration has unexpected keys: ${unexpectedSharedKeys.join(", ")}`
  );
}

const heading = "## CLI Structure vs WASM Structure";
const headingIndex = text.indexOf(heading);
if (headingIndex === -1) {
  throw new Error(`CLI_PIPELINE.md is missing ${heading}`);
}
const nextSectionIndex = text.indexOf("\n## 1) ", headingIndex);
if (nextSectionIndex === -1) {
  throw new Error(`${heading} must appear before section 1`);
}

const section = text.slice(headingIndex, nextSectionIndex);
const tableLines = section
  .split("\n")
  .filter((line) => line.trim().startsWith("|"));
if (tableLines.length < 3) {
  throw new Error(`${heading} must include a markdown table`);
}

const headers = parseTableRow(tableLines[0]);
if (headers.join("\n") !== requiredHeaders.join("\n")) {
  throw new Error(`${heading} has unexpected headers: ${headers.join(", ")}`);
}

const rows = tableLines.slice(2).map(parseTableRow);
const rowsByStage = new Map();
for (const row of rows) {
  if (row.length !== requiredHeaders.length) {
    throw new Error(`Malformed CLI/WASM structure row: ${row.join(" | ")}`);
  }
  const [stage, pinnedOwner, wasmOwner, portingShape, validation, checkpoint] =
    row;
  if (rowsByStage.has(stage)) {
    throw new Error(`Duplicate CLI/WASM structure stage: ${stage}`);
  }
  rowsByStage.set(stage, row);
  if (!allowedShapes.has(portingShape)) {
    throw new Error(
      `Stage ${stage} uses unsupported porting shape: ${portingShape}`
    );
  }
  for (const [label, value] of [
    ["Pinned CLI owner", pinnedOwner],
    ["WASM owner", wasmOwner],
    ["Current validation", validation],
    ["Version-up checkpoint", checkpoint],
  ]) {
    if (!value || value === "-") {
      throw new Error(`${stage} has an empty ${label} cell`);
    }
  }
}

for (const stage of requiredStages) {
  if (!rowsByStage.has(stage)) {
    throw new Error(`CLI/WASM structure table is missing stage: ${stage}`);
  }
}

let checkedSourceRefs = 0;
if (await pathExists(sourceRoot)) {
  for (const row of rows) {
    const [stage, pinnedOwner] = row;
    const sourceRefs = [
      ...pinnedOwner.matchAll(/`((?:crates|external-crates)\/[^`]+\.rs)`/g),
    ].map((match) => match[1]);
    for (const sourceRef of sourceRefs) {
      checkedSourceRefs += 1;
      if (!(await pathExists(path.join(sourceRoot, sourceRef)))) {
        throw new Error(
          `${stage} references missing pinned CLI source: ${sourceRef}`
        );
      }
    }
  }
  console.log(`[OK] checked ${checkedSourceRefs} pinned CLI source references`);
} else {
  console.log(
    "[SKIP] .sui-build/source missing; upstream path checks bypassed"
  );
}

console.log("[OK] CLI pipeline structure table is current");
