# Sui CLI Build Pipeline vs Sui Move Builder

This document maps the Sui CLI build steps to the JS + WASM implementation in this project.

## 1) Input / Source Loading

- **CLI**: Reads `Move.toml`, optional `Move.lock`, and source files from disk.
- **Here (JS)**: `buildMovePackage` receives in-memory `files` (Move.toml/Move.lock/*.move). No disk IO.

## 2) Dependency Resolution

- **CLI**: Builds a dependency graph from `Move.lock` when valid, otherwise from manifests. Injects system packages and applies dev-mode filtering.
- **Here (JS)**: `resolveMoveToml` (`src/resolver.ts`) builds `DependencyGraph` → `ResolvedGraph` → `CompilationDependencies`. Lockfile support for v0/v3/v4. Move.toml is not mutated; system deps are not auto-injected. Git fetch via `GitHubFetcher`.

## 3) Dependency Inclusion & Serialization

- **CLI**: Keeps reachable packages from the lock/manifest graph. Chooses Source vs Bytecode per package (uses .mv when sources are absent). Sorts `.move` paths (BTreeSet) before passing to the compiler. Packages become `PackagePaths` with named address maps and edition/flavor.
- **Here (JS)**: Applies reachability filtering and drops unused system packages (Bridge, SuiSystem) to match observed CLI outputs. `.move` paths are lexicographically sorted in `CompilationDependencies.extractSourcePaths`. Packages are serialized as `PackageGroup` JSON in `toPackageGroupedFormat`, including `addressMapping` so WASM can use pre-resolved addresses/IDs without re-parsing Move.toml. **Difference:** Only source form is supported; bytecode (.mv) fallback is not implemented. Dependency IDs/order are passed through from JS as-serialized (no recompute/reorder in WASM).

## 4) Compiler Invocation

- **CLI**: `Compiler::from_package_paths` with target + deps (Source/Bytecode mix), using real FS or VFS.
- **Here (WASM/Rust)**: `compile_impl` builds `PackagePaths` for root/deps, writes files to in-memory VFS, then calls `Compiler::from_package_paths`. Dependency named-address maps/IDs prefer JS-provided `addressMapping`, falling back to `SourceManifest` parsing (via `manifest.rs`) for robust TOML handling. Supports `test_mode` and `lint_flag` configuration exposed from JS.

## 5) Module Ordering

- **CLI**: Outputs modules in dependency-topological order (`dependency_order`).
- **Here (WASM/Rust)**: Serializes modules exactly in the compiler-returned order (= `dependency_order`). No extra sorting or re-topology steps are applied.

## 6) Output

- **CLI**: Modules (topo-sorted), dependencies (hex IDs), digest.
- **Here (WASM/Rust)**: Returns `{ modules, dependencies, digest }` with topo-sorted modules. Dependencies now match CLI ordering/content. Compilation uses the original-published-id for address resolution, while the emitted `dependencies` list prefers `latest-published-id` from Move.lock when available (mirrors CLI logs/JSON).

## Known Limitations

- Bytecode-only dependency fallback (.mv) used by the Sui CLI when sources are missing is **not supported** in the WASM path; all deps must be available as source.

## 7) Testing

- **CLI**: `sui move test` compiles in test mode and runs the unit test runner.
- **Here (WASM/Rust)**:
  - **Compilation**: `compile_impl` accepts `test_mode: true` in `compileOptions`. This sets `Flags::testing()` and includes modules marked with `#[test_only]`.
  - **Execution**: `test_impl` (exposed as `test`) takes the package source and dependencies, sets up `UnitTestingConfig` (configured for WASM safety, e.g., no multi-threading), and runs tests using `move_unit_test::UnitTestingConfig`. It returns a boolean pass/fail status and a string of output logs. Real cryptographic verification is supported via `k256`/`arkworks` integration, allowing accurate negative testing of `secp256k1` and `groth16` operations.

## Verification checklist (keep in sync)

- Version conflicts: CLI aborts on same-name/different-rev packages; JS/WASM must mirror this (no silent dedupe).
- Path sorting: CLI uses `BTreeSet` (bytewise) for `.move` paths; JS must produce identical ordering (no locale-dependent compare).
- Move.toml usage: CLI only parses for address maps/edition; we now use `SourceManifest` (ported from proper Move crates) to parse `Move.toml` strictly without IO dependencies.
- Module ordering: Emit exactly the compiler-returned `dependency_order`; avoid extra re-sorts in WASM.
- Outputs: Dependencies/IDs should pass through from JS; BuildInfo/disassembly artifacts are CLI-only unless intentionally added to WASM.

- Module ordering: Emit exactly the compiler-returned `dependency_order`; avoid extra re-sorts in WASM.
- Outputs: Dependencies/IDs should pass through from JS; BuildInfo/disassembly artifacts are CLI-only unless intentionally added to WASM.

## 8) Implementation Defaults & Heuristics

- **Network Default**: If not specified, `Move.lock` parsing defaults to the `[env.mainnet]` section.
- **Address Injection**: `Move.lock` address injection uses a heuristic: it scans `Move.toml` for `package_name = "0x0"` (case-insensitive). It may not verify arbitrary variable names.
- **Test Filtering**: To improve performance, `move test` (WASM) filters out tests defined in standard frameworks (`std=0x1`, `sui=0x2`). User tests are always executed.
- **System Addresses**: `std` (0x1) and `sui` (0x2) are automatically defined in the compiler's address map if missing, ensuring standard library resolution.

## 9) Parity Audit Findings (Verified 2026-01-19)

A deep audit of the `sui-move-wasm` Rust source and JS Integration layer confirms strict parity with the Sui CLI execution model:

1.  **Rust Parity**: `sui-move-wasm/Cargo.toml` depends on `move-package-alt-compilation`, ensuring the WASM binary uses the same compilation logic as the CLI.
2.  **Interface Integrity**:
    - **Edition**: JS (`src/compilationDependencies.ts`) explicitly serializes `edition` into the package config, and Rust (`src/lib.rs`) deserializes it via the `PackageGroup` struct.
    - **Address Fidelity**: The system supports standard `0x0` addresses for unpublished dependencies, matching CLI default behavior verified in `build_config.rs`.
3.  **Result**: Complex integration tests pass with this strict configuration.
