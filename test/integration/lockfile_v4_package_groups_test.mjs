import {
  currentRev,
  depGit,
  depManifestDigest,
  depSubdir,
  digest,
  FixtureFetcher,
  resolveMovePackageDependencies,
  sameNameDepMoveToml,
} from "./lockfile_v4_test_helpers.mjs";

const depAGit = "https://example.com/dep-a.git";
const depBGit = "https://example.com/dep-b.git";
const sameNameRevA = "rev-a";
const sameNameRevB = "rev-b";
const sameNameRootMoveToml = `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[dependencies]
DepA = { git = "${depAGit}", rev = "${sameNameRevA}", rename-from = "Dep" }
DepB = { git = "${depBGit}", rev = "${sameNameRevB}", rename-from = "Dep" }
`;
const sameNameMoveLock = `
[move]
version = 4

[pinned.mainnet.Sui]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${digest(sameNameRootMoveToml, "Sui")}"
deps = { DepA = "Dep", DepB = "Dep_1" }

[pinned.mainnet.Dep]
source = { git = "${depAGit}", rev = "${sameNameRevA}" }
use_environment = "mainnet"
manifest_digest = "${digest(sameNameDepMoveToml, "Dep")}"
deps = {}

[pinned.mainnet.Dep_1]
source = { git = "${depBGit}", rev = "${sameNameRevB}" }
use_environment = "mainnet"
manifest_digest = "${digest(sameNameDepMoveToml, "Dep")}"
deps = {}
`;

class SameNameFetcher {
  async fetch(gitUrl, rev, subdir = "") {
    if (
      !(
        (gitUrl === depAGit && rev === sameNameRevA) ||
        (gitUrl === depBGit && rev === sameNameRevB)
      ) ||
      subdir !== ""
    ) {
      throw new Error(`Unexpected fetch: ${gitUrl} ${rev} ${subdir}`);
    }
    return {
      "Move.toml": sameNameDepMoveToml,
      "sources/dep.move": "module 0x0::dep {}",
    };
  }

  getResolvedSha(_gitUrl, rev) {
    return rev;
  }
}

export async function runSameNamePackageIds() {
  const sameNameResolved = await resolveMovePackageDependencies({
    files: {
      "Move.toml": sameNameRootMoveToml,
      "Move.lock": sameNameMoveLock,
      "sources/root.move": "module 0x2::root {}",
    },
    network: "mainnet",
    fetcher: new SameNameFetcher(),
  });
  const sameNameDeps = JSON.parse(sameNameResolved.lockfileDependencies);
  const depAEntry = sameNameDeps.find((dep) => dep.name === "Dep");
  const depBEntry = sameNameDeps.find((dep) => dep.name === "Dep_1");
  if (
    depAEntry?.source?.git !== depAGit ||
    depBEntry?.source?.git !== depBGit
  ) {
    throw new Error("Expected same-name/different-source pins to be preserved");
  }
  const sameNameCompileDeps = JSON.parse(sameNameResolved.dependencies);
  const depACompileEntry = sameNameCompileDeps.find(
    (dep) => dep.name === "Dep"
  );
  const depBCompileEntry = sameNameCompileDeps.find(
    (dep) => dep.name === "Dep_1"
  );
  if (
    depACompileEntry?.source?.git !== depAGit ||
    depBCompileEntry?.source?.git !== depBGit
  ) {
    throw new Error(
      "Expected same-name/different-source pins to be preserved in compiler package groups"
    );
  }

  console.log("[OK] v4 same-name/different-source package IDs are preserved");
}

const systemGit = "https://example.com/system.git";
const systemRev = "rev-system";
const systemMoveToml = `
[package]
name = "SuiSystem"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false
published-at = "0x3"
`;
const explicitSystemRootMoveToml = `
[package]
name = "App"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[dependencies]
SystemAlias = { git = "${systemGit}", rev = "${systemRev}", rename-from = "SuiSystem" }
`;
const explicitSystemMoveLock = `
[move]
version = 4

[pinned.mainnet.App]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${digest(explicitSystemRootMoveToml, "App")}"
deps = { SystemAlias = "SuiSystem" }

[pinned.mainnet.SuiSystem]
source = { git = "${systemGit}", rev = "${systemRev}" }
use_environment = "mainnet"
manifest_digest = "${digest(systemMoveToml, "SuiSystem")}"
deps = {}
`;

class ExplicitSystemFetcher {
  async fetch(gitUrl, rev, subdir = "") {
    if (gitUrl !== systemGit || rev !== systemRev || subdir !== "") {
      throw new Error(`Unexpected fetch: ${gitUrl} ${rev} ${subdir}`);
    }
    return {
      "Move.toml": systemMoveToml,
      "sources/system.move": "module 0x3::system {}",
    };
  }

  getResolvedSha(_gitUrl, rev) {
    return rev;
  }
}

export async function runExplicitSystemAliases() {
  const explicitSystemResolved = await resolveMovePackageDependencies({
    files: {
      "Move.toml": explicitSystemRootMoveToml,
      "Move.lock": explicitSystemMoveLock,
      "sources/root.move": "module 0x0::root {}",
    },
    network: "mainnet",
    fetcher: new ExplicitSystemFetcher(),
  });
  const explicitSystemDeps = JSON.parse(explicitSystemResolved.dependencies);
  const systemEntry = explicitSystemDeps.find(
    (dep) => dep.name === "SuiSystem"
  );
  if (!systemEntry?.rootDependencyAliases?.includes("SystemAlias")) {
    throw new Error(
      "Expected explicit root system dependency alias to reach Rust package groups"
    );
  }

  console.log(
    "[OK] v4 explicit system dependency aliases reach package groups"
  );
}

const envRootMoveToml = `
[package]
name = "EnvApp"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[addresses]
env_app = "0x0"
`;
const envOverrideMoveToml = `
[package]
name = "EnvApp"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[dependencies]
Dep = { git = "${depGit}", subdir = "${depSubdir}", rev = "${currentRev}" }

[addresses]
env_app = "0x0"
`;
const envMoveLock = `
[move]
version = 4

[pinned.mainnet.EnvApp]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${digest(envOverrideMoveToml, "EnvApp")}"
deps = { Dep = "Dep" }

[pinned.mainnet.Dep]
source = { git = "${depGit}", subdir = "${depSubdir}", rev = "${currentRev}" }
use_environment = "mainnet"
manifest_digest = "${depManifestDigest}"
deps = {}
`;

export async function runEnvironmentPackageGroups() {
  const envResolved = await resolveMovePackageDependencies({
    files: {
      "Move.toml": envRootMoveToml,
      "Move.mainnet.toml": envOverrideMoveToml,
      "Move.lock": envMoveLock,
      "sources/root.move": "module 0x0::root {}",
    },
    network: "mainnet",
    fetcher: new FixtureFetcher(),
  });
  const envRootFiles = JSON.parse(envResolved.files);
  if (
    !envRootFiles["Move.toml"]?.includes("Dep") ||
    !envRootFiles["Move.toml"]?.includes(depGit)
  ) {
    throw new Error(
      "Expected Move.mainnet.toml to be selected as compiler Move.toml for V4 lockfile package groups"
    );
  }

  console.log("[OK] v4 package groups prefer Move.<env>.toml");
}
