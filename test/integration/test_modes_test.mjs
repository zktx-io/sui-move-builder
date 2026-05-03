const { initMovePackageBuilder, testMovePackage } = await import(
  new URL("../../dist/full/index.js", import.meta.url)
);
import { resolvedTestDependencies } from "./test_fixture_helpers.mjs";

await initMovePackageBuilder();

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

const noModeResult = await testMovePackage({
  files,
  network: "mainnet",
  resolvedDependencies: resolvedTestDependencies(files),
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
  resolvedDependencies: resolvedTestDependencies(files),
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
