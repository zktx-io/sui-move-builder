import { loadWasmBindings } from "./wasm_helpers.mjs";

const {
  dumpMovePackage,
  initMovePackageBuilder,
  prepareMovePackageUpgrade,
  resolveMovePackageDependencies,
} = await import(new URL("../../dist/full/index.js", import.meta.url));

await initMovePackageBuilder();

function expectSuccess(result, label) {
  if ("error" in result) {
    throw new Error(`${label} should succeed: ${result.error}`);
  }
}

function expectFailure(result, label, category) {
  if (!("error" in result)) {
    throw new Error(`${label} should fail`);
  }
  if (category && result.category !== category) {
    throw new Error(
      `${label} should fail with ${category}, got ${result.category}`
    );
  }
}

function expectRawCompileSuccess(result, label) {
  const success =
    typeof result.success === "function" ? result.success() : result.success;
  const output =
    typeof result.output === "function" ? result.output() : result.output;
  if (!success) {
    throw new Error(`${label} should succeed: ${output}`);
  }
  return JSON.parse(output);
}

function rawCompile(mod, files, resolvedDependencies, intent) {
  return expectRawCompileSuccess(
    mod.compile(
      resolvedDependencies.files,
      resolvedDependencies.dependencies,
      JSON.stringify({ compileIntent: intent })
    ),
    `raw ${intent} compile`
  );
}

function depGroup({
  name,
  files,
  addressMapping,
  publishedIdForOutput,
  localPath,
}) {
  return {
    name,
    files: Object.fromEntries(
      Object.entries(files).map(([file, content]) => [
        `dependencies/${name}/${file}`,
        content,
      ])
    ),
    edition: "2024",
    ...(addressMapping ? { addressMapping } : {}),
    ...(publishedIdForOutput ? { publishedIdForOutput } : {}),
    source: { type: "local", local: localPath ?? `../${name}` },
    manifestDeps: [],
    manifest: { name, dependencies: {} },
  };
}

function frameworkPackage(id, addressName, localPath) {
  const publishedAt = id === "Sui" ? "0x2" : "0x1";
  return depGroup({
    name: id,
    files: frameworkFiles(id, addressName, publishedAt),
    addressMapping: {
      [id]: publishedAt,
      [addressName]: publishedAt,
    },
    publishedIdForOutput: publishedAt,
    localPath,
  });
}

function frameworkFiles(id, addressName, publishedAt) {
  const dependencies =
    id === "Sui"
      ? `
[dependencies]
MoveStdlib = { local = "../move-stdlib" }
`
      : "";
  return {
    "Move.toml": `
[package]
name = "${id}"
version = "0.0.0"
edition = "2024"
published-at = "${publishedAt}"
${dependencies}

[addresses]
${addressName} = "${publishedAt}"
`,
    "sources/dummy.move": `
module ${addressName}::dummy {
    public fun value(): u64 { 0 }
}
`,
  };
}

function frameworkDeps() {
  return [
    frameworkPackage("MoveStdlib", "std", "../move-stdlib"),
    frameworkPackage("Sui", "sui", "../sui"),
  ];
}

function resolvedDependenciesFor(files, dependencies) {
  const encoded = JSON.stringify([...dependencies, ...frameworkDeps()]);
  return {
    files: JSON.stringify(files),
    dependencies: encoded,
    lockfileDependencies: encoded,
  };
}

function normalizedAddress(value) {
  return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function hasAddress(values, address) {
  const expected = normalizedAddress(address);
  return values.some((value) => normalizedAddress(value) === expected);
}

const unpublishedDepFiles = {
  "Move.toml": `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"

[addresses]
dep = "_"
`,
  "sources/dep.move": `
module dep::dep {
    public fun value(): u64 { 7 }
}
`,
};

const unpublishedRootFiles = {
  "Move.toml": `
[package]
name = "UnpublishedRoot"
version = "0.0.0"
edition = "2024"

[addresses]
unpublished_root = "0x0"

[dependencies]
Dep = { local = "../dep" }
`,
  "sources/main.move": `
module unpublished_root::main {
    public fun value(): u64 { dep::dep::value() }
}
`,
};

const unpublishedResolved = resolvedDependenciesFor(unpublishedRootFiles, [
  depGroup({
    name: "Dep",
    files: unpublishedDepFiles,
    localPath: "../dep",
  }),
]);

const unpublishedDefaultResult = await dumpMovePackage({
  files: unpublishedRootFiles,
  resolvedDependencies: unpublishedResolved,
});
expectFailure(
  unpublishedDefaultResult,
  "dump without withUnpublishedDependencies",
  "compile"
);

const unpublishedEnabledResult = await dumpMovePackage({
  files: unpublishedRootFiles,
  resolvedDependencies: unpublishedResolved,
  withUnpublishedDependencies: true,
});
expectSuccess(
  unpublishedEnabledResult,
  "dump with withUnpublishedDependencies"
);
if (hasAddress(unpublishedEnabledResult.dependencies, "0x0")) {
  throw new Error("zero unpublished dependency ID should not be emitted");
}

const publishedRootFiles = {
  "Move.toml": `
[package]
name = "IntentOptions"
version = "0.0.0"
edition = "2024"
published-at = "0x123"

[addresses]
intent_options = "0x123"
`,
  "sources/main.move": `
module intent_options::main {
    public fun value(): u64 { 1 }
}
`,
};
const publishedResolved = resolvedDependenciesFor(publishedRootFiles, []);
const dumpResult = await dumpMovePackage({
  files: publishedRootFiles,
  resolvedDependencies: publishedResolved,
});
const upgradeResult = await prepareMovePackageUpgrade({
  files: publishedRootFiles,
  resolvedDependencies: publishedResolved,
});
const wasm = await loadWasmBindings("full");
const publishResult = rawCompile(
  wasm,
  publishedRootFiles,
  publishedResolved,
  "publish"
);
expectSuccess(dumpResult, "dump root_as_zero");
expectSuccess(upgradeResult, "upgrade root_as_zero");
if (dumpResult.modules[0] !== upgradeResult.modules[0]) {
  throw new Error("dump and upgrade should compile root as 0x0");
}
if (dumpResult.modules[0] === publishResult.modules[0]) {
  throw new Error("publish should keep the root address");
}

const modeDepFiles = {
  "Move.toml": `
[package]
name = "mode_dep"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false
published-at = "0x42"
`,
  "sources/dep.move": `
module 0x42::fixture {
    public fun value(): u64 { 42 }
}
`,
};

const modeRootFiles = {
  "Move.toml": `
[package]
name = "sui_mode_fixture"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[dependencies]
mode_dep = { local = "../mode-dep", modes = ["custom"] }
`,
  "sources/main.move": `
module 0x0::main {
    public fun base(): u64 { 1 }

    #[mode(custom)]
    public fun selected(): u64 { mode_dep::fixture::value() }
}
`,
};

const modeFetcher = {
  async fetch() {
    throw new Error("unexpected git fetch");
  },
  async fetchLocal(localPath) {
    if (localPath === "../mode-dep") {
      return modeDepFiles;
    }
    throw new Error(`unexpected local fetch: ${localPath}`);
  },
  async fetchFile() {
    return null;
  },
  getResolvedSha() {
    return undefined;
  },
};

const noModeResolved = await resolveMovePackageDependencies({
  files: modeRootFiles,
  fetcher: modeFetcher,
});
const noModeDeps = JSON.parse(noModeResolved.dependencies);
if (noModeDeps.some((dep) => dep.name === "mode_dep")) {
  throw new Error("mode dependency should be filtered without matching mode");
}
const noModeLockfileDeps = JSON.parse(noModeResolved.lockfileDependencies);
if (!noModeLockfileDeps.some((dep) => dep.name === "mode_dep")) {
  throw new Error("mode dependency should remain in lockfile dependencies");
}
const noModeBuild = await dumpMovePackage({
  files: modeRootFiles,
  fetcher: modeFetcher,
});
expectSuccess(noModeBuild, "build without custom mode");
if (hasAddress(noModeBuild.dependencies, "0x42")) {
  throw new Error("inactive mode dependency should not be emitted");
}
if (!noModeBuild.moveLock.includes('mode_dep = "mode_dep"')) {
  throw new Error(
    "inactive mode dependency should remain in generated Move.lock"
  );
}

const customModeResolved = await resolveMovePackageDependencies({
  files: modeRootFiles,
  fetcher: modeFetcher,
  modes: ["custom"],
});
const customModeDeps = JSON.parse(customModeResolved.dependencies);
if (!customModeDeps.some((dep) => dep.name === "mode_dep")) {
  throw new Error("mode dependency should be included with matching mode");
}
const customModeBuild = await dumpMovePackage({
  files: modeRootFiles,
  fetcher: modeFetcher,
  modes: ["custom"],
});
expectSuccess(customModeBuild, "build with custom mode");
if (!hasAddress(customModeBuild.dependencies, "0x42")) {
  throw new Error("active mode dependency should be emitted");
}

console.log("[OK] build options match current CLI BuildConfig semantics");
