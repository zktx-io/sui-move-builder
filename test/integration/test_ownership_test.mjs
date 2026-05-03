const { initMovePackageBuilder, testMovePackage } = await import(
  new URL("../../dist/full/index.js", import.meta.url)
);
import { resolvedTestDependencies } from "./test_fixture_helpers.mjs";

await initMovePackageBuilder();

const DEP_ID =
  "0x000000000000000000000000000000000000000000000000000000000000cafe";

const files = {
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
    #[test]
    public fun root_test() {}
}
`,
};

const dep = {
  name: "Dep",
  files: {
    "dependencies/Dep/Move.toml": `
[package]
name = "Dep"
version = "0.0.0"
published-at = "0xcafe"
edition = "2024"

[addresses]
dep = "0xcafe"
`,
    "dependencies/Dep/tests/dep_tests.move": `
module dep::dep_tests {
    #[test]
    public fun dependency_test_should_not_run() {
        abort 42
    }
}
`,
  },
  edition: "2024",
  addressMapping: {
    Dep: DEP_ID,
    dep: DEP_ID,
  },
  publishedIdForOutput: DEP_ID,
  source: {
    type: "local",
    local: "../dep",
  },
  manifestDeps: [],
  manifest: {
    name: "Dep",
    dependencies: {},
  },
  rootDependencyAliases: ["Dep"],
};

const result = await testMovePackage({
  files,
  network: "mainnet",
  resolvedDependencies: resolvedTestDependencies(files, [dep]),
});

if ("error" in result) {
  throw new Error(result.error);
}

if (!result.passed) {
  throw new Error(
    `Dependency package tests should not run as root tests:\n${result.output}`
  );
}

if (result.output.includes("dependency_test_should_not_run")) {
  throw new Error("Dependency package test appeared in root test output");
}

if (result.output.includes("DEBUG:")) {
  throw new Error(`Test runner should not emit debug logs:\n${result.output}`);
}

console.log("[OK] dependency package tests are not run as root tests");
