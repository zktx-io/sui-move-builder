const { initMovePackageBuilder, dumpMovePackage } = await import(
  new URL("../../dist/full/index.js", import.meta.url)
);

await initMovePackageBuilder();

const DEP_ID =
  "0x00000000000000000000000000000000000000000000000000000000000000dd";

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

function rootWithDepFiles() {
  return {
    "Move.toml": `
[package]
name = "Root"
version = "0.0.0"
edition = "2024"

[dependencies]
Dep = { local = "../dep" }

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

function depWithBadTestSource() {
  return {
    name: "Dep",
    files: {
      "dependencies/Dep/Move.toml": `
[package]
name = "Dep"
version = "0.0.0"
published-at = "0xdd"
edition = "2024"

[addresses]
dep = "0xdd"
`,
      "dependencies/Dep/sources/dep.move": `
module dep::dep {
    public fun ok() {}
}
`,
      "dependencies/Dep/tests/bad.move": "this is not valid move syntax",
    },
    edition: "2024",
    addressMapping: {
      Dep: DEP_ID,
      dep: DEP_ID,
    },
    publishedIdForOutput: DEP_ID,
    source: { type: "local", local: "../dep" },
    manifestDeps: [],
    manifest: { name: "Dep", dependencies: {} },
    rootDependencyAliases: ["Dep"],
  };
}

async function buildWithResolvedDeps(files, dependencies, options = {}) {
  return dumpMovePackage({
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
    ...options,
  });
}

const result = await dumpMovePackage({
  files: {
    "Move.toml": `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[addresses]
sui = "0x2"
`,
    "sources/main.move": `
module sui::main {
    public fun ok() {}
}
`,
    "tests/bad.move": "this is not valid move syntax",
  },
  network: "mainnet",
});

if ("error" in result) {
  throw new Error(
    `Non-test build should ignore tests/*.move, got error: ${result.error}`
  );
}

if (result.modules.length !== 1) {
  throw new Error(`Expected one root module, got ${result.modules.length}`);
}

console.log("[OK] non-test build source discovery excludes tests/*.move");

const nonTestDependencyResult = await buildWithResolvedDeps(
  rootWithDepFiles(),
  [depWithBadTestSource()]
);
if ("error" in nonTestDependencyResult) {
  throw new Error(
    `Non-test build should ignore dependency tests/*.move, got error: ${nonTestDependencyResult.error}`
  );
}

const testModeDependencyResult = await buildWithResolvedDeps(
  rootWithDepFiles(),
  [depWithBadTestSource()],
  { testMode: true }
);
if (!("error" in testModeDependencyResult)) {
  throw new Error("testMode should compile dependency tests/*.move");
}
if (
  !testModeDependencyResult.error.includes("dependencies/Dep/tests/bad.move") ||
  !testModeDependencyResult.error.includes("unexpected token")
) {
  throw new Error(
    `Expected dependency test source diagnostic, got: ${testModeDependencyResult.error}`
  );
}

console.log("[OK] test mode source discovery includes dependency tests/*.move");
