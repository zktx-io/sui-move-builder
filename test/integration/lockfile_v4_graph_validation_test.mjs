import {
  assertRejects,
  currentRev,
  depGit,
  depManifestDigest,
  depSubdir,
  digest,
  FixtureFetcher,
  resolveMovePackageDependencies,
  rootManifestDigest,
  rootMoveToml,
} from "./lockfile_v4_test_helpers.mjs";

const malformedNoRootLock = `
[move]
version = 4

[pinned.mainnet.Dep]
source = { git = "${depGit}", subdir = "${depSubdir}", rev = "${currentRev}" }
use_environment = "mainnet"
manifest_digest = "${depManifestDigest}"
deps = {}
`;

const malformedMissingEdgeLock = `
[move]
version = 4

[pinned.mainnet.Sui]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${rootManifestDigest}"
deps = {}

[pinned.mainnet.Dep]
source = { git = "${depGit}", subdir = "${depSubdir}", rev = "${currentRev}" }
use_environment = "mainnet"
manifest_digest = "${depManifestDigest}"
deps = {}
`;

export async function runMalformedGraphStructure() {
  await assertRejects(
    () =>
      resolveMovePackageDependencies({
        files: {
          "Move.toml": rootMoveToml,
          "Move.lock": malformedNoRootLock,
          "sources/root.move": "module 0x2::root {}",
        },
        network: "mainnet",
        fetcher: new FixtureFetcher(),
      }),
    /no root package entry/,
    "missing root package entry should be rejected like a malformed V4 lockfile"
  );

  await assertRejects(
    () =>
      resolveMovePackageDependencies({
        files: {
          "Move.toml": rootMoveToml,
          "Move.lock": malformedMissingEdgeLock,
          "sources/root.move": "module 0x2::root {}",
        },
        network: "mainnet",
        fetcher: new FixtureFetcher(),
      }),
    /missing dependency 'Dep'/,
    "missing lockfile dependency edge should be rejected"
  );

  console.log("[OK] malformed v4 lockfile graph structure is rejected");
}

const implicitRootMoveToml = `
[package]
name = "App"
version = "0.0.0"
edition = "2024"

[addresses]
app = "0x0"
`;
const moveStdlibMoveToml = `
[package]
name = "MoveStdlib"
version = "0.0.0"
edition = "2024"
published-at = "0x1"

[addresses]
std = "0x1"
`;
const suiMoveToml = `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"
published-at = "0x2"

[dependencies]
MoveStdlib = { local = "../move-stdlib" }

[addresses]
sui = "0x2"
`;
const badImplicitMoveLock = `
[move]
version = 4

[pinned.mainnet.App]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${digest(implicitRootMoveToml, "App")}"
deps = { std = "BadStd", sui = "Sui" }

[pinned.mainnet.MoveStdlib]
source = { local = "../move-stdlib" }
use_environment = "mainnet"
manifest_digest = "${digest(moveStdlibMoveToml, "MoveStdlib")}"
deps = {}

[pinned.mainnet.Sui]
source = { local = "../sui" }
use_environment = "mainnet"
manifest_digest = "${digest(suiMoveToml, "Sui")}"
deps = { MoveStdlib = "MoveStdlib" }
`;

class BadImplicitFetcher {
  async fetch() {
    throw new Error("unexpected git fetch");
  }

  async fetchLocal(localPath) {
    if (localPath === "../move-stdlib") {
      return {
        "Move.toml": moveStdlibMoveToml,
        "sources/std.move": "module 0x1::std {}",
      };
    }
    if (localPath === "../sui") {
      return {
        "Move.toml": suiMoveToml,
        "sources/sui.move": "module 0x2::sui {}",
      };
    }
    throw new Error(`Unexpected local path: ${localPath}`);
  }
}

export async function runMalformedImplicitTarget() {
  await assertRejects(
    () =>
      resolveMovePackageDependencies({
        files: {
          "Move.toml": implicitRootMoveToml,
          "Move.lock": badImplicitMoveLock,
          "sources/root.move": "module 0x0::root {}",
        },
        network: "mainnet",
        fetcher: new BadImplicitFetcher(),
      }),
    /undefined dependency 'BadStd'|BadStd/,
    "undefined implicit lockfile target should be rejected"
  );

  console.log("[OK] malformed implicit v4 lockfile target is rejected");
}
