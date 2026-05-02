# Sui CLI Build Pipeline vs Sui Move Builder

This document maps the Sui CLI build steps to the JS + WASM implementation in this project. It is a parity guide, not a guarantee that every Sui CLI path is implemented; known differences and unsupported areas are called out explicitly.

## Build Workspace Boundaries

The development WASM build keeps four areas separate:

- `.sui-build/source/`: pristine upstream Sui checkout resolved from `sui-version.json`.
- `.sui-build/work/`: disposable patched worktree used for the actual Cargo build.
- `.sui-build/generated/`: generated compatibility state, including stubs, vendored sources, and local build tools.
- `dist/`: npm-facing generated lite/full artifacts.

`npm run prepare:wasm` is the step that may fetch/update source, recreate the worktree, apply overlays/templates, and write `.sui-build/patch-state.json`. It removes any stale patch state at startup and writes a new patch-state file only after successful preparation. `npm run build:wasm:prepared:lite`, `npm run build:wasm:prepared:full`, and `npm run build:wasm:prepared:all` validate that final marker against the current version, template, paths, and required prepared files before building `dist/lite`, `dist/full`, or both; they should not be used as porting steps for a new upstream version. Full prepared builds run a Binaryen `wasm-opt` strip pass after `wasm-bindgen` unless `SUI_WASM_SKIP_WASM_OPT=1` is set. `npm run build:wasm:prepared` is an all-profile alias, and `npm run build:wasm` remains the compatibility entrypoint that runs both phases.

## 1) Input / Source Loading

- **CLI**: Reads `Move.toml`, optional `Move.lock`, and source files from disk.
- **Here (JS)**: `buildMovePackage` receives in-memory `files` (Move.toml/Move.lock/\*.move). No disk IO.

## 2) Dependency Resolution

- **CLI**: Builds a dependency graph from usable `Move.lock` pins when available, otherwise from manifests. Applies Sui flavor implicit dependencies and dev-mode behavior.
- **Here (JS + Rust/WASM)**: `resolveMoveToml` (`src/resolver.ts`) uses Rust/WASM for usable V4 lockfiles: Rust parses the active environment, creates the fetch plan, validates root/dependency pin digests, undefined edges, local source pins, and same-name package IDs, then returns compiler and lockfile package groups. TypeScript performs host fetching/snapshot loading and wraps the returned groups. Manifest fallback uses a JS fetch loop, but Rust/WASM owns per-package planning, dependency edge construction, same-name suffixing, cycle detection, linkage/compiler order, lockfile order, and final compiler/lockfile package-group construction. V0/V1/V2/V3 lockfile graphs are not used as pinned graph sources; supported packages fall back to manifest resolution, and supported V3 publication data can be migrated separately. The caller's `Move.toml` is not mutated. The root package may receive an implicit Sui framework dependency when missing; `MoveStdlib`, `SuiSystem`, and `Bridge` are not all injected as explicit JS dependencies. Git fetch is handled through `GitHubFetcher` or a supplied `Fetcher`; local dependencies from local/root packages require a host-provided `fetchLocal` snapshot loader.

## 2.1) Package File Loading Boundary

TypeScript owns host I/O. It prepares the package snapshots that Rust/WASM compiles. The default GitHub loader collects `.move`, `Move.toml`, `Move.lock`, `Move.<env>.toml`, and `Published.toml`. Rust/WASM plans git-sourced `local = "../dep"` entries as same-repository subdirs and local/root package `local = "../dep"` entries as `fetchLocal(localPath, context)` loads. Browser callers must provide those snapshots through upload, File System Access API, a server endpoint, or a custom cache; the library does not read the browser host filesystem directly. Missing local loaders, empty fetched packages, and dependency packages without `Move.toml` fail explicitly.

### Snapshot Adapter Contract

The runtime package boundary is a host-provided snapshot, not an implicit filesystem package root. Any future adapter that reuses more upstream package-manager code must preserve this contract.

| Snapshot input                         | Required contract                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root package                           | In-memory files supplied through `BuildInput.files`. Must include `Move.toml`; may include `Move.lock`, `Move.<env>.toml`, `Published.toml`, and `.move`.  |
| Git dependency                         | Files returned by `fetcher.fetch(git, rev, subdir)`. The resolved SHA may replace the requested rev for graph identity while the requested source is kept. |
| Local dependency                       | Files returned by `fetchLocal(localPath, context)`. Local/root packages must not trigger hidden runtime filesystem discovery.                              |
| Browser package                        | Same file map as Node, supplied by upload, File System Access API, server endpoint, or cache. Browser code must not assume direct filesystem access.       |
| Dependency package accepted by Rust    | Must include `Move.toml` and at least one `.move` source file for source dependencies. Bytecode-only fallback is unsupported.                              |
| Metadata files read by Rust/WASM       | `Move.toml`, selected `Move.<env>.toml`, `Move.lock`, and `Published.toml` are versioned package inputs and must not be normalized differently in TS.      |
| Output expected from Rust/WASM helpers | Package IDs, dependency edges, linkage/compiler order, lockfile order, package groups, output dependency IDs, digest inputs, and lockfile content.         |

## 3) Dependency Inclusion & Serialization

- **CLI**: Keeps reachable packages from the lock/manifest graph. Chooses Source vs Bytecode per package (uses .mv when sources are absent). Sorts `.move` paths before passing to the compiler. Packages become `PackagePaths` with named address maps and edition/flavor.
- **Here (Rust/WASM + JS host)**: Applies linkage/reachability filtering for compiler input and keeps a separate all-package set for lockfile generation. Rust/WASM constructs `PackageGroup` JSON for V4 lockfile and manifest fallback paths, including `addressMapping`, manifest metadata, and root alias metadata so WASM can use parsed addresses/IDs while owning output dependency filtering. Source discovery is mode-gated in Rust following the pinned `source_discovery.rs` shape: normal build includes `sources/` and `scripts/`, while test mode also includes `examples/` and `tests/` for root and dependencies. JS does not perform a standalone `extractSourcePaths` sort. **Move.lock Generation**: Sorts generated `[pinned]` sections deterministically. **Difference:** Only source form is supported; bytecode (.mv) fallback is not implemented. Dependency IDs/order are computed by the local Rust/WASM package model with TypeScript host fetching, and checked by parity tests rather than by reusing the upstream package manager end to end.

## 4) Compiler Invocation

- **CLI**: `Compiler::from_package_paths` with target + deps (Source/Bytecode mix), using real FS or VFS.
- **Here (WASM/Rust)**: `compile_impl` builds `PackagePaths` for root/deps, writes files to an in-memory VFS, then calls `Compiler::from_package_paths`. Dependency named-address maps/IDs come from Rust package-group construction, falling back to `SourceManifest` parsing (via `manifest.rs`) where needed. `PackageConfig` uses manifest edition/flavor, source warning filters, and package-id safe names. `test_mode` is applied through `Flags::testing()`. `lintFlag` maps to Move compiler lint levels (`none`, `default`, `all`) and registers the same regular/Sui linter filter sets used by the pinned compiler path. `stripMetadata` is passed by JS but not represented in the Rust compile options.

## 5) Module Ordering

- **CLI**: Outputs modules in dependency-topological order (`dependency_order`).
- **Here (WASM/Rust)**: Filters the compiled units down to root package modules, computes a module topological order with `move_bytecode_utils::Modules`, and serializes that order. Any modules not covered by that ordering are appended. This is intended to match CLI JSON dumps for covered packages.

## 6) Output

- **CLI**: Modules (topo-sorted), dependencies (hex IDs), digest, Move.lock.
- **Here (WASM/Rust + JS)**: Returns `{ modules, dependencies, digest, moveLock, environment, warnings }`. Compilation prefers original published IDs for address resolution, while emitted dependency IDs prefer latest/published ID information available from the Rust package model. Dependency ordering/content is covered by parity tests for selected packages. **Move.lock V4** generation is Rust/WASM-owned through `lockfile_v4_generate`; TypeScript supplies root/dependency snapshots and wraps the result. **Warnings** are captured during compilation if not silenced.

## Known Limitations

| Area                                                       | Status                | Current contract                                                                                                                                       | Do not replace with                                                            |
| ---------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Bytecode-only `.mv` dependency fallback                    | `unsupported`         | All dependencies must be available as source snapshots.                                                                                                | Generated source or synthetic package metadata.                                |
| Browser/local filesystem discovery                         | `requires API design` | Local dependency files must be provided through `fetchLocal` or another host snapshot loader.                                                          | Hidden filesystem assumptions in browser code.                                 |
| `stripMetadata`                                            | `reserved/no-op`      | The public option is passed through but is not represented in Rust compile options.                                                                    | Documentation that presents it as active compiler behavior.                    |
| Full upstream `PackageGraphBuilder` / `BuildPlan` reuse    | `planned`             | V4 lockfile and manifest fallback semantics are Rust/WASM-owned for supported shapes, while TypeScript still owns host fetching and snapshot assembly. | More local package-manager semantics without upstream references and fixtures. |
| Dev-address / extra named-address override API             | `requires API design` | No first-class `BuildInput` override channel is exposed.                                                                                               | Ad hoc address rewrites in TypeScript.                                         |
| V0/V1/V2/V3 lockfile graph loading as pinned graph sources | `unsupported`         | Supported packages fall back to manifest resolution; supported V3 publication data may be migrated separately.                                         | JS compatibility graph loading or silent lockfile pin trust.                   |

## Known Implementation Boundaries

These areas are local compatibility boundaries rather than full reuse of the upstream Sui package-manager path. Do not expand them without adding a targeted parity fixture and an upstream source reference.

- **Lockfile and manifest graph outputs**: V4 fetch-plan, graph validation, package group construction, and generation run through Rust/WASM helpers. Manifest fallback graph planning, traversal/order extraction, and package group construction also run through Rust/WASM. TypeScript still performs host fetching and snapshot assembly.
- **Output dependency filtering**: Rust/WASM filters zero IDs and selected system package IDs such as SuiSystem (`0x3`) and Bridge (`0xb`) when they are not root-declared dependencies. Explicit root aliases are carried from the resolver into dependency metadata and covered by `npm run test:output-deps`.
- **Compiler setup**: WASM builds construct `PackagePaths` directly instead of driving compilation through the full upstream `BuildPlan` pipeline. Source discovery is mode-gated and covered by `npm run test:source-discovery`; compiler flags are kept equivalent to the exposed pinned `compiler_flags` behavior and lint setup is covered by `npm run test:compiler-lint`.
- **Test ownership filtering**: full WASM tests construct the test plan with the root package name. Dependency package tests are compiled in test mode but are not executed as root tests. This is covered by `npm run test:unit-test-ownership`.
- **Failure observability**: JS build/test wrappers attach a broad `BuildFailure.category` based on the stage that failed. Rust/WASM helper failures may also carry `BuildFailure.code`; host loader, compiler, and test runner details remain in the original error string.
- **Prepare patching**: recursive Cargo patching remains broad, but version-specific templates and intentional empty stubs are manifest-declared and required patch targets now fail when missing.

### BuildPlan/PackageGraphBuilder Reuse Boundary

Use these current-state classifications when evaluating a future migration toward more upstream reuse:

- `same`: the current path directly uses the pinned upstream type/function.
- `equivalent-local`: the current path locally reproduces the pinned upstream stage for supported snapshots.
- `different-unsupported`: the CLI behavior is intentionally not supported in the WASM path.
- `candidate-for-upstream-reuse`: the area should be investigated before adding more local logic.

Use these reuse-path classifications for a future conversion plan:

- `can reuse directly`: the upstream helper can be reused without changing the browser/Node snapshot boundary.
- `needs snapshot adapter`: reuse requires an adapter that presents host-provided snapshots as the upstream package/cache abstraction without runtime disk or git-cache assumptions.
- `blocked by disk/git cache`: the upstream path currently depends on filesystem package roots, output cleanup, or git/package cache behavior that is not part of the runtime WASM contract.
- `blocked until fixture coverage`: behavior may be reusable, but conversion must wait for targeted fixtures covering order, address, source-discovery, lockfile, output, or test ownership semantics.

| Stage                          | Pinned upstream reference                                                                       | Current WASM path                                                                                                                                                      | Current classification         | Reuse path                       | Transition condition                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root package load              | `move-package-alt/src/package/root_package.rs`                                                  | TypeScript supplies root snapshots; Rust/WASM parses package metadata from those snapshots                                                                             | `equivalent-local`             | `needs snapshot adapter`         | `RootPackage::load` is path/lock/output oriented. Reuse requires a snapshot-backed package root that preserves explicit host snapshots and does not introduce runtime disk or git-cache assumptions.                    |
| Lockfile graph load            | `move-package-alt/src/graph/builder.rs::load_from_lockfile`                                     | `lockfile_v4_fetch_plan` and `lockfile_v4_resolve_package_groups` validate supported V4 pins and produce package groups                                                | `equivalent-local`             | `needs snapshot adapter`         | Upstream loading reads lockfiles from package roots and fetches through package cache. Reuse requires snapshot-backed cache inputs plus fixtures for digest mismatch, undefined edges, local pins, and same-name pins.  |
| Manifest graph load            | `PackageGraphBuilder::load_from_manifests`                                                      | `manifest_graph_resolve_package_groups` plans fetches, assigns package IDs, detects cycles, orders packages, and builds package groups                                 | `equivalent-local`             | `needs snapshot adapter`         | Upstream recursion fetches from `PackageCache`. Reuse requires a host fetch/snapshot adapter before adding new manifest source forms or package-ID semantics.                                                           |
| Linkage and mode filtering     | `RootPackage::validate_and_construct`, `PackageGraph::filter_for_mode`, `PackageGraph::linkage` | Rust/WASM graph helpers compute reachable compiler packages and keep separate lockfile packages                                                                        | `equivalent-local`             | `blocked until fixture coverage` | Any conversion must preserve compiler/lockfile package sets, diamond dependency selection, same-name packages, explicit system deps, and mode filtering fixtures.                                                       |
| Compiler dependency input      | `move-package-alt-compilation/src/build_plan.rs`, `compilation.rs::make_deps_for_compiler`      | `package_model.rs::build_compiler_input` delegates source discovery, package config, address merge, output ID collection, and `PackagePaths` assembly to local helpers | `candidate-for-upstream-reuse` | `needs snapshot adapter`         | `make_deps_for_compiler` operates on upstream package graph nodes and path-based source discovery. Reuse requires a snapshot-backed package graph or adapter without changing package order, address maps, or metadata. |
| Source discovery               | `move-package-alt-compilation/src/source_discovery.rs`                                          | `package_model.rs::source_paths_for_package` selects `sources/` and `scripts/`, plus `examples/` and `tests/` in test mode                                             | `equivalent-local`             | `needs snapshot adapter`         | Upstream `get_sources` scans package directories. Reuse requires source discovery over in-memory snapshots while preserving `sources/`, `scripts/`, `examples/`, and `tests/` rules.                                    |
| Compiler flags and lint setup  | `compilation.rs::compiler_flags`, `compilation.rs::build_for_driver`                            | `compile_impl` uses a local adapter for the exposed `compiler_flags` fields and registers Sui/regular linter filters from `lintFlag`                                   | `equivalent-local`             | `needs snapshot adapter`         | Direct helper reuse is blocked while `move-package-alt-compilation` is stubbed for WASM. The full `build_for_driver` path remains blocked until package graph and source discovery adapters exist.                      |
| Output dependencies and digest | `sui-move-build/src/lib.rs::PackageDependencies`, package linkage metadata                      | Rust/WASM package model emits dependency IDs used for both output and digest                                                                                           | `equivalent-local`             | `needs snapshot adapter`         | Upstream `PackageDependencies::new` reads `RootPackage` package metadata. Reuse requires upstream graph/package metadata in WASM; zero/system filtering must remain Rust-owned and fixture-covered.                     |
| Move.lock V4 generation        | `move-package-alt/src/graph/to_lockfile.rs`                                                     | `lockfile_v4_generate` writes supported V4 pinned sections from Rust/WASM package metadata                                                                             | `equivalent-local`             | `needs snapshot adapter`         | Upstream `to_pins` depends on `PackageGraph`. Reuse requires graph ownership through snapshot-backed upstream types; unsupported source forms must continue to fail explicitly.                                         |
| Unit test ownership            | Sui Move test path and Move unit-test planner                                                   | Full WASM artifact compiles test-mode sources and constructs the test plan with the root package name                                                                  | `equivalent-local`             | `blocked until fixture coverage` | Dependency tests are compiled but not run as root tests. Any upstream test-path conversion needs fixtures for root package ownership, dependency test compile failures, and test-only source inclusion.                 |
| Bytecode-only dependencies     | CLI Source/Bytecode package selection in compiler input                                         | Source snapshots are required for all dependencies                                                                                                                     | `different-unsupported`        | `blocked by disk/git cache`      | `.mv` fallback depends on bytecode artifact availability and package cache semantics outside the current snapshot contract. It must not be replaced by generated source or synthetic package metadata.                  |

Do not migrate to upstream `RootPackage`, `PackageGraphBuilder`, or `BuildPlan` by adding runtime filesystem or git-cache assumptions. The acceptable migration path is a snapshot-backed adapter plus fixtures that protect package order, address resolution, source discovery, lint behavior, lockfile generation, output dependencies, and test ownership.

### Snapshot Adapter Feasibility

Use these statuses when deciding the next implementation step:

- `direct`: can reuse the upstream helper without changing runtime package loading.
- `adapter-needed`: can be reused only after a snapshot-backed adapter provides the upstream input shape.
- `blocked`: not suitable for runtime reuse because it depends on disk roots, git/package cache, output cleanup, or unsupported bytecode artifacts.
- `do-not-reuse`: must remain outside runtime behavior.

| Upstream component / function               | Upstream input requirement                                                                   | Runtime reuse status | Implementation note                                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RootPackage::load`                         | Filesystem `PackagePath`, package lock, output path, lockfile/manifest loader, package cache | `adapter-needed`     | Needs a snapshot-backed root/package abstraction before use. Direct use would introduce runtime disk and lock assumptions.                                               |
| `PackageGraphBuilder::load_from_lockfile`   | `Lockfiles::read_from_dir`, `PackageCache::fetch`, pinned source fetches, package digests    | `adapter-needed`     | Candidate only after lockfile and dependency snapshots can be exposed through an upstream-compatible cache adapter.                                                      |
| `PackageGraphBuilder::load_from_manifests`  | `PackageCache::fetch`, recursive manifest deps, package paths for visited/cache keys         | `adapter-needed`     | The adapter must preserve requested and resolved source identity, same-name suffixing, cycle behavior, and local dependency loading.                                     |
| `PackageCache::fetch` / `Package::load`     | Fetches package content into cache-backed package paths                                      | `blocked`            | Runtime host loading must stay in TS; cache-backed disk fetching must not replace explicit `fetch`/`fetchLocal` contracts.                                               |
| `BuildPlan::compile_with_driver`            | `RootPackage`, build output directories, cleanup of old build artifacts                      | `adapter-needed`     | Build output cleanup is not a runtime concern; reuse requires a no-runtime-cleanup path or a snapshot-backed `RootPackage`.                                              |
| `compilation.rs::make_deps_for_compiler`    | `PackageInfo` nodes, named addresses, package IDs, package paths, source discovery           | `adapter-needed`     | Good medium-term target once the Rust package model can expose upstream-shaped package info over snapshots.                                                              |
| `source_discovery.rs::get_sources`          | Directory-backed `PackagePath` plus `BuildConfig`                                            | `adapter-needed`     | Runtime can reuse the directory rules, but in-memory snapshots need an equivalent source listing adapter.                                                                |
| `compilation.rs::compiler_flags`            | `BuildConfig`                                                                                | `adapter-needed`     | Prepared WASM stubs `move-package-alt-compilation`, so runtime uses a local adapter for the exposed fields. Keep new compiler option semantics aligned with this helper. |
| Sui `PackageDependencies::new`              | `RootPackage` package metadata after linkage                                                 | `adapter-needed`     | Reuse requires upstream-shaped graph/package metadata; zero/system filtering stays Rust-owned and fixture-covered.                                                       |
| `PackageGraph::to_pins` / lockfile writing  | Upstream package graph and pinned dependency information                                     | `adapter-needed`     | Reuse only after graph ownership is snapshot-backed; unsupported source forms must continue to fail clearly.                                                             |
| `BuildPlan::clean` and on-disk save helpers | Build output directories and filesystem cleanup                                              | `do-not-reuse`       | Runtime WASM builds return JS values and must not manage host output directories.                                                                                        |
| CLI bytecode-only dependency fallback       | Cached or on-disk `.mv` artifacts and Source/Bytecode package selection                      | `blocked`            | Separate feature; do not emulate with generated source or synthetic package metadata.                                                                                    |

The first implementation target should be the smallest `direct` or `adapter-needed` component whose behavior is already covered by fixtures. New adapter work must not add local package-manager semantics in TypeScript.

## 7) Testing

- **CLI**: `sui move test` compiles in test mode and runs the unit test runner.
- **Here (WASM/Rust)**:
  - **Compilation**: `compile_impl` accepts `test_mode: true` in `compileOptions`. This sets `Flags::testing()` and includes modules marked with `#[test_only]`.
  - **Execution**: In the full build, `test_impl` (exposed as `test`) takes the package source and dependencies, includes test-mode sources for root and dependency packages, constructs the test plan with the root package name, and runs tests using `move_unit_test::UnitTestingConfig` plus Sui natives. It returns a boolean pass/fail status and a string of output logs.

## Verification checklist (keep in sync)

- Same-name/different-source packages: keep the suffix/linkage behavior covered by parity tests and avoid silent source dedupe.
- Path sorting: keep source path ordering deterministic and verify against CLI outputs; avoid locale-dependent comparisons where sorting is used.
- Move.toml usage: use Rust `SourceManifest`/package-model parsing for compiler package groups. Manifest fallback planning, traversal/order extraction, and package-group construction are Rust-owned; TypeScript still performs host snapshot fetching.
- Module ordering: keep the root module topological ordering aligned with CLI dump output for parity fixtures.
- Outputs: BuildInfo/disassembly artifacts are CLI-only unless intentionally added to WASM.
- Stale V4 lockfiles: verify dependency digest mismatch and fetched-source-content drift before claiming lockfile parity.
- V4 lockfile graph loading: keep fixtures for same-name/different-source pins, undefined edges, local source pins through `fetchLocal`, and dependency snapshots missing `Move.toml`.
- Explicit system deps: `npm run test:output-deps` covers preserving a root-declared system dependency alias while omitting the same system package when it is not root-declared.
- Test mode: `npm run test:unit-test-ownership` covers the rule that dependency package tests are compiled but not run as root tests.
- Source discovery: `npm run test:source-discovery` covers the normal-build rule that `tests/*.move` must not leak into non-test builds and the test-mode rule that dependency tests are included in compiler input.
- Lint setup: `npm run test:compiler-lint` covers accepted `lintFlag` values and invalid value handling.

## 8) Implementation Defaults & Boundaries

- **Network Default**: If not specified, the build network defaults to `mainnet`; lockfile lookup then uses the active network/chain identifiers.
- **Address Injection**: Address handling combines parsed `Move.toml`, supported `Move.lock` environment data, `Published.toml`, and a unified named-address table. New package-manager address behavior should be tied to a pinned upstream source reference and a targeted parity fixture.
- **Test Filtering**: `move test` (WASM) constructs the test plan with the root package name and excludes dependency package `tests/` from root test execution. The surrounding compiler setup still uses local `PackagePaths` assembly rather than the full upstream `BuildPlan` path.
- **System Addresses**: `std` (0x1) and `sui` (0x2) are automatically defined in the compiler's address map if missing, ensuring standard library resolution.

## 9) Implementation Status

The `sui-move-wasm` Rust source and JS integration layer use pinned Move/Sui compiler crates where practical. TypeScript still owns host fetching and snapshot assembly; V4 lockfile and manifest fallback package semantics are Rust/WASM-owned for the supported shapes. V0/V1/V2/V3 `Move.lock` graph loading is intentionally not used as a pinned graph source.

- `sui-move-wasm/Cargo.toml` uses Move/Sui compiler crates from the pinned Sui build workspace.
- JS serializes package `edition` into `PackageGroup`; Rust deserializes it when constructing compiler input.
- Address handling supports `0x0` for unpublished packages and uses resolved original/latest IDs where available.
- Integration tests compare selected CLI and WASM outputs. Passing tests are evidence for covered fixtures only.

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

The `manifest_digest` field in generated Move.lock V4 is computed by Rust/WASM as part of lockfile generation. Rust parses the selected package manifest, applies supported implicit `sui/std` handling, and hashes the digest input.

1. Build `RepinTriggers { deps: BTreeMap<PackageName, ReplacementDependency> }`
2. Serialize with `toml_edit::ser::to_string()`
3. Hash result with SHA256
4. Format as uppercase hex

**Implementation Details:**

- `ManifestDependencyInfo` uses default enum serialization (NOT `#[serde(untagged)]`)
- `ReplacementDependency` uses `#[serde(flatten, default)]` attributes
- Intended to match the CLI for supported dependency shapes covered by the helper (git/local/system-style inputs). Other package-manager dependency forms should be verified before claiming parity.

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

For compiler input, Rust package-group construction prefers `originalId`, then falls back to `publishedAt`, then `0x0` for unpublished source packages. For emitted dependency IDs, Rust prefers `latestPublishedId`, then `publishedAt`, then `originalId`.

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
Published.toml → migrated V3 publication data when provided by the JS wrapper → None
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

- Generated Move.lock sections are sorted lexicographically by package ID/name by the Rust/WASM V4 lockfile generator.
- Compiler input order comes from Rust/WASM graph planning and linkage filtering for V4 lockfile and manifest fallback paths, not directly from declaration order in `Move.toml`.
- Rust output dependency IDs are sorted by package name before digest/output serialization, mirroring the upstream `PackageDependencies.published` `BTreeMap` shape.

### 12.2 Topological Sort

Rust/WASM graph helpers produce compiler and lockfile package order for V4 lockfile and manifest fallback paths. Rust then computes root module order using `move_bytecode_utils::Modules`. Parity tests compare the resulting module bytecode order against `sui move build --dump-bytecode-as-base64`.

---

## 13) System Package Exclusion

### 13.1 Excluded from Output

The following system packages are excluded from dependency output in Rust/WASM when they are implicit rather than root-declared:

| Address         | Package   |
| --------------- | --------- |
| `0x0000...0003` | SuiSystem |
| `0x0000...000b` | Bridge    |

### 13.2 CLI Source Reference

- `sui-types/src/lib.rs:130`: `SUI_SYSTEM_ADDRESS = 0x3`
- `sui-types/src/lib.rs:131`: `BRIDGE_ADDRESS = 0xb`
- `sui-move-build/src/lib.rs:616`: `p.published()` check filters unpublished deps

### 13.3 Filter Logic

Rust/WASM filters dependency IDs before serializing output and before computing the package digest:

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

`npm run test:parity:full` checks `dist/full`, `npm run test:parity:lite` checks `dist/lite`, and `npm run test:parity` runs both. The test warns when the local Sui CLI version differs from `sui-version.json` and fails when the CLI is missing. It also fails on any mismatch in module bytecode, dependency IDs, or package digest. Default test packages include auto-discovered packages from the pinned Sui checkout under `examples/move`, preferring packages with multiple Move source files, plus fixed framework fixtures at `crates/sui-framework/packages/deepbook` and `crates/sui-framework/packages/sui-system`. Explicit package paths can be passed to `test/integration/fidelity_test.mjs` when project-specific fixtures are available.

`npm run test:browser` uses Chrome headless and the Chrome DevTools Protocol to verify that both `dist/lite` and `dist/full` load and compile in a real browser environment. `npm run dev:browser-parity` serves an interactive browser page that loads Sui examples, local packages, or GitHub packages, builds them in the browser, and compares the browser WASM output against the local Sui CLI JSON output.

---

## 16) CLI Behavior References

### 16.1 Git Revision SHA Resolution

**CLI Source**: `pin.rs:61-63, 254-262`

CLI converts git branch/tag revisions to 40-character SHA during pinning:

```rust
/// Replace all dependencies in `deps` with their pinned versions:
///  - the revisions for git dependencies are replaced with 40-character shas
```

**WASM behavior**: `resolver.ts` calls `getResolvedSha()` after fetching to convert tags/branches to SHA.

### 16.2 Lockfile Dependency Source

**CLI Source**: `dependency_graph.rs:1284-1289`

CLI writes deps from `package_graph.edges()`, not from Move.toml:

```rust
let mut deps: Vec<_> = self
    .package_graph
    .edges(id)  // From graph edges, not manifest!
    .collect();
```

**WASM behavior**: Uses `depAliasToPackageName` from lockfile graph data before falling back to manifest dependency aliases.

### 16.3 Manifest Digest Calculation

**CLI Source**: `package_impl.rs:287-308`, `manifest.rs:155-170`

CLI computes `manifest_digest` from `CombinedDependency` which includes implicit deps:

```rust
fn compute_digest(deps: &[CombinedDependency]) -> String {
    // ... deps includes implicit system deps like sui, std ...
}
```

**WASM behavior**: Rust/WASM manifest digest helpers include supported implicit dependencies before hashing.

### 16.4 Multi-Environment Preservation

**CLI Source**: `root_package.rs:272-282`

CLI reads existing lockfile and only updates current environment:

```rust
lockfile.pinned.insert(
    self.environment.name.clone(),  // Only current env
    self.unfiltered_graph.to_pins()?,
);
```

**WASM behavior**: `lockfile_v4_generate` parses existing lockfile content and preserves other environment sections.

### 16.5 Diamond Dependency Support

**CLI Source**: `builder.rs:232-265`

CLI supports diamond dependencies where multiple packages may depend on the same package at different versions:

```rust
// create_ids logic
// CLI treats packages with same name but different sources as separate nodes
// and records them in lockfile as MoveStdlib, MoveStdlib_1, MoveStdlib_2
```

**WASM behavior**: Rust/WASM manifest and V4 lockfile graph helpers assign same-name package suffixes such as `_1` and `_2` before constructing compiler and lockfile package groups.

### 16.6 Sibling Package Sui Framework Sharing

**CLI Source**: `builder.rs:286`, `pin.rs:283-285`

When sibling packages from the same git repository depend on Sui framework, the CLI resolves them through the same fetched package path when the underlying tag resolves to the same SHA:

- CLI's `visited` map uses `(env, PackagePath)` as key
- `PackagePath` includes resolved SHA (not tag) from git cache
- Same `framework/mainnet` tag resolves to same SHA → same visited entry → same Sui node

**WASM behavior**: Rust/WASM plans git-sourced local dependencies as same-repository subdirs. TypeScript stores both the requested source and resolved fetch source so the Rust graph helper can match the same package across tag/SHA resolution.

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

**WASM behavior**: Rust/WASM manifest and V4 lockfile graph helpers build the linkage/compiler order used for package-group construction. The same graph output feeds compiler dependencies and lockfile dependencies for the supported paths.

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

- `scripts/prepare-wasm.mjs`, `scripts/build-prepared-wasm.mjs`, and `scripts/build-wasm.mjs` - WASM prepare/build flow
- `src/resolver.ts` - Runtime implicit dependency resolution

### Local Build Directories

The WASM build keeps upstream source and patched build state separate:

- `.sui-build/source/`: pristine Sui checkout pinned to `sui-version.json`
- `.sui-build/work/`: disposable git worktree used for overlaying `sui-move-wasm` and applying Cargo/WASM patches
- `.sui-build/generated/`: generated stubs, vendored compatibility sources, and local build tools

Only `.sui-build/work/` and `.sui-build/generated/` are modified during patching and compilation. The whole `.sui-build/` directory is ignored and should not be edited as project source. `npm run clean` removes `.sui-build/` and `dist/`; rerun `prepare:wasm` and the prepared build scripts to recreate them. `SUI_SOURCE_DIR` and `SUI_WORK_DIR` can override these paths for specialized local setups.

Every selected Sui version must have a configured `scripts/templates/v<templateVersion>/` compatibility template set. Missing templates are a porting blocker, so the build fails before patching instead of silently reusing another version.

The default development baseline remains `sui-version.json`. Other releases must be selected explicitly with `SUI_VERSION` plus `SUI_TAG`/`SUI_COMMIT`, or with equivalent `--sui-version`, `--sui-tag`, and `--sui-commit` script flags.
