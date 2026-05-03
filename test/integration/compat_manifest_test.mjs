import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCompatManifest } from "../../scripts/wasm/compat-manifest.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const compatDir = path.join(repoRoot, "scripts/compat");

const manifest = await loadCompatManifest(compatDir);
const stubbed = new Set(Object.keys(manifest.stubTemplates));
const empty = new Set(manifest.emptyStubCrates);

for (const crate of manifest.offendingCrates) {
  if (!stubbed.has(crate) && !empty.has(crate)) {
    throw new Error(`Offending crate is not explicitly covered: ${crate}`);
  }
}

const testRunnerPatch = await fs.readFile(
  path.join(compatDir, manifest.filePatches.moveUnitTestRunner),
  "utf8"
);
if (testRunnerPatch.includes("DEBUG:")) {
  throw new Error("move-unit-test runner patch must not contain DEBUG output");
}

const prepareScript = await fs.readFile(
  path.join(repoRoot, "scripts/prepare-wasm.mjs"),
  "utf8"
);
if (prepareScript.includes("falling back to empty stub")) {
  throw new Error("prepare-wasm must not silently fall back to empty stubs");
}
if (prepareScript.includes("contains debug prints")) {
  throw new Error("prepare-wasm must not validate patches by debug strings");
}

console.log("[OK] compat manifest has explicit stub coverage");
