# Sui CLI Build Pipeline vs Sui Move Builder

This document maps the Sui CLI build steps to the JS + WASM implementation in this project. It is a parity guide, not a guarantee that every Sui CLI path is implemented; known differences and best-effort areas are called out explicitly.

## Build Workspace Boundaries

The development WASM build keeps four areas separate:

- `.sui-build/source/`: pristine upstream Sui checkout resolved from `sui-version.json`.
- `.sui-build/work/`: disposable patched worktree used for the actual Cargo build.
- `.sui-build/generated/`: generated compatibility state, including stubs, vendored sources, and local build tools.
- `dist/`: npm-facing generated lite/full artifacts.

`npm run prepare:wasm` is the step that may fetch/update source, recreate the worktree, apply overlays/templates, and write `.sui-build/patch-state.json`. `npm run build:wasm:prepared` validates that state and builds `dist/lite` and/or `dist/full`; it should not be used as a porting step for a new upstream version. `npm run build:wasm` remains the compatibility entrypoint that runs both phases.

## 1) Input / Source Loading

- **CLI**: Reads `Move.toml`, optional `Move.lock`, and source files from disk.
- **Here (JS)**: `buildMovePackage` receives in-memory `files` (Move.toml/Move.lock/\*.move). No disk IO.

## 2) Dependency Resolution

- **CLI**: Builds a dependency graph from usable `Move.lock` pins when available, otherwise from manifests. Applies Sui flavor implicit dependencies and dev-mode behavior.
- **Here (JS)**: `resolveMoveToml` (`src/resolver.ts`) builds `DependencyGraph` → `ResolvedGraph` → `CompilationDependencies`. V4 pinned lockfiles are the main lockfile source for graph loading; v3 falls back to manifest resolution while legacy publication data can be migrated separately, and older layouts are handled best-effort. The caller's `Move.toml` is not mutated, but reconstructed compiler input is generated. The root package may receive an implicit Sui framework dependency when missing; `MoveStdlib`, `SuiSystem`, and `Bridge` are not all injected as explicit JS dependencies. Git fetch is handled through `GitHubFetcher` or a supplied `Fetcher`.

## 3) Dependency Inclusion & Serialization

- **CLI**: Keeps reachable packages from the lock/manifest graph. Chooses Source vs Bytecode per package (uses .mv when sources are absent). Sorts `.move` paths before passing to the compiler. Packages become `PackagePaths` with named address maps and edition/flavor.
- **Here (JS/WASM)**: Applies linkage/reachability filtering for compiler input and keeps a separate all-package set for lockfile generation. Output dependency filtering in `src/index.ts` omits zero IDs and selected implicit system IDs such as Bridge/SuiSystem in cases covered by parity tests. Packages are serialized as `PackageGroup` JSON in `toPackageGroupedFormat`, including `addressMapping` so WASM can use pre-resolved addresses/IDs without re-parsing Move.toml. Root target paths are sorted in Rust; JS does not perform a standalone `extractSourcePaths` sort. **Move.lock Generation**: Sorts generated `[pinned]` sections deterministically. **Difference:** Only source form is supported; bytecode (.mv) fallback is not implemented. Dependency IDs/order are computed by the local JS/Rust path and checked by parity tests rather than by reusing the upstream package manager end to end.

## 4) Compiler Invocation

- **CLI**: `Compiler::from_package_paths` with target + deps (Source/Bytecode mix), using real FS or VFS.
- **Here (WASM/Rust)**: `compile_impl` builds `PackagePaths` for root/deps, writes files to an in-memory VFS, then calls `Compiler::from_package_paths`. Dependency named-address maps/IDs prefer JS-provided `addressMapping`, falling back to `SourceManifest` parsing (via `manifest.rs`). `test_mode` is applied through `Flags::testing()`. `lintFlag` is deserialized but is not currently wired into Move compiler flags, and `stripMetadata` is passed by JS but not represented in the Rust compile options.

## 5) Module Ordering

- **CLI**: Outputs modules in dependency-topological order (`dependency_order`).
- **Here (WASM/Rust)**: Filters the compiled units down to root package modules, computes a module topological order with `move_bytecode_utils::Modules`, and serializes that order. Any modules not covered by that ordering are appended. This is intended to match CLI JSON dumps for covered packages.

## 6) Output

- **CLI**: Modules (topo-sorted), dependencies (hex IDs), digest, Move.lock.
- **Here (WASM/Rust + JS)**: Returns `{ modules, dependencies, digest, moveLock, environment, warnings }`. Compilation prefers original published IDs for address resolution, while emitted dependency IDs prefer the latest/published ID information available from the resolved graph. Dependency ordering/content is covered by parity tests for selected packages. **Move.lock V4** is generated in JS with `manifest_digest` values computed through the Rust helper when available. **Warnings** are captured during compilation if not silenced.

## Known Limitations

- Bytecode-only dependency fallback (.mv) used by the Sui CLI when sources are missing is **not supported** in the WASM path; all deps must be available as source.
- `lintFlag` and `stripMetadata` are reserved/pass-through API options today; they should not be documented as active compiler behavior.
- V4 lockfile loading checks the root manifest digest when available, but dependency manifest digest validation is intentionally skipped in the JS resolver.
- CLI dev-addresses and extra named-address override channels are not exposed as first-class `BuildInput` options.
- V3 lockfiles are not used as pinned dependency graph sources; they trigger manifest resolution, with legacy publication data migration handled separately.

## 7) Testing

- **CLI**: `sui move test` compiles in test mode and runs the unit test runner.
- **Here (WASM/Rust)**:
  - **Compilation**: `compile_impl` accepts `test_mode: true` in `compileOptions`. This sets `Flags::testing()` and includes modules marked with `#[test_only]`.
  - **Execution**: In the full build, `test_impl` (exposed as `test`) takes the package source and dependencies, sets up `UnitTestingConfig` with one thread for WASM safety, and runs tests using `move_unit_test::UnitTestingConfig` plus Sui natives. It returns a boolean pass/fail status and a string of output logs.

## Verification checklist (keep in sync)

- Same-name/different-source packages: keep the suffix/linkage behavior covered by parity tests and avoid silent source dedupe.
- Path sorting: keep source path ordering deterministic and verify against CLI outputs; avoid locale-dependent comparisons where sorting is used.
- Move.toml usage: use `SourceManifest` for compiler-side manifest parsing, while JS still performs resolver-side TOML parsing and reconstruction.
- Module ordering: keep the root module topological ordering aligned with CLI dump output for parity fixtures.
- Outputs: BuildInfo/disassembly artifacts are CLI-only unless intentionally added to WASM.

## 8) Implementation Defaults & Heuristics

- **Network Default**: If not specified, the build network defaults to `mainnet`; lockfile lookup then uses the active network/chain identifiers.
- **Address Injection**: Address handling combines parsed `Move.toml`, `Move.lock` environment data, `Published.toml`, and a unified named-address table. Some fallback paths are heuristic and should be checked with parity tests when adding new package-manager behavior.
- **Test Filtering**: `move test` (WASM) filters framework tests by address heuristic (`std=0x1`, `sui=0x2`). This is not a full package ownership filter.
- **System Addresses**: `std` (0x1) and `sui` (0x2) are automatically defined in the compiler's address map if missing, ensuring standard library resolution.

## 9) Parity Audit Notes (Reviewed 2026-01-19)

The `sui-move-wasm` Rust source and JS integration layer are designed to stay close to the Sui CLI execution model where practical. The compiler path uses upstream Move/Sui crates, but dependency resolution and lockfile generation include local JS/Rust glue and remain subject to parity testing.

1.  **Rust Compiler Path**: `sui-move-wasm/Cargo.toml` uses Move/Sui compiler crates from the pinned Sui build workspace, so the WASM binary shares core compiler behavior with the CLI where those crates are used.
2.  **Interface Integrity**:
    - **Edition**: JS (`src/compilationDependencies.ts`) explicitly serializes `edition` into the package config, and Rust (`src/lib.rs`) deserializes it via the `PackageGroup` struct.
    - **Address Handling**: The system supports standard `0x0` addresses for unpublished dependencies and uses resolved original/latest IDs where available.
3.  **Result**: Integration tests compare selected CLI and WASM outputs; this is evidence for covered fixtures, not a formal proof of full CLI equivalence.

---

## 9.5) Move.lock V4 Generation

### V4 Format (version = 4)

The generated Move.lock uses **version 4 format**, which includes:

- `use_environment` field per package
- `manifest_digest` for change detection
- CLI-shaped pinned sections

Build results include generated Move.lock V4 content:

```typescript
interface BuildSuccess {
  modules: string[]; // Base64 bytecode
  dependencies: string[]; // Hex IDs
  digest: number[]; // Package digest
  moveLock: string; // V4 lockfile content
  environment: string; // e.g., "mainnet"
}
```

### manifest_digest Calculation

The `manifest_digest` field in generated Move.lock V4 is computed by a Rust helper modeled on the CLI digest path:

1. Build `RepinTriggers { deps: BTreeMap<PackageName, ReplacementDependency> }`
2. Serialize with `toml_edit::ser::to_string()`
3. Hash result with SHA256
4. Format as uppercase hex

**Key Implementation Details:**

- `ManifestDependencyInfo` uses default enum serialization (NOT `#[serde(untagged)]`)
- `ReplacementDependency` uses `#[serde(flatten, default)]` attributes
- Expected to match the CLI for supported dependency shapes covered by the helper (git/local/system-style inputs). Other package-manager dependency forms should be verified before claiming parity.

---

## 10) Address Resolution Rules

The address resolution logic is modeled on the Sui CLI package manager, but the WASM API does not expose every CLI override channel.

### 10.1 Two Address Types

| Address            | Purpose                        | Source                                                                                        |
| ------------------ | ------------------------------ | --------------------------------------------------------------------------------------------- |
| **`original_id`**  | Compilation (bytecode address) | Move.lock `original-published-id`, `Published.toml` `original-id`, or Move.toml `original-id` |
| **`published_at`** | Output metadata / linking      | Move.lock `latest-published-id`, `Published.toml` `published-at`, or Move.toml `published-at` |

### 10.2 Implemented Sources and Priority

The implementation reads several sources and uses them differently for compilation and output metadata:

1. **Published.toml**, when present in the package files, can provide `original-id` and `published-at` for the selected environment.
2. **Move.lock** `[env.<chain_id>]` or `[env.<network>]` records can provide `original-published-id` and `latest-published-id`.
3. **Move.toml** `[package]` metadata can provide `published-at` and `original-id`.
4. **Move.toml** `[addresses]` is used for named address maps and self-address handling.

For compiler input, `CompilationDependencies` prefers `originalId`, then falls back to `publishedAt`, then `0x0` for unpublished source packages. For emitted dependency IDs, it prefers `latestPublishedId`, then `publishedAt`, then `originalId`.

### 10.3 Move.toml `[addresses]` Parsing

Conceptually:

- If only `original-id` exists → `published-at = original-id`
- If both exist → used separately
- If `original-id = 0x0` → package treated as unpublished

### 10.4 dev-addresses Behavior

The bullets below describe the CLI behavior, not a currently exposed WASM `BuildInput` feature:

- Applied **only in dev mode**
- Applied **only to root package**, not dependencies
- Cannot introduce new named addresses (override only)
- Conflicting assignments cause errors

Current WASM builds do not expose a dev-mode/dev-address override API.

---

## 11) Published.toml Handling

### 11.1 File Purpose

Output record of deployment. Contains `original_id` and `published_at` per environment.

### 11.2 Loading Priority (per package)

```
Published.toml → migrated legacy data when provided by the JS wrapper → None
```

- **All packages** (root + dependencies) attempt to read their own `Published.toml`
- Environment-specific: `[mainnet]`, `[testnet]`, etc.

### 11.3 Usage in Build

| Context          | Address Used                                     |
| ---------------- | ------------------------------------------------ |
| WASM Compilation | `original_id` when available, otherwise fallback |
| Output Metadata  | latest/published ID information when available   |

---

## 12) Dependency Ordering

### 12.1 Deterministic Ordering

- Generated Move.lock sections are sorted lexicographically by package ID/name in `generateMoveLockV4FromJson`.
- Compiler input order comes from the resolved dependency graph and linkage filtering, not directly from declaration order in `Move.toml`.
- Rust output dependency IDs are sorted before digest/output serialization.

### 12.2 Topological Sort

The JS graph uses DFS/topological traversal and linkage filtering to produce compiler input order. Rust then computes root module order using `move_bytecode_utils::Modules`. Parity tests compare the resulting module bytecode order against `sui move build --dump-bytecode-as-base64`.

---

## 13) System Package Exclusion

### 13.1 Excluded from Output

The following system packages are excluded from dependency output in the JS wrapper to track observed CLI output:

| Address         | Package   |
| --------------- | --------- |
| `0x0000...0003` | SuiSystem |
| `0x0000...000b` | Bridge    |

### 13.2 CLI Source Reference

- `sui-types/src/lib.rs:130`: `SUI_SYSTEM_ADDRESS = 0x3`
- `sui-types/src/lib.rs:131`: `BRIDGE_ADDRESS = 0xb`
- `sui-move-build/src/lib.rs:616`: `p.published()` check filters unpublished deps

### 13.3 Filter Logic

The JS wrapper filters dependency IDs before mapping them to output package names:

- Excludes the zero address.
- Excludes SuiSystem (`0x3`) and Bridge (`0xb`) when they appear as implicit system dependencies rather than explicit root manifest dependencies.
- Keeps Sui (`0x2`) and Std (`0x1`) handling separate because they are default framework dependencies.

---

## 14) Verified Protocol Constants

The following fixed protocol values are copied from the original CLI source or
published Sui network metadata. They are not test expectations:

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

Result A == Result B for selected outputs → covered fixture parity
```

### 15.2 Comparison Targets

| Item            | Rust (CLI)        | WASM             | Comparison             |
| --------------- | ----------------- | ---------------- | ---------------------- |
| Module bytecode | `.mv`/base64 JSON | `modules[]`      | Byte-level diff        |
| Dependencies    | CLI JSON output   | `dependencies[]` | Ordered array compare  |
| Package digest  | CLI JSON output   | `digest`         | Normalized hex compare |

### 15.3 Test Scenarios

1. **Move.toml only** (initial build): Compare module bytecode, dependencies, and digest for selected fixtures.
2. **Move.toml + Lock** (rebuild): Exercise lockfile-aware resolution where fixtures include lockfiles.
3. **+ Published.toml** (deployed package): Exercise publication metadata when available in fixtures.

### 15.4 Parity Test Method

The current integration test does not use transaction snapshots or package-specific expected results. It builds the same local Move package twice:

1. `sui move build --dump-bytecode-as-base64 --path <package>` using the local Sui CLI.
2. `buildMovePackage` using the generated WASM artifact.

`npm run test:full` checks `dist/full`, `npm run test:lite` checks `dist/lite`, and `npm run test:parity` runs both. The test warns when the local Sui CLI version differs from `sui-version.json` and fails when the CLI is missing. It also fails on any mismatch in module bytecode, dependency IDs, or package digest. Default test packages are discovered from the pinned Sui checkout under `examples/move`, preferring packages with multiple Move source files. Explicit package paths can be passed to `test/integration/fidelity_test.mjs` when project-specific fixtures are available.

`npm run test:browser` uses Chrome headless and the Chrome DevTools Protocol to verify that both `dist/lite` and `dist/full` load and compile in a real browser environment. `npm run dev:browser-parity` serves an interactive browser page that loads Sui examples, local packages, or GitHub packages, builds them in the browser, and compares the browser WASM output against the local Sui CLI JSON output.

---

## 16) CLI-Oriented Fixes (2026-01-26)

### 16.1 Git Revision SHA Resolution

**CLI Source**: `pin.rs:61-63, 254-262`

CLI converts git branch/tag revisions to 40-character SHA during pinning:

```rust
/// Replace all dependencies in `deps` with their pinned versions:
///  - the revisions for git dependencies are replaced with 40-character shas
```

**WASM Implementation**: `resolver.ts` calls `getResolvedSha()` after fetching to convert tags/branches to SHA.

### 16.2 Lockfile Dependency Source

**CLI Source**: `dependency_graph.rs:1284-1289`

CLI writes deps from `package_graph.edges()`, not from Move.toml:

```rust
let mut deps: Vec<_> = self
    .package_graph
    .edges(id)  // From graph edges, not manifest!
    .collect();
```

**WASM Implementation**: Prioritizes `depAliasToPackageName` (lockfile) over Move.toml deps.

### 16.3 Manifest Digest Calculation

**CLI Source**: `package_impl.rs:287-308`, `manifest.rs:155-170`

CLI computes `manifest_digest` from `CombinedDependency` which includes implicit deps:

```rust
fn compute_digest(deps: &[CombinedDependency]) -> String {
    // ... deps includes implicit system deps like sui, std ...
}
```

**WASM Implementation**: `buildDigestInputFromManifest` adds system dep format for implicit deps not in Move.toml.

### 16.4 Multi-Environment Preservation

**CLI Source**: `root_package.rs:272-282`

CLI reads existing lockfile and only updates current environment:

```rust
lockfile.pinned.insert(
    self.environment.name.clone(),  // Only current env
    self.unfiltered_graph.to_pins()?,
);
```

**WASM Implementation**: `generateMoveLockV4FromJson` parses existing lockfile and preserves other environment sections.

### 16.5 Diamond Dependency Support

**CLI Source**: `builder.rs:232-265`

CLI supports diamond dependencies where multiple packages may depend on the same package at different versions:

```rust
// create_ids logic
// CLI treats packages with same name but different sources as separate nodes
// and records them in lockfile as MoveStdlib, MoveStdlib_1, MoveStdlib_2
```

**WASM Implementation**: `resolver.ts` tracks `packageNameToSuffix` counter. First package gets original name, subsequent get `_1`, `_2` suffixes.

### 16.6 Sibling Package Sui Framework Sharing

**CLI Source**: `builder.rs:286`, `pin.rs:283-285`

When packages from the same git repository (e.g., `deepbook` and `token` from `deepbookv3.git`) depend on Sui framework, the CLI resolves them through the same fetched package path when the underlying tag resolves to the same SHA:

- CLI's `visited` map uses `(env, PackagePath)` as key
- `PackagePath` includes resolved SHA (not tag) from git cache
- Same `framework/mainnet` tag resolves to same SHA → same visited entry → same Sui node

**WASM Implementation**: Uses two caches:

1. `repoRevToSuiRev`: Maps `git|rev` → resolved Sui SHA for sibling packages
2. `suiTagToShaCache`: Pre-resolves tags to SHA before cacheKey generation

This is intended to keep sibling packages on the same resolved Sui framework node, such as `token` referencing the same Sui package instance as `deepbook` instead of creating an extra Sui node.

### 16.7 Diamond Dependency Linkage Selection

**CLI Source**: `linkage.rs:169-228`

CLI uses depth-based selection for diamond dependencies where same `originalId` appears at different depths:

```rust
// linkage.rs:199-202
let (min_depth, min_pkg, other_pkg) = if new_depth < *old_depth {
    (new_depth, new_pkg.clone(), old_pkg.clone())
} else {
    (*old_depth, old_pkg.clone(), new_pkg.clone())
};
```

**Key Behavior**: For packages sharing the same `originalId` (e.g., multiple MoveStdlib versions), CLI selects the one with **smallest depth** (closest to root) for compilation.

**WASM Implementation**: `dependencyGraph.ts:compilerInputOrderWithIndices()` builds a `linkageTable` with depth comparison:

```typescript
const existing = linkageTable.get(originalId);
if (existing && existing.depth <= depth) {
  return; // Already have shorter path
}
linkageTable.set(originalId, { depth, idx: index });
```

---

## 17) Reference Versions

| Component     | Source                                         |
| ------------- | ---------------------------------------------- |
| Sui Version   | `sui-version.json` (shared config)             |
| Reference CLI | local `sui` binary matching `sui-version.json` |
| Test Fixtures | local packages or pinned Sui `examples/move`   |

### Shared Configuration

`sui-version.json` is the single source of truth for Sui framework version:

```json
{
  "version": "1.63.3",
  "commit": "04dd28d5c5d92bff685ddfecb86f8acce18ce6df"
}
```

Used by:

- `scripts/build-wasm.mjs` - WASM build script
- `src/resolver.ts` - Runtime implicit dependency resolution

### Local Build Directories

The WASM build keeps upstream source and patched build state separate:

- `.sui-build/source/`: pristine Sui checkout pinned to `sui-version.json`
- `.sui-build/work/`: disposable git worktree used for overlaying `sui-move-wasm` and applying Cargo/WASM patches

Only `.sui-build/work/` is modified during patching and compilation. The whole `.sui-build/` directory is ignored and should not be edited as project source. `SUI_SOURCE_DIR` and `SUI_WORK_DIR` can override these paths for specialized local setups.

Every selected Sui version must have a matching `scripts/templates/v<version>/` compatibility template set. Missing templates are a porting blocker, so the build fails before patching instead of silently reusing another version.

The default development baseline remains `sui-version.json`. Other releases must be selected explicitly with `SUI_VERSION` plus `SUI_TAG`/`SUI_COMMIT`, or with equivalent `--sui-version`, `--sui-tag`, and `--sui-commit` script flags.
