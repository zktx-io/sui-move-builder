import { loadWasmBindings } from "./wasm_helpers.mjs";

const {
  dumpMovePackage,
  initMovePackageBuilder,
  resolveMovePackageDependencies,
} = await import(new URL("../../dist/full/index.js", import.meta.url));

await initMovePackageBuilder();

const wasm = await loadWasmBindings("full");

export { dumpMovePackage, resolveMovePackageDependencies };

export function digest(moveToml, packageName) {
  return wasm.compute_manifest_digest_from_move_toml(
    moveToml,
    packageName,
    "mainnet"
  );
}

export const depGit = "https://example.com/dep.git";
export const depSubdir = "";
export const currentRev = "rev-new";
export const staleRev = "rev-old";

// Computed with the Rust/WASM compute_manifest_digest helper for the root
// Move.toml below. Keeping this fixed lets the test isolate the dependency
// pin mismatch instead of falling back on the root pin.
export const rootManifestDigest =
  "8A2CED4251918E3C036CD40CC98A4B39E4A58E7F0C47432ABF66C83AF0FA454E";

export const fixtureDepMoveToml = `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[addresses]
Dep = "0x0"
`;

export const depManifestDigest = digest(fixtureDepMoveToml, "Dep");

export const rootMoveToml = `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[dependencies]
Dep = { git = "${depGit}", subdir = "${depSubdir}", rev = "${currentRev}" }

[addresses]
sui = "0x2"
`;

export const sameNameDepMoveToml = `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false
`;

export class FixtureFetcher {
  calls = [];

  async fetch(gitUrl, rev, subdir = "") {
    this.calls.push({ gitUrl, rev, subdir });
    if (gitUrl !== depGit || subdir !== depSubdir) {
      throw new Error(`Unexpected fetch: ${gitUrl} ${rev} ${subdir}`);
    }
    return {
      "Move.toml": fixtureDepMoveToml,
      "sources/dep.move": "module 0x0::dep {}",
    };
  }

  getResolvedSha(_gitUrl, rev) {
    return rev;
  }
}

export async function assertRejects(operation, pattern, message) {
  try {
    await operation();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!pattern.test(text)) {
      throw new Error(`${message}: unexpected error '${text}'`);
    }
    return;
  }
  throw new Error(`${message}: expected rejection`);
}
