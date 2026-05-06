import { createRequire } from "node:module";

import {
  getRepoRoot,
  loadBytecodeVerifierManifest,
} from "./bytecode-verifier-manifest.mjs";

const require = createRequire(import.meta.url);

function main() {
  const repoRoot = getRepoRoot();
  const { manifest, manifestPath } = loadBytecodeVerifierManifest(repoRoot);
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

  console.log(
    `[OK] ${manifestPath}: ${Object.keys(manifest.verifiers).length} bytecode verifier(s), current ${manifest.current}`
  );
}

main();
