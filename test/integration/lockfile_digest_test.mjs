import { loadWasmBindings } from "./wasm_helpers.mjs";

const { resolveMovePackageDependencies } = await import(
  new URL("../../dist/full/index.js", import.meta.url)
);

const wasm = await loadWasmBindings("full");
function digest(moveToml, packageName) {
  return wasm.compute_manifest_digest_from_move_toml(
    moveToml,
    packageName,
    "mainnet"
  );
}

const depGit = "https://example.com/dep.git";
const depSubdir = "";
const currentRev = "rev-new";
const staleRev = "rev-old";

// Computed with the Rust/WASM compute_manifest_digest helper for the root
// Move.toml below. Keeping this fixed lets the test isolate the dependency
// pin mismatch instead of falling back on the root pin.
const rootManifestDigest =
  "8A2CED4251918E3C036CD40CC98A4B39E4A58E7F0C47432ABF66C83AF0FA454E";
const depManifestDigest =
  "E41BBD67BE8940D26C79D78B028477EF5B33BA217A1282C78ACB344CF8A5ECF6";

const rootMoveToml = `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[dependencies]
Dep = { git = "${depGit}", subdir = "${depSubdir}", rev = "${currentRev}" }

[addresses]
sui = "0x2"
`;

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

class FixtureFetcher {
  calls = [];

  async fetch(gitUrl, rev, subdir = "") {
    this.calls.push({ gitUrl, rev, subdir });
    if (gitUrl !== depGit || subdir !== depSubdir) {
      throw new Error(`Unexpected fetch: ${gitUrl} ${rev} ${subdir}`);
    }
    return {
      "Move.toml": `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"

[addresses]
Dep = "0x0"
`,
      "sources/dep.move": "module 0x0::dep {}",
    };
  }

  getResolvedSha(_gitUrl, rev) {
    return rev;
  }
}

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
  throw new Error("Expected resolver to inspect the stale lockfile pin first");
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

console.log("[OK] stale v4 dependency manifest_digest falls back to manifest");

const malformedNoRootLock = `
[move]
version = 4

[pinned.mainnet.Dep]
source = { git = "${depGit}", subdir = "${depSubdir}", rev = "${currentRev}" }
use_environment = "mainnet"
manifest_digest = "${depManifestDigest}"
deps = {}
`;

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

const oldDepMoveToml = `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"

[addresses]
Dep = "0x0"
`;
const changedDepMoveToml = `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"

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

const changedContentRevs = changedContentFetcher.calls.map((call) => call.rev);
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
const changedContentDep = changedContentDeps.find((dep) => dep.name === "Dep");
if (changedContentDep?.source?.rev !== currentRev) {
  throw new Error(
    `Expected changed-content fallback rev ${currentRev}, got ${changedContentDep?.source?.rev}`
  );
}

console.log("[OK] v4 pin source content drift falls back to manifest");

const depAGit = "https://example.com/dep-a.git";
const depBGit = "https://example.com/dep-b.git";
const sameNameRevA = "rev-a";
const sameNameRevB = "rev-b";
const sameNameDepMoveToml = `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"

[addresses]
Dep = "0x0"
`;
const sameNameRootMoveToml = `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[dependencies]
DepA = { git = "${depAGit}", rev = "${sameNameRevA}" }
DepB = { git = "${depBGit}", rev = "${sameNameRevB}" }

[addresses]
sui = "0x2"
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
if (depAEntry?.source?.git !== depAGit || depBEntry?.source?.git !== depBGit) {
  throw new Error("Expected same-name/different-source pins to be preserved");
}
const sameNameCompileDeps = JSON.parse(sameNameResolved.dependencies);
const depACompileEntry = sameNameCompileDeps.find((dep) => dep.name === "Dep");
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

const systemGit = "https://example.com/system.git";
const systemRev = "rev-system";
const systemMoveToml = `
[package]
name = "SuiSystem"
version = "0.0.0"
edition = "2024"
published-at = "0x3"

[addresses]
sui_system = "0x3"
`;
const explicitSystemRootMoveToml = `
[package]
name = "App"
version = "0.0.0"
edition = "2024"

[dependencies]
SystemAlias = { git = "${systemGit}", rev = "${systemRev}" }

[addresses]
app = "0x0"
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
const systemEntry = explicitSystemDeps.find((dep) => dep.name === "SuiSystem");
if (!systemEntry?.rootDependencyAliases?.includes("SystemAlias")) {
  throw new Error(
    "Expected explicit root system dependency alias to reach Rust package groups"
  );
}

console.log("[OK] v4 explicit system dependency aliases reach package groups");

const envRootMoveToml = `
[package]
name = "EnvApp"
version = "0.0.0"
edition = "2024"

[addresses]
env_app = "0x0"
`;
const envOverrideMoveToml = `
[package]
name = "EnvApp"
version = "0.0.0"
edition = "2024"

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

const localRootMoveToml = `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[dependencies]
Dep = { local = "../dep" }

[addresses]
sui = "0x2"
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

class MissingMoveTomlFetcher {
  async fetch() {
    return {
      "sources/dep.move": "module 0x0::dep {}",
    };
  }
}

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

async function assertRejects(operation, pattern, message) {
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
