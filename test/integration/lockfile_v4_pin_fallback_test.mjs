import {
  assertRejects,
  currentRev,
  depGit,
  depManifestDigest,
  depSubdir,
  digest,
  fixtureDepMoveToml,
  FixtureFetcher,
  resolveMovePackageDependencies,
  rootManifestDigest,
  rootMoveToml,
  sameNameDepMoveToml,
  staleRev,
} from "./lockfile_v4_test_helpers.mjs";

const staleMoveLock = `
[move]
version = 4

[pinned.mainnet.Sui]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${rootManifestDigest}"
deps = { Dep = "Dep" }

[pinned.mainnet.Dep]
source = { git = "${depGit}", subdir = "${depSubdir}", rev = "${staleRev}" }
use_environment = "mainnet"
manifest_digest = "0000000000000000000000000000000000000000000000000000000000000000"
deps = {}
`;

export async function runStaleDigestFallback() {
  const fetcher = new FixtureFetcher();
  const resolved = await resolveMovePackageDependencies({
    files: {
      "Move.toml": rootMoveToml,
      "Move.lock": staleMoveLock,
      "sources/root.move": "module 0x2::root {}",
    },
    network: "mainnet",
    fetcher,
  });

  const fetchedRevs = fetcher.calls.map((call) => call.rev);
  if (!fetchedRevs.includes(staleRev)) {
    throw new Error(
      "Expected resolver to inspect the stale lockfile pin first"
    );
  }
  if (!fetchedRevs.includes(currentRev)) {
    throw new Error(
      "Expected resolver to reject the stale pin digest and fall back to manifest resolution"
    );
  }

  const lockfileDeps = JSON.parse(resolved.lockfileDependencies);
  const depEntry = lockfileDeps.find((dep) => dep.name === "Dep");
  if (depEntry?.source?.rev !== currentRev) {
    throw new Error(
      `Expected resolved dependency rev ${currentRev}, got ${depEntry?.source?.rev}`
    );
  }

  console.log(
    "[OK] stale v4 dependency manifest_digest falls back to manifest"
  );
}

const resolvedShaRev = "refs/tags/v1";
const resolvedSha = "resolved-sha-for-v1";
const resolvedShaRootMoveToml = `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[dependencies]
Dep = { git = "${depGit}", subdir = "${depSubdir}", rev = "${resolvedShaRev}" }

[addresses]
sui = "0x2"
`;
const resolvedShaMoveLock = `
[move]
version = 4

[pinned.mainnet.Sui]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${digest(resolvedShaRootMoveToml, "Sui")}"
deps = { Dep = "Dep" }

[pinned.mainnet.Dep]
source = { git = "${depGit}", subdir = "${depSubdir}", rev = "${resolvedShaRev}" }
use_environment = "mainnet"
manifest_digest = "${depManifestDigest}"
deps = {}
`;

class ResolvedShaFetcher {
  async fetch(gitUrl, rev, subdir = "") {
    if (gitUrl !== depGit || rev !== resolvedShaRev || subdir !== depSubdir) {
      throw new Error(`Unexpected fetch: ${gitUrl} ${rev} ${subdir}`);
    }
    return {
      "Move.toml": fixtureDepMoveToml,
      "sources/dep.move": "module 0x0::dep {}",
    };
  }

  getResolvedSha(gitUrl, rev) {
    if (gitUrl === depGit && rev === resolvedShaRev) {
      return resolvedSha;
    }
    return undefined;
  }
}

export async function runResolvedShaPin() {
  const resolvedShaResult = await resolveMovePackageDependencies({
    files: {
      "Move.toml": resolvedShaRootMoveToml,
      "Move.lock": resolvedShaMoveLock,
      "sources/root.move": "module 0x2::root {}",
    },
    network: "mainnet",
    fetcher: new ResolvedShaFetcher(),
  });
  const resolvedShaDeps = JSON.parse(resolvedShaResult.lockfileDependencies);
  const resolvedShaDep = resolvedShaDeps.find((dep) => dep.name === "Dep");
  if (resolvedShaDep?.source?.rev !== resolvedSha) {
    throw new Error(
      `Expected V4 lockfile fetch source rev ${resolvedSha}, got ${resolvedShaDep?.source?.rev}`
    );
  }

  console.log("[OK] v4 lockfile fetch records resolved git SHA");
}

const oldDepMoveToml = `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[addresses]
Dep = "0x0"
`;
const changedDepMoveToml = `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[dependencies]
Other = { local = "../other" }

[addresses]
Dep = "0x0"
`;
const contentChangedMoveLock = `
[move]
version = 4

[pinned.mainnet.Sui]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${rootManifestDigest}"
deps = { Dep = "Dep" }

[pinned.mainnet.Dep]
source = { git = "${depGit}", subdir = "${depSubdir}", rev = "${staleRev}" }
use_environment = "mainnet"
manifest_digest = "${digest(oldDepMoveToml, "Dep")}"
deps = {}
`;

class ChangedContentFetcher {
  calls = [];

  async fetch(gitUrl, rev, subdir = "") {
    this.calls.push({ gitUrl, rev, subdir });
    if (gitUrl !== depGit || subdir !== depSubdir) {
      throw new Error(`Unexpected fetch: ${gitUrl} ${rev} ${subdir}`);
    }
    const moveToml = rev === staleRev ? changedDepMoveToml : oldDepMoveToml;
    return {
      "Move.toml": moveToml,
      "sources/dep.move": "module 0x0::dep {}",
    };
  }

  getResolvedSha(_gitUrl, rev) {
    return rev;
  }
}

export async function runContentDriftFallback() {
  const changedContentFetcher = new ChangedContentFetcher();
  const changedContentResolved = await resolveMovePackageDependencies({
    files: {
      "Move.toml": rootMoveToml,
      "Move.lock": contentChangedMoveLock,
      "sources/root.move": "module 0x2::root {}",
    },
    network: "mainnet",
    fetcher: changedContentFetcher,
  });

  const changedContentRevs = changedContentFetcher.calls.map(
    (call) => call.rev
  );
  if (!changedContentRevs.includes(staleRev)) {
    throw new Error("Expected resolver to inspect the changed lockfile pin");
  }
  if (!changedContentRevs.includes(currentRev)) {
    throw new Error(
      "Expected resolver to reject changed pin content and fall back to manifest resolution"
    );
  }
  const changedContentDeps = JSON.parse(
    changedContentResolved.lockfileDependencies
  );
  const changedContentDep = changedContentDeps.find(
    (dep) => dep.name === "Dep"
  );
  if (changedContentDep?.source?.rev !== currentRev) {
    throw new Error(
      `Expected changed-content fallback rev ${currentRev}, got ${changedContentDep?.source?.rev}`
    );
  }

  console.log("[OK] v4 pin source content drift falls back to manifest");
}

const localRootMoveToml = `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[dependencies]
Dep = { local = "../dep" }
`;
const localDepMoveToml = sameNameDepMoveToml;
const localMoveLock = `
[move]
version = 4

[pinned.mainnet.Sui]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${digest(localRootMoveToml, "Sui")}"
deps = { Dep = "Dep" }

[pinned.mainnet.Dep]
source = { local = "../dep" }
use_environment = "mainnet"
manifest_digest = "${digest(localDepMoveToml, "Dep")}"
deps = {}
`;

class LocalPinFetcher {
  localCalls = [];

  async fetch(gitUrl, rev, subdir = "") {
    throw new Error(`Unexpected git fetch: ${gitUrl} ${rev} ${subdir}`);
  }

  async fetchLocal(localPath, context) {
    this.localCalls.push({ localPath, context });
    if (localPath !== "../dep") {
      throw new Error(`Unexpected local path: ${localPath}`);
    }
    return {
      "Move.toml": localDepMoveToml,
      "sources/dep.move": "module 0x0::dep {}",
    };
  }
}

export async function runLocalSourcePin() {
  const localPinFetcher = new LocalPinFetcher();
  const localResolved = await resolveMovePackageDependencies({
    files: {
      "Move.toml": localRootMoveToml,
      "Move.lock": localMoveLock,
      "sources/root.move": "module 0x2::root {}",
    },
    network: "mainnet",
    fetcher: localPinFetcher,
  });
  const localDeps = JSON.parse(localResolved.lockfileDependencies);
  const localDep = localDeps.find((dep) => dep.name === "Dep");
  if (
    localPinFetcher.localCalls.length !== 1 ||
    localDep?.source?.local !== "../dep"
  ) {
    throw new Error(
      "Expected V4 local source pin to be loaded through fetchLocal"
    );
  }

  console.log("[OK] v4 local source pins are loaded through fetchLocal");
}

class MissingMoveTomlFetcher {
  async fetch() {
    return {
      "sources/dep.move": "module 0x0::dep {}",
    };
  }
}

export async function runMissingMoveTomlSnapshot() {
  await assertRejects(
    () =>
      resolveMovePackageDependencies({
        files: {
          "Move.toml": rootMoveToml,
          "Move.lock": `
[move]
version = 4

[pinned.mainnet.Sui]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${rootManifestDigest}"
deps = { Dep = "Dep" }

[pinned.mainnet.Dep]
source = { git = "${depGit}", subdir = "${depSubdir}", rev = "${currentRev}" }
use_environment = "mainnet"
manifest_digest = "${depManifestDigest}"
deps = {}
`,
          "sources/root.move": "module 0x2::root {}",
        },
        network: "mainnet",
        fetcher: new MissingMoveTomlFetcher(),
      }),
    /did not provide Move\.toml/,
    "dependency snapshot without Move.toml should be rejected"
  );

  console.log("[OK] v4 dependency snapshot missing Move.toml is rejected");
}
