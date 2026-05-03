import { loadWasmBindings } from "./wasm_helpers.mjs";

const api = await import(new URL("../../dist/lite/index.js", import.meta.url));

const {
  dumpMovePackage,
  initMovePackageBuilder,
  prepareMovePackagePublish,
  prepareMovePackageUpgrade,
} = api;

const supportedApi = new Set([
  "MovePackageFetcher",
  "GitHubMovePackageFetcher",
  "dumpMovePackage",
  "fetchMovePackageFromGitHub",
  "getPinnedSuiMoveVersion",
  "getPinnedSuiVersion",
  "initMovePackageBuilder",
  "prepareMovePackagePublish",
  "prepareMovePackageUpgrade",
  "resolveMovePackageDependencies",
]);

for (const exportedName of Object.keys(api)) {
  if (!supportedApi.has(exportedName)) {
    throw new Error(`Unexpected public export: ${exportedName}`);
  }
}

await initMovePackageBuilder();

function fixtureFiles({ publishedAt = "0x0", address = publishedAt } = {}) {
  const publishedLine =
    publishedAt === "0x0" ? "" : `published-at = "${publishedAt}"`;
  return {
    "Move.toml": `
[package]
name = "IntentFixture"
version = "0.0.0"
edition = "2024"
${publishedLine}

[addresses]
intent_fixture = "${address}"
`,
    "sources/main.move": `
module intent_fixture::main {
    public fun value(): u64 { 1 }
}
`,
  };
}

function resolvedDependencies(files) {
  const frameworkDeps = [
    frameworkPackage("MoveStdlib", "std", "../move-stdlib"),
    frameworkPackage("Sui", "sui", "../sui"),
  ];
  return {
    files: JSON.stringify(files),
    dependencies: JSON.stringify(frameworkDeps),
    lockfileDependencies: JSON.stringify(frameworkDeps),
  };
}

function frameworkPackage(id, addressName, localPath) {
  return {
    name: id,
    files: {
      [`dependencies/${id}/Move.toml`]: `
[package]
name = "${id}"
version = "0.0.0"
edition = "2024"
published-at = "${id === "Sui" ? "0x2" : "0x1"}"

[addresses]
${addressName} = "${id === "Sui" ? "0x2" : "0x1"}"
`,
    },
    edition: "2024",
    addressMapping: {
      [id]: id === "Sui" ? "0x2" : "0x1",
      [addressName]: id === "Sui" ? "0x2" : "0x1",
    },
    source: { type: "local", local: localPath },
    manifestDeps: [],
    manifest: {
      name: id,
      dependencies: {},
    },
  };
}

function baseInput(files, extra = {}) {
  return {
    files,
    network: "mainnet",
    resolvedDependencies: resolvedDependencies(files),
    ...extra,
  };
}

function expectSuccess(result, label) {
  if ("error" in result) {
    throw new Error(`${label} should succeed: ${result.error}`);
  }
}

function expectValidationFailure(result, label) {
  if (!("error" in result)) {
    throw new Error(`${label} should fail`);
  }
  if (result.category !== "input_validation") {
    throw new Error(
      `${label} should fail with input_validation, got ${result.category}`
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

function rawCompile(mod, files, intent) {
  const resolved = resolvedDependencies(files);
  return expectRawCompileSuccess(
    mod.compile(
      resolved.files,
      resolved.dependencies,
      JSON.stringify({ compileIntent: intent })
    ),
    `raw ${intent} compile`
  );
}

const unpublishedFiles = fixtureFiles();
const dumpResult = await dumpMovePackage(baseInput(unpublishedFiles));
expectSuccess(dumpResult, "dumpMovePackage");
if (dumpResult.intent !== "dump") {
  throw new Error(`dump intent mismatch: ${dumpResult.intent}`);
}

const publishResult = await prepareMovePackagePublish(
  baseInput(unpublishedFiles)
);
expectSuccess(publishResult, "prepareMovePackagePublish");
if (publishResult.intent !== "publish") {
  throw new Error(`publish intent mismatch: ${publishResult.intent}`);
}

const nonZeroRootFiles = fixtureFiles({
  publishedAt: "0x0",
  address: "0x456",
});
const nonZeroRootDumpResult = await dumpMovePackage(
  baseInput(nonZeroRootFiles)
);
expectSuccess(nonZeroRootDumpResult, "non-zero root dumpMovePackage");
const nonZeroRootPublishResult = await prepareMovePackagePublish(
  baseInput(nonZeroRootFiles)
);
expectSuccess(
  nonZeroRootPublishResult,
  "non-zero root prepareMovePackagePublish"
);
if (nonZeroRootPublishResult.intent !== "publish") {
  throw new Error(
    `non-zero root publish intent mismatch: ${nonZeroRootPublishResult.intent}`
  );
}

const publishedFiles = fixtureFiles({ publishedAt: "0x123" });
const publishedPublishResult = await prepareMovePackagePublish(
  baseInput(publishedFiles)
);
expectValidationFailure(publishedPublishResult, "published root publish");

const publishedDumpResult = await dumpMovePackage(baseInput(publishedFiles));
expectSuccess(publishedDumpResult, "published root dumpMovePackage");

const upgradeResult = await prepareMovePackageUpgrade(
  baseInput(publishedFiles)
);
expectSuccess(upgradeResult, "prepareMovePackageUpgrade");
if (upgradeResult.intent !== "upgrade") {
  throw new Error(`upgrade intent mismatch: ${upgradeResult.intent}`);
}
if (
  upgradeResult.packageId !==
  "0x0000000000000000000000000000000000000000000000000000000000000123"
) {
  throw new Error(`upgrade packageId mismatch: ${upgradeResult.packageId}`);
}
if (upgradeResult.modules[0] !== publishedDumpResult.modules[0]) {
  throw new Error("upgrade intent should compile the root package as 0x0");
}

const wasm = await loadWasmBindings("full");
const rawDumpResult = rawCompile(wasm, publishedFiles, "dump");
const rawPublishResult = rawCompile(wasm, publishedFiles, "publish");
const rawUpgradeResult = rawCompile(wasm, publishedFiles, "upgrade");
if (rawPublishResult.modules[0] === rawDumpResult.modules[0]) {
  throw new Error("raw publish intent should keep the published root address");
}
if (rawUpgradeResult.modules[0] !== rawDumpResult.modules[0]) {
  throw new Error("raw upgrade intent should compile the root package as 0x0");
}

const mismatchUpgradeResult = await prepareMovePackageUpgrade(
  baseInput(publishedFiles, { packageId: "0x456" })
);
expectValidationFailure(mismatchUpgradeResult, "mismatched upgrade packageId");

const missingUpgradeResult = await prepareMovePackageUpgrade(
  baseInput(unpublishedFiles)
);
expectValidationFailure(missingUpgradeResult, "unpublished root upgrade");

console.log("[OK] intent APIs expose dump/publish/upgrade preparation");
