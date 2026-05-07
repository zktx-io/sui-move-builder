import { createRequire } from "node:module";

import {
  getRepoRoot,
  loadBytecodeVerifierManifest,
} from "./bytecode-verifier-manifest.mjs";
import { loadBytecodeVersionSourceRecords } from "./bytecode-version-source-records.mjs";
import { assertVerificationRuntimeConfigFresh } from "./generate-verification-runtime-config.mjs";

const require = createRequire(import.meta.url);

function main() {
  const repoRoot = getRepoRoot();
  const { manifest, manifestPath } = loadBytecodeVerifierManifest(repoRoot);
  const { sourceRecords, sourceRecordsPath } =
    loadBytecodeVersionSourceRecords(repoRoot);
  const current = manifest.verifiers[manifest.current];
  const suiVersion = require("../../sui-version.json");

  for (const key of ["version", "tag", "commit"]) {
    const expected = suiVersion[key] ?? null;
    const actual =
      key === "version" ? current.suiVersion : (current[key] ?? null);
    if (actual !== expected) {
      throw new Error(
        `Current bytecode verifier ${key} must match sui-version.json: expected ${expected}, got ${actual}`
      );
    }
  }

  const sourceRecordVersions = new Set(
    sourceRecords.records.map((record) => String(record.decodedBytecodeVersion))
  );
  for (const version of Object.keys(manifest.bytecodeVersions)) {
    if (!sourceRecordVersions.has(version)) {
      throw new Error(
        `Bytecode version ${version} route must have a source record in ${sourceRecordsPath}`
      );
    }
  }
  assertVerificationRuntimeConfigFresh(repoRoot);

  console.log(
    `[OK] ${manifestPath}: ${Object.keys(manifest.verifiers).length} bytecode verifier(s), current ${manifest.current}`
  );
  console.log(
    `[OK] ${sourceRecordsPath}: ${sourceRecords.records.length} bytecode version source record(s)`
  );
}

main();
