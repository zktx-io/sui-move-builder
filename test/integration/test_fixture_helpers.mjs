export const STD_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

export function moveStdlibTestDependency() {
  return {
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
}

export function resolvedTestDependencies(files, dependencies = []) {
  const encoded = JSON.stringify([moveStdlibTestDependency(), ...dependencies]);
  return {
    files: JSON.stringify(files),
    dependencies: encoded,
    lockfileDependencies: encoded,
  };
}
