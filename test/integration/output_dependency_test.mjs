const { initMoveCompiler, buildMovePackage } = await import(
  new URL("../../dist/full/index.js", import.meta.url)
);

await initMoveCompiler();

const BRIDGE_ID =
  "0x000000000000000000000000000000000000000000000000000000000000000b";
const SUI_SYSTEM_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000003";
const ZERO_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const ALPHA_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000022";
const ZED_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000011";

const bridgeSource = {
  type: "git",
  git: "https://github.com/MystenLabs/sui.git",
  rev: "fixture",
  subdir: "crates/sui-framework/packages/bridge",
};

const suiSystemSource = {
  type: "git",
  git: "https://github.com/MystenLabs/sui.git",
  rev: "fixture",
  subdir: "crates/sui-framework/packages/sui-system",
};

function rootFiles(dependencySection = "") {
  return {
    "Move.toml": `
[package]
name = "Root"
version = "0.0.0"
edition = "2024"
${dependencySection}

[addresses]
root = "0x0"
`,
    "sources/root.move": `
module root::main {
    public fun ok() {}
}
`,
  };
}

function packageDependency({
  packageName,
  namedAddress,
  id,
  source,
  rootDependencyAliases = [],
}) {
  return {
    name: packageName,
    files: {
      [`dependencies/${packageName}/Move.toml`]: `
[package]
name = "${packageName}"
version = "0.0.0"
published-at = "${id}"
edition = "2024"

[addresses]
${namedAddress} = "${id}"
`,
      [`dependencies/${packageName}/sources/${namedAddress}.move`]: `
module ${namedAddress}::fixture {
    public fun ok() {}
}
`,
    },
    edition: "2024",
    addressMapping: {
      [packageName]: id,
      [namedAddress]: id,
    },
    publishedIdForOutput: id,
    source,
    manifestDeps: [],
    manifest: {
      name: packageName,
      dependencies: {},
    },
    rootDependencyAliases,
  };
}

function bridgeDependency(rootDependencyAliases = []) {
  return packageDependency({
    packageName: "Bridge",
    namedAddress: "bridge",
    id: BRIDGE_ID,
    source: bridgeSource,
    rootDependencyAliases,
  });
}

function suiSystemDependency(rootDependencyAliases = []) {
  return packageDependency({
    packageName: "SuiSystem",
    namedAddress: "sui_system",
    id: SUI_SYSTEM_ID,
    source: suiSystemSource,
    rootDependencyAliases,
  });
}

function unpublishedDependency() {
  return packageDependency({
    packageName: "Unpublished",
    namedAddress: "unpublished",
    id: ZERO_ID,
    source: { type: "local", local: "../unpublished" },
  });
}

function alphaDependency() {
  return packageDependency({
    packageName: "Alpha",
    namedAddress: "alpha",
    id: ALPHA_ID,
    source: { type: "local", local: "../alpha" },
  });
}

function zedDependency() {
  return packageDependency({
    packageName: "Zed",
    namedAddress: "zed",
    id: ZED_ID,
    source: { type: "local", local: "../zed" },
  });
}

function frameworkLockfileDependencies() {
  return [
    packageDependency({
      packageName: "MoveStdlib",
      namedAddress: "std",
      id: "0x1",
      source: { type: "local", local: "../move-stdlib" },
    }),
    packageDependency({
      packageName: "Sui",
      namedAddress: "sui",
      id: "0x2",
      source: { type: "local", local: "../sui" },
    }),
  ];
}

async function buildWithDependencies(files, dependencies) {
  return buildMovePackage({
    files,
    network: "mainnet",
    resolvedDependencies: {
      files: JSON.stringify(files),
      dependencies: JSON.stringify(dependencies),
      lockfileDependencies: JSON.stringify([
        ...dependencies,
        ...frameworkLockfileDependencies(),
      ]),
    },
  });
}

async function buildWithBridge(files, rootDependencyAliases = []) {
  return buildWithDependencies(files, [
    bridgeDependency(rootDependencyAliases),
  ]);
}

function normalizedDeps(result) {
  if ("error" in result) {
    throw new Error(result.error);
  }
  return result.dependencies.map((dep) => dep.toLowerCase());
}

const implicitResult = await buildWithBridge(rootFiles());
if (normalizedDeps(implicitResult).includes(BRIDGE_ID)) {
  throw new Error("Implicit Bridge dependency should be omitted from output");
}

const explicitAliasResult = await buildWithBridge(
  rootFiles(`
[dependencies]
MyBridge = { git = "${bridgeSource.git}", subdir = "${bridgeSource.subdir}", rev = "${bridgeSource.rev}" }
`),
  ["MyBridge"]
);

if (!normalizedDeps(explicitAliasResult).includes(BRIDGE_ID)) {
  throw new Error("Explicit Bridge dependency alias should be kept in output");
}

const implicitSuiSystemResult = await buildWithDependencies(rootFiles(), [
  suiSystemDependency(),
]);
if (normalizedDeps(implicitSuiSystemResult).includes(SUI_SYSTEM_ID)) {
  throw new Error(
    "Implicit SuiSystem dependency should be omitted from output"
  );
}

const explicitSuiSystemResult = await buildWithDependencies(
  rootFiles(`
[dependencies]
SystemAlias = { git = "${suiSystemSource.git}", subdir = "${suiSystemSource.subdir}", rev = "${suiSystemSource.rev}" }
`),
  [suiSystemDependency(["SystemAlias"])]
);
if (!normalizedDeps(explicitSuiSystemResult).includes(SUI_SYSTEM_ID)) {
  throw new Error(
    "Explicit SuiSystem dependency alias should be kept in output"
  );
}

const unpublishedResult = await buildWithDependencies(rootFiles(), [
  unpublishedDependency(),
]);
if (normalizedDeps(unpublishedResult).includes(ZERO_ID)) {
  throw new Error("Zero-address dependency should be omitted from output");
}

const orderedResult = await buildWithDependencies(rootFiles(), [
  zedDependency(),
  alphaDependency(),
]);
const orderedDeps = normalizedDeps(orderedResult);
const alphaIndex = orderedDeps.indexOf(ALPHA_ID);
const zedIndex = orderedDeps.indexOf(ZED_ID);
if (alphaIndex === -1 || zedIndex === -1 || alphaIndex > zedIndex) {
  throw new Error("Published dependency IDs should be ordered by package name");
}

console.log("[OK] Rust-owned output dependency filtering and ordering");
