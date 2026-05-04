import { readFile } from "node:fs/promises";

import init, {
  compute_manifest_digest,
  compute_manifest_digest_from_move_toml,
} from "../../dist/full/sui_move_wasm.js";

const wasmBytes = await readFile(
  new URL("../../dist/full/sui_move_wasm_bg.wasm", import.meta.url)
);
await init({ module_or_path: wasmBytes });

function digestFromJson(deps) {
  return compute_manifest_digest(JSON.stringify({ deps }));
}

function digestFromMoveToml(
  moveToml,
  packageName = "Pkg",
  environment = "mainnet"
) {
  return compute_manifest_digest_from_move_toml(
    moveToml,
    packageName,
    environment
  );
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const gitMoveToml = `
[package]
name = "Pkg"
edition = "2024"

[dependencies]
Dep = { git = "https://example.com/dep.git", subdir = "move", rev = "rev1" }
`;
assertEqual(
  digestFromMoveToml(gitMoveToml),
  digestFromJson([
    {
      name: "Dep",
      git: "https://example.com/dep.git",
      subdir: "move",
      rev: "rev1",
      use_environment: "mainnet",
    },
    {
      name: "sui",
      system: "sui",
      is_override: true,
      use_environment: "mainnet",
    },
    {
      name: "std",
      system: "std",
      is_override: true,
      use_environment: "mainnet",
    },
  ]),
  "git dependency digest should be computed from Move.toml in Rust"
);

const localMoveToml = `
[package]
name = "Pkg"
edition = "2024"

[dependencies]
LocalDep = { local = "../local-dep" }
`;
assertEqual(
  digestFromMoveToml(localMoveToml, "Pkg", "testnet"),
  digestFromJson([
    {
      name: "LocalDep",
      local: "../local-dep",
      use_environment: "testnet",
    },
    {
      name: "sui",
      system: "sui",
      is_override: true,
      use_environment: "testnet",
    },
    {
      name: "std",
      system: "std",
      is_override: true,
      use_environment: "testnet",
    },
  ]),
  "local dependency digest should include Rust-side implicit deps"
);

const explicitSuiMoveToml = `
[package]
name = "Pkg"
edition = "2024"

[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework-rev" }
`;
assertEqual(
  digestFromMoveToml(explicitSuiMoveToml),
  "",
  "explicit Sui dependency with implicit deps enabled should fail"
);

const explicitSuiWithoutImplicitMoveToml = `
[package]
name = "Pkg"
edition = "2024"
implicit-dependencies = false

[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework-rev" }
`;
assertEqual(
  digestFromMoveToml(explicitSuiWithoutImplicitMoveToml),
  digestFromJson([
    {
      name: "Sui",
      git: "https://github.com/MystenLabs/sui.git",
      subdir: "crates/sui-framework/packages/sui-framework",
      rev: "framework-rev",
      use_environment: "mainnet",
    },
  ]),
  "explicit Sui dependency with implicit deps disabled should be included"
);

const emptySuiPackageToml = `
[package]
name = "Sui"
edition = "2024"
`;
assertEqual(
  digestFromMoveToml(emptySuiPackageToml, "Sui"),
  digestFromJson([]),
  "Sui package should not receive implicit sui/std dependencies"
);

const emptySuffixedStdToml = `
[package]
name = "MoveStdlib"
edition = "2024"
`;
assertEqual(
  digestFromMoveToml(emptySuffixedStdToml, "MoveStdlib"),
  digestFromJson([]),
  "MoveStdlib package should not receive implicit sui/std dependencies"
);

const systemDepMoveToml = `
[package]
name = "Pkg"
edition = "2024"
implicit-dependencies = false

[dependencies]
std = { system = "std" }
`;
assertEqual(
  digestFromMoveToml(systemDepMoveToml),
  digestFromJson([
    {
      name: "std",
      system: "std",
      is_override: false,
      use_environment: "mainnet",
    },
  ]),
  "system dependency table should be represented by Rust digest helper"
);

if (digestFromMoveToml("[package", "Pkg") !== "") {
  throw new Error("malformed Move.toml should return an empty digest");
}

console.log(
  "[OK] Rust Move.toml manifest_digest helper matches JSON digest compatibility helper"
);
