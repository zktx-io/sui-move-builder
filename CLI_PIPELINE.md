# Sui CLI Build Pipeline vs Sui Move Builder

This document maps the Sui CLI build steps to the JS + WASM implementation in this project.

## 1) Input / Source Loading

- **CLI**: Reads `Move.toml`, optional `Move.lock`, and source files from disk.
- **Here (JS)**: `buildMovePackage` receives in-memory `files` (Move.toml/Move.lock/\*.move). No disk IO.

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

---

## 10) Address Resolution Rules

The following address resolution logic replicates the original Sui CLI behavior (`resolution_graph.rs`, `legacy_parser.rs`):

### 10.1 Two Address Types

| Address            | Purpose                        | Source                                                       |
| ------------------ | ------------------------------ | ------------------------------------------------------------ |
| **`original_id`**  | Compilation (bytecode address) | Move.lock `original-published-id` or Move.toml `original-id` |
| **`published_at`** | Output metadata / linking      | Move.lock `latest-published-id` or Move.toml `published-at`  |

### 10.2 Resolution Priority

1. **Additional Named Addresses** (CLI option) - highest priority
2. **dev-addresses** (root package only, dev mode only)
3. **Move.lock** `[env.<chain_id>]` section (when Move.toml address is `0x0`)
4. **Move.toml** `[addresses]` section - default

### 10.3 Move.toml `[addresses]` Parsing

From `get_manifest_address_info()`:

- If only `original_id` exists → `published_at = original_id`
- If both exist → used separately
- If `original_id = 0x0` → package treated as unpublished

### 10.4 dev-addresses Behavior

- Applied **only in dev mode**
- Applied **only to root package**, not dependencies
- Cannot introduce new named addresses (override only)
- Conflicting assignments cause errors

---

## 11) Published.toml Handling

### 11.1 File Purpose

Output record of deployment. Contains `original_id` and `published_at` per environment.

### 11.2 Loading Priority (per package)

```
Published.toml → legacy_data (from Move.lock) → None
```

- **All packages** (root + dependencies) attempt to read their own `Published.toml`
- Environment-specific: `[mainnet]`, `[testnet]`, etc.

### 11.3 Usage in Build

| Context          | Address Used            |
| ---------------- | ----------------------- |
| WASM Compilation | `original_id`           |
| Output Metadata  | `published_at` (latest) |

---

## 12) Dependency Ordering

### 12.1 Deterministic Ordering

- Dependencies stored in `BTreeMap` → **lexicographical order** by package name
- Not declaration order in Move.toml

### 12.2 Topological Sort

From `dependency_graph.rs`:

```rust
pub fn topological_order(&self) -> Vec<PackageName> {
    algo::toposort(&self.package_graph, None)
}
```

Uses petgraph's `toposort` for deterministic compilation order.

---

## 13) System Package Exclusion

### 13.1 Excluded from Output

The following system packages are excluded from dependency output (matching CLI):

| Address         | Package   |
| --------------- | --------- |
| `0x0000...0003` | SuiSystem |
| `0x0000...000b` | Bridge    |

### 13.2 CLI Source Reference

- `sui-types/src/lib.rs:130`: `SUI_SYSTEM_ADDRESS = 0x3`
- `sui-types/src/lib.rs:131`: `BRIDGE_ADDRESS = 0xb`
- `sui-move-build/src/lib.rs:616`: `p.published()` check filters unpublished deps

### 13.3 Filter Logic

CLI's `PackageDependencies::new()`:

- Only includes packages where `p.published()` returns `Some`
- System packages lack `published-at` → automatically excluded

---

## 14) Verified Constants

The following hardcoded values match the original CLI source:

| Constant         | Value           | CLI Source                      |
| ---------------- | --------------- | ------------------------------- |
| Zero Address     | `0x0000...0000` | `AccountAddress::ZERO`          |
| SuiSystem        | `0x3`           | `sui-types/src/lib.rs:130`      |
| Bridge           | `0xb`           | `sui-types/src/lib.rs:131`      |
| Mainnet Chain ID | `35834a8a`      | docs, tests, `move-package-alt` |
| Testnet Chain ID | `4c78adac`      | tests                           |

---

## 15) WASM-Rust Parity Verification

### 15.1 Verification Method

```
[Same Input] ─┬─▶ [sui move build (Rust)]  ─▶ Result A
              │
              └─▶ [sui-move-builder (WASM)] ─▶ Result B

Result A == Result B  →  WASM ≡ Rust
```

### 15.2 Comparison Targets

| Item               | Rust (CLI)     | WASM          | Comparison      |
| ------------------ | -------------- | ------------- | --------------- |
| Module bytecode    | `.mv` files    | `modules[]`   | Byte-level diff |
| Dependencies       | Lock order     | Output order  | Exact match     |
| Address resolution | `original_id`  | named address | Same address    |
| published_at       | Published.toml | metadata      | Match           |

### 15.3 Test Scenarios

1. **Move.toml only** (initial build): Both produce identical Lock
2. **Move.toml + Lock** (rebuild): Same bytecode verification
3. **+ Published.toml** (deployed package): Correct address compilation

### 15.4 Fidelity Test Results (2026-01-21)

```
✅ nautilus: Dependencies ✅, Modules ✅
✅ apps: Dependencies ✅, Modules ✅
✅ deeptrade: Dependencies ✅, Modules ✅

✅ All fidelity tests passed!
```
