/* global Response */

import { loadWasmBindings } from "./wasm_helpers.mjs";

export const {
  resolveMovePackageDependencies,
  GitHubMovePackageFetcher,
  fetchMovePackageFromGitHub,
} = await import(new URL("../../dist/full/index.js", import.meta.url));

const wasm = await loadWasmBindings("full");

export function rootFiles() {
  return {
    "Move.toml": `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[dependencies]
Dep = { local = "../dep" }

[addresses]
sui = "0x2"
`,
    "sources/root.move": "module sui::root_fixture {}",
  };
}

export const workspace = {
  "../dep": {
    "Move.toml": `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[dependencies]
Shared = { local = "../shared" }

[addresses]
dep = "0x0"
`,
    "sources/dep.move": "module dep::dep_fixture {}",
  },
  "../shared": {
    "Move.toml": `
[package]
name = "Shared"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[addresses]
shared = "0x0"
`,
    "sources/shared.move": "module shared::shared_fixture {}",
  },
};

export class LocalWorkspaceFetcher {
  calls = [];

  async fetch(gitUrl, rev, subdir = "") {
    throw new Error(`Unexpected git fetch: ${gitUrl} ${rev} ${subdir}`);
  }

  async fetchLocal(localPath, context) {
    this.calls.push({ localPath, context });
    const files = workspace[localPath];
    if (!files) {
      throw new Error(`Missing local fixture: ${localPath}`);
    }
    return files;
  }

  getResolvedSha() {
    return undefined;
  }
}

export function localV4Lockfile() {
  const rootMoveToml = rootFiles()["Move.toml"];
  const depMoveToml = workspace["../dep"]["Move.toml"];
  const sharedMoveToml = workspace["../shared"]["Move.toml"];
  return `
[move]
version = 4

[pinned.mainnet.Sui]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${manifestDigest(rootMoveToml, "Sui")}"
deps = { Dep = "Dep" }

[pinned.mainnet.Dep]
source = { local = "../dep" }
use_environment = "mainnet"
manifest_digest = "${manifestDigest(depMoveToml, "Dep")}"
deps = { Shared = "Shared" }

[pinned.mainnet.Shared]
source = { local = "../shared" }
use_environment = "mainnet"
manifest_digest = "${manifestDigest(sharedMoveToml, "Shared")}"
deps = {}
`;
}

export function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function textResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export function assertArrayEqual(actual, expected, message) {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `${message}: expected ${expected.join(", ")}, got ${actual.join(", ")}`
    );
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

function manifestDigest(moveToml, packageName) {
  return wasm.compute_manifest_digest_from_move_toml(
    moveToml,
    packageName,
    "mainnet"
  );
}
