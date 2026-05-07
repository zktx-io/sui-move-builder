import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCompatManifest } from "../../scripts/wasm/compat-manifest.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const compatDir = path.join(repoRoot, "scripts/compat");
const sourceRoot = path.join(repoRoot, ".sui-build/source");

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

async function pathExists(filePath) {
  return Boolean(await fs.stat(filePath).catch(() => false));
}

function exportedPublicFunctions(source) {
  return [...source.matchAll(/^pub fn ([A-Za-z0-9_]+)/gm)].map(
    (match) => match[1]
  );
}

const upstreamRangeproofs = path.join(
  sourceRoot,
  "sui-execution/latest/sui-move-natives/src/crypto/rangeproofs.rs"
);
if (await pathExists(upstreamRangeproofs)) {
  const rangeproofsPatch = manifest.filePatches.rangeproofs;
  if (!rangeproofsPatch) {
    throw new Error(
      "Active compat manifest must declare filePatches.rangeproofs when pinned Sui source contains crypto/rangeproofs.rs"
    );
  }

  const [upstreamSource, compatSource] = await Promise.all([
    fs.readFile(upstreamRangeproofs, "utf8"),
    fs.readFile(path.join(compatDir, rangeproofsPatch), "utf8"),
  ]);
  for (const fnName of exportedPublicFunctions(upstreamSource)) {
    if (!compatSource.includes(`pub fn ${fnName}`)) {
      throw new Error(
        `rangeproofs compat patch is missing upstream public native function ${fnName}`
      );
    }
  }
  if (
    upstreamSource.includes("pub struct BulletproofsCostParams") &&
    !compatSource.includes("pub struct BulletproofsCostParams")
  ) {
    throw new Error(
      "rangeproofs compat patch is missing upstream BulletproofsCostParams"
    );
  }
}

console.log("[OK] compat manifest has explicit stub coverage");
