const { initMovePackageBuilder, testMovePackage } = await import(
  new URL("../../dist/full/index.js", import.meta.url)
);

await initMovePackageBuilder();

const STD_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

const files = {
  "Move.toml": `
[package]
name = "Root"
version = "0.0.0"
edition = "2024"

[addresses]
root = "0x0"
`,
  "sources/root.move": `
module root::main {
    #[mode(custom)]
    fun helper(): u64 { 1 }

    #[test]
    public fun custom_mode_test() {
        assert!(helper() == 1, 0);
    }
}
`,
};

const moveStdlib = {
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
    "dependencies/MoveStdlib/sources/unit_test.move": `
#[test_only]
module std::unit_test;

public native fun poison();
public native fun destroy<T>(v: T);
`,
  },
  edition: "2024",
  addressMapping: {
    std: STD_ID,
    MoveStdlib: STD_ID,
  },
  publishedIdForOutput: STD_ID,
  source: {
    type: "system",
    system: "std",
  },
  manifestDeps: [],
  manifest: {
    name: "MoveStdlib",
    dependencies: {},
  },
  rootDependencyAliases: [],
};

function resolvedDependencies() {
  return {
    files: JSON.stringify(files),
    dependencies: JSON.stringify([moveStdlib]),
    lockfileDependencies: JSON.stringify([moveStdlib]),
  };
}

const noModeResult = await testMovePackage({
  files,
  network: "mainnet",
  resolvedDependencies: resolvedDependencies(),
});
if ("error" in noModeResult) {
  throw new Error(noModeResult.error);
}
if (noModeResult.passed) {
  throw new Error("custom-mode helper test should fail without custom mode");
}
if (!/helper|unbound|Unable to resolve/i.test(noModeResult.output)) {
  throw new Error(
    `Expected unresolved custom-mode helper diagnostic:\n${noModeResult.output}`
  );
}

const customModeResult = await testMovePackage({
  files,
  network: "mainnet",
  resolvedDependencies: resolvedDependencies(),
  modes: ["custom"],
});
if ("error" in customModeResult) {
  throw new Error(customModeResult.error);
}
if (!customModeResult.passed) {
  throw new Error(
    `custom-mode helper test should pass with custom mode:\n${customModeResult.output}`
  );
}
if (!customModeResult.output.includes("root::main::custom_mode_test")) {
  throw new Error(
    `Expected custom-mode test name in output:\n${customModeResult.output}`
  );
}

console.log("[OK] unit test modes match compiler mode selection");
