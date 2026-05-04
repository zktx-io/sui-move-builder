import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCompatManifest } from "../../scripts/wasm/compat-manifest.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const manifest = await loadCompatManifest(
  path.join(repoRoot, "scripts/compat")
);
const securityText = await fs.readFile(
  path.join(repoRoot, "SECURITY.md"),
  "utf8"
);

const inventoryMatch = securityText.match(
  /<!-- compat-inventory:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- compat-inventory:end -->/
);
if (!inventoryMatch) {
  throw new Error("SECURITY.md is missing the compat inventory JSON block");
}

const inventory = JSON.parse(inventoryMatch[1]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function sortedKeys(value) {
  assertObject(value, "inventory section");
  return Object.keys(value).sort();
}

function assertKeySet(label, actual, expected) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify([...expected].sort());
  if (actualJson !== expectedJson) {
    throw new Error(
      `${label} keys do not match manifest\nactual: ${actualJson}\nexpected: ${expectedJson}`
    );
  }
}

function assertInventoryEntry(entry, label) {
  assertObject(entry, label);
  for (const field of ["category", "reachability", "behavior"]) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`${label}.${field} must be a non-empty string`);
    }
  }
}

assertObject(inventory, "compat inventory");
assertKeySet(
  "stubTemplates",
  sortedKeys(inventory.stubTemplates),
  Object.keys(manifest.stubTemplates)
);
assertKeySet(
  "filePatches",
  sortedKeys(inventory.filePatches),
  Object.keys(manifest.filePatches)
);
assertKeySet(
  "emptyStubCrates",
  sortedKeys(inventory.emptyStubCrates),
  manifest.emptyStubCrates
);

for (const [crate, compatSource] of Object.entries(manifest.stubTemplates)) {
  const entry = inventory.stubTemplates[crate];
  assertInventoryEntry(entry, `stubTemplates.${crate}`);
  if (entry.compatSource !== compatSource) {
    throw new Error(
      `stubTemplates.${crate}.compatSource is ${entry.compatSource}, expected ${compatSource}`
    );
  }
}

for (const [patchName, compatFile] of Object.entries(manifest.filePatches)) {
  const entry = inventory.filePatches[patchName];
  assertInventoryEntry(entry, `filePatches.${patchName}`);
  if (entry.compatFile !== compatFile) {
    throw new Error(
      `filePatches.${patchName}.compatFile is ${entry.compatFile}, expected ${compatFile}`
    );
  }
}

for (const crate of manifest.emptyStubCrates) {
  assertInventoryEntry(
    inventory.emptyStubCrates[crate],
    `emptyStubCrates.${crate}`
  );
}

console.log("[OK] security doc compat inventory matches manifest");
