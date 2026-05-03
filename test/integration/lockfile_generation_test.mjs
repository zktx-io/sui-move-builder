import { loadWasmBindings } from "./wasm_helpers.mjs";

const { initMovePackageBuilder, dumpMovePackage } = await import(
  new URL("../../dist/full/index.js", import.meta.url)
);

await initMovePackageBuilder();
const wasm = await loadWasmBindings("full");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function section(lockfile, header) {
  const match = lockfile.match(
    new RegExp(`\\[${escapeRegExp(header)}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`)
  );
  if (!match) {
    throw new Error(`Missing lockfile section [${header}]`);
  }
  return match[1];
}

function digest(moveToml, packageName, environment) {
  return wasm.compute_manifest_digest_from_move_toml(
    moveToml,
    packageName,
    environment
  );
}

function rootFiles({
  packageName = "Root",
  addressName = "root",
  dependencies = "",
  networkToml,
  moveLock,
} = {}) {
  const files = {
    "Move.toml": `
[package]
name = "${packageName}"
version = "0.0.0"
edition = "2024"
${dependencies}

[addresses]
${addressName} = "${packageName === "Sui" ? "0x2" : "0x0"}"
`,
    [`sources/${addressName}.move`]: `
module ${addressName}::main {
    public fun ok() {}
}
`,
  };
  if (networkToml) {
    files["Move.testnet.toml"] = networkToml;
  }
  if (moveLock) {
    files["Move.lock"] = moveLock;
  }
  return files;
}

function packageGroup({
  id,
  manifestName = id,
  addressName = manifestName.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
  source = { type: "local", local: `../${id.toLowerCase()}` },
  dependencies = "",
  depAliasToPackageName,
}) {
  const moveToml = `
[package]
name = "${manifestName}"
version = "0.0.0"
edition = "2024"
${dependencies}

[addresses]
${addressName} = "0x0"
`;
  return {
    name: id,
    files: {
      [`dependencies/${id}/Move.toml`]: moveToml,
    },
    edition: "2024",
    addressMapping: {
      [manifestName]: "0x0",
      [addressName]: "0x0",
    },
    source,
    manifestDeps: [],
    manifest: {
      name: manifestName,
      dependencies: {},
    },
    depAliasToPackageName,
  };
}

function frameworkDeps() {
  return [
    packageGroup({
      id: "MoveStdlib",
      manifestName: "MoveStdlib",
      addressName: "std",
      source: { type: "local", local: "../move-stdlib" },
    }),
    packageGroup({
      id: "Sui",
      manifestName: "Sui",
      addressName: "sui",
      source: { type: "local", local: "../sui" },
    }),
  ];
}

async function buildWith(files, deps, network = "mainnet") {
  return dumpMovePackage({
    files,
    network,
    resolvedDependencies: {
      files: JSON.stringify(files),
      dependencies: JSON.stringify(deps),
      lockfileDependencies: JSON.stringify(deps),
    },
  });
}

function assertOk(result, label) {
  if ("error" in result) {
    throw new Error(`${label}: ${result.error}`);
  }
  return result;
}

function assertError(
  result,
  pattern,
  label,
  category = "lockfile_generation",
  code
) {
  if (!("error" in result)) {
    throw new Error(`${label}: expected error`);
  }
  if (!pattern.test(result.error)) {
    throw new Error(`${label}: unexpected error '${result.error}'`);
  }
  if (result.category !== category) {
    throw new Error(
      `${label}: expected category ${category}, got ${result.category}`
    );
  }
  if (code && result.code !== code) {
    throw new Error(`${label}: expected code ${code}, got ${result.code}`);
  }
}

const testnetRootToml = `
[package]
name = "Root"
version = "0.0.0"
edition = "2024"

[dependencies]
Dep = { local = "../dep" }

[addresses]
root = "0x0"
`;
const envFiles = rootFiles({ networkToml: testnetRootToml });
const envResult = assertOk(
  await buildWith(
    envFiles,
    [
      packageGroup({ id: "Dep", source: { type: "local", local: "../dep" } }),
      ...frameworkDeps(),
    ],
    "testnet"
  ),
  "Move.<env>.toml precedence"
);
const envRootSection = section(envResult.moveLock, "pinned.testnet.Root");
if (
  !envRootSection.includes(
    `manifest_digest = "${digest(testnetRootToml, "Root", "testnet")}"`
  )
) {
  throw new Error("Expected generated lockfile to digest Move.testnet.toml");
}
if (!envRootSection.includes('deps = { Dep = "Dep"')) {
  throw new Error("Expected generated lockfile to include testnet dependency");
}

console.log("[OK] V4 lockfile generation honors Move.<env>.toml");

const existingLockfile = `
[move]
version = 4

[pinned.mainnet.OldRoot]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "old"
deps = {}

[pinned.devnet.Other]
source = { local = "../other" }
use_environment = "devnet"
manifest_digest = "other"
deps = {}
`;
const preservedResult = assertOk(
  await buildWith(
    rootFiles({ moveLock: existingLockfile }),
    frameworkDeps(),
    "mainnet"
  ),
  "other environment preservation"
);
if (!preservedResult.moveLock.includes("[pinned.devnet.Other]")) {
  throw new Error("Expected other pinned environments to be preserved");
}
if (preservedResult.moveLock.includes("[pinned.mainnet.OldRoot]")) {
  throw new Error("Expected current environment pins to be regenerated");
}

const malformedResult = await buildWith(
  rootFiles({ moveLock: "[move\nversion = 4" }),
  frameworkDeps(),
  "mainnet"
);
assertError(
  malformedResult,
  /Failed to parse Move\.lock/,
  "malformed existing lockfile",
  "lockfile_generation",
  "malformed_lockfile"
);

console.log(
  "[OK] V4 lockfile generation preserves other environments strictly"
);

const depAGit = "https://example.com/dep-a.git";
const depBGit = "https://example.com/dep-b.git";
const sameNameResult = assertOk(
  await buildWith(
    rootFiles({
      dependencies: `
[dependencies]
DepA = { git = "${depAGit}", rev = "rev-a" }
DepB = { git = "${depBGit}", rev = "rev-b" }
`,
    }),
    [
      packageGroup({
        id: "Dep",
        manifestName: "Dep",
        source: { type: "git", git: depAGit, rev: "rev-a", subdir: "" },
      }),
      packageGroup({
        id: "Dep_1",
        manifestName: "Dep",
        source: { type: "git", git: depBGit, rev: "rev-b", subdir: "" },
      }),
      ...frameworkDeps(),
    ],
    "mainnet"
  ),
  "same-name dependency generation"
);
const sameNameRootSection = section(
  sameNameResult.moveLock,
  "pinned.mainnet.Root"
);
if (
  !sameNameRootSection.includes('DepA = "Dep"') ||
  !sameNameRootSection.includes('DepB = "Dep_1"')
) {
  throw new Error("Expected same-name dependency pins to preserve package ids");
}

console.log("[OK] V4 lockfile generation preserves same-name package ids");

const inactiveModeResult = assertOk(
  await buildWith(
    rootFiles({
      dependencies: `
[dependencies]
ModeDep = { local = "../mode-dep", modes = ["custom"] }
`,
    }),
    [
      packageGroup({
        id: "ModeDep",
        manifestName: "ModeDep",
        addressName: "mode_dep",
        source: { type: "local", local: "../mode-dep" },
      }),
      ...frameworkDeps(),
    ],
    "mainnet"
  ),
  "inactive mode dependency generation"
);
const inactiveModeRootSection = section(
  inactiveModeResult.moveLock,
  "pinned.mainnet.Root"
);
if (!inactiveModeRootSection.includes('ModeDep = "ModeDep"')) {
  throw new Error("Expected inactive mode dependency to remain in Move.lock");
}

console.log("[OK] V4 lockfile generation records inactive mode deps");

const missingImplicitResult = await buildWith(rootFiles(), [], "mainnet");
assertError(
  missingImplicitResult,
  /implicit dependency 'sui'/,
  "missing implicit framework packages"
);

const suiRootResult = assertOk(
  await buildWith(
    rootFiles({ packageName: "Sui", addressName: "sui" }),
    [],
    "mainnet"
  ),
  "system package root generation"
);
if (
  !section(suiRootResult.moveLock, "pinned.mainnet.Sui").includes("deps = {}")
) {
  throw new Error("Expected system package root to avoid implicit deps");
}

console.log(
  "[OK] V4 lockfile generation handles implicit system deps strictly"
);

const unsupportedSourceResult = await buildWith(
  rootFiles({
    dependencies: `
[dependencies]
Dep = { local = "../dep" }
`,
  }),
  [
    packageGroup({
      id: "Dep",
      source: { type: "onchain", address: "0x123" },
    }),
  ],
  "mainnet"
);
assertError(
  unsupportedSourceResult,
  /Invalid lockfile V4 generation input|unsupported/,
  "unsupported lockfile source"
);

console.log("[OK] V4 lockfile generation rejects unsupported sources");
