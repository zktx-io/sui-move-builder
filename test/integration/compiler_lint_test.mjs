const { initMovePackageBuilder, dumpMovePackage } = await import(
  new URL("../../dist/full/index.js", import.meta.url)
);

await initMovePackageBuilder();

const files = {
  "Move.toml": `
[package]
name = "LintFixture"
version = "0.0.0"
edition = "2024"

[addresses]
lint_fixture = "0x42"
`,
  "sources/lint_fixture.move": `
module lint_fixture::main {
    public fun has_all_lint_warning() {
        while (true) { break }
    }
}
`,
};

function frameworkLockfileDependencies() {
  return [
    {
      name: "MoveStdlib",
      files: {
        "dependencies/MoveStdlib/Move.toml": `
[package]
name = "MoveStdlib"
version = "0.0.0"
published-at = "0x1"
edition = "2024"

[addresses]
std = "0x1"
`,
      },
      edition: "2024",
      addressMapping: {
        std: "0x1",
        MoveStdlib:
          "0x0000000000000000000000000000000000000000000000000000000000000001",
      },
      publishedIdForOutput:
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      source: { type: "local", local: "../move-stdlib" },
      manifestDeps: [],
      manifest: { name: "MoveStdlib", dependencies: {} },
      rootDependencyAliases: [],
    },
    {
      name: "Sui",
      files: {
        "dependencies/Sui/Move.toml": `
[package]
name = "Sui"
version = "0.0.0"
published-at = "0x2"
edition = "2024"

[addresses]
sui = "0x2"
`,
      },
      edition: "2024",
      addressMapping: {
        sui: "0x2",
        Sui: "0x0000000000000000000000000000000000000000000000000000000000000002",
      },
      publishedIdForOutput:
        "0x0000000000000000000000000000000000000000000000000000000000000002",
      source: { type: "local", local: "../sui" },
      manifestDeps: [],
      manifest: { name: "Sui", dependencies: {} },
      rootDependencyAliases: [],
    },
  ];
}

async function buildWithLintFlag(lintFlag) {
  return dumpMovePackage({
    files,
    network: "mainnet",
    lintFlag,
    resolvedDependencies: {
      files: JSON.stringify(files),
      dependencies: JSON.stringify([]),
      lockfileDependencies: JSON.stringify(frameworkLockfileDependencies()),
    },
  });
}

const noneResult = await buildWithLintFlag("none");
if ("error" in noneResult) {
  throw new Error(`lintFlag=none should compile: ${noneResult.error}`);
}
if (noneResult.warnings) {
  throw new Error(
    `lintFlag=none should not emit lint warnings:\n${noneResult.warnings}`
  );
}

const defaultResult = await buildWithLintFlag("default");
if ("error" in defaultResult) {
  throw new Error(`lintFlag=default should compile: ${defaultResult.error}`);
}

const allResult = await buildWithLintFlag("all");
if ("error" in allResult) {
  throw new Error(`lintFlag=all should compile: ${allResult.error}`);
}
if (!allResult.warnings?.includes("unnecessary 'while (true)'")) {
  throw new Error(
    `lintFlag=all should emit regular Move lint warning, got:\n${allResult.warnings || ""}`
  );
}

const invalidResult = await buildWithLintFlag("strict");
if (!("error" in invalidResult)) {
  throw new Error("Invalid lintFlag should fail");
}
if (!invalidResult.error.includes("Invalid lintFlag")) {
  throw new Error(`Unexpected invalid lintFlag error: ${invalidResult.error}`);
}
if (invalidResult.category !== "compile") {
  throw new Error(
    `Invalid lintFlag should report compile category, got: ${invalidResult.category}`
  );
}
if (invalidResult.code !== undefined) {
  throw new Error(
    `Invalid lintFlag should not synthesize a code, got: ${invalidResult.code}`
  );
}

console.log("[OK] lintFlag configures Move compiler lint visitors");
