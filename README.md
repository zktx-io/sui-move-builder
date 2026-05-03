# @zktx.io/sui-move-builder

> **Upstream source:** [MystenLabs/sui](https://github.com/MystenLabs/sui) (see `sui-version.json`)

Build Move packages in web or Node.js with a WASM compiler path that tracks the Sui CLI build pipeline where practical.

## Features

- **Sui CLI-oriented build flow**: Uses JavaScript for host fetching/snapshots and Rust/WASM for supported package graph, lockfile, compiler, and output semantics.
- **Parity harness**: Compares local Sui CLI output with full and lite WASM build outputs for selected packages.
- **Address resolution**: Tracks `original_id` for compilation and `published_at` / latest IDs for output metadata where available.
- **Lockfile handling**: Reads V4 pinned lockfiles, falls back from older lockfile graph formats to manifest resolution, and migrates supported V3 publish data when possible.
- **Move.lock V4 output**: Generates V4 lockfile content with deterministic pinned sections and `manifest_digest` values.
- **Published.toml support**: Reads deployment records per environment when present.
- **Per-package editions**: Preserves package editions such as legacy, 2024.alpha, and 2024.beta.
- **Monorepo support**: Converts local dependencies inside git-sourced packages to repository subdirectories.
- **Diamond dependency/linkage handling**: Keeps same-name package variants separate when the dependency graph requires it.
- **Browser and Node.js targets**: Provides WASM-based compilation for both environments, with browser smoke tests available.
- **GitHub integration**: Fetches Move package sources from GitHub repositories.
- **GitHub token support**: Optional token for GitHub API requests; raw file fetch is still available for browser use.

For detailed CLI behavior notes, see [CLI_PIPELINE.md](./CLI_PIPELINE.md).

## Install

```bash
npm install @zktx.io/sui-move-builder
```

## Lite vs Full Version

The package is published with two generated variants:

1. **Full Version (Default)**: Includes the WASM `testing` feature, which brings in `move-unit-test`, `sui-move-natives`, and `move-vm-runtime` for Move unit test execution.
2. **Lite Version**: Build-focused artifact without the WASM test runner dependencies. This is usually the better browser entrypoint when unit test execution is not needed.

### Using the Full Version (Default)

```ts
import {
  initMovePackageBuilder,
  dumpMovePackage,
  prepareMovePackagePublish,
  prepareMovePackageUpgrade,
  testMovePackage,
} from "@zktx.io/sui-move-builder";
```

### Using the Lite Version

```ts
import {
  initMovePackageBuilder,
  dumpMovePackage,
  prepareMovePackagePublish,
  prepareMovePackageUpgrade,
} from "@zktx.io/sui-move-builder/lite";
```

## Quick start (Node.js or browser)

```ts
import {
  initMovePackageBuilder,
  dumpMovePackage,
} from "@zktx.io/sui-move-builder";

// 1) Load the WASM once
await initMovePackageBuilder();

// 2) Prepare files as an in-memory folder (Move.toml + sources/*)
const files = {
  "Move.toml": `
[package]
name = "hello_world"
version = "0.0.1"

[addresses]
hello_world = "0x0"
`,
  "sources/hello_world.move": `
module hello_world::hello_world {
  // your code...
}
`,
};

// 3) Prepare CLI dump-style bytecode output
const result = await dumpMovePackage({
  files,
  // optional: silence warnings from Move compiler (default: false)
  silenceWarnings: false,
  // optional: enable test mode (include #[test_only] modules)
  testMode: false,
});

if ("error" in result) {
  console.error("Build failed:", result.error);
  console.error("Stage:", result.category);
  if (result.code) console.error("Code:", result.code);
} else {
  // Compilation outputs
  console.log("Modules:", result.modules); // Array<string>: Base64-encoded bytecode
  console.log("Dependencies:", result.dependencies); // Array<string>: Hex-encoded package IDs
  console.log("Digest:", result.digest); // Array<number>: Package digest bytes

  // Lockfile outputs
  console.log("Move.lock:", result.moveLock); // string: generated V4 lockfile content
  console.log("Environment:", result.environment); // string: e.g., "mainnet"

  // Migration output from supported V3 publication records
  if (result.publishedToml) {
    console.log("Published.toml:", result.publishedToml); // string: Migrated from V3 Move.lock publication records
  }

  // Warnings (if silenceWarnings: false)
  if (result.warnings) {
    console.warn("Warnings:", result.warnings);
  }
}
```

### Browser loading

The same package is intended for browser use. The lite build is usually the better browser entrypoint:

```ts
import {
  initMovePackageBuilder,
  dumpMovePackage,
} from "@zktx.io/sui-move-builder/lite";

await initMovePackageBuilder();
const result = await dumpMovePackage({ files });
```

Modern bundlers normally serve the bundled `sui_move_wasm_bg.wasm` next to the generated JS. If you host the WASM file yourself, pass its URL explicitly:

```ts
await initMovePackageBuilder({
  wasm: new URL("/assets/sui_move_wasm_bg.wasm", window.location.origin),
});
```

## Package preparation APIs

The package exposes intent-specific preparation APIs:

| API                         | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `dumpMovePackage`           | Prepare CLI dump-style `{ modules, dependencies, digest }` output      |
| `prepareMovePackagePublish` | Prepare modules, dependency IDs, and digest for a publish payload      |
| `prepareMovePackageUpgrade` | Prepare modules, dependency IDs, digest, and package ID for an upgrade |

These APIs do not sign transactions, choose gas/payment, build a complete PTB, dry-run, execute, or update on-chain publication records. Publish and upgrade preparation reject `testMode`.

## Running Tests

You can run Move unit tests using the `testMovePackage` function (available in the full version).

```ts
import { testMovePackage } from "@zktx.io/sui-move-builder";

const result = await testMovePackage({
  files,
  network: "mainnet",
});

if ("error" in result) {
  console.error("Test failed to run:", result.error);
  console.error("Stage:", result.category);
  if (result.code) console.error("Code:", result.code);
} else {
  console.log("Tests Passed:", result.passed);
  console.log("Output:", result.output);
}
```

### Build Options (`MovePackageInput`)

| Option                        | Type                                 | Description                                                                                         |
| :---------------------------- | :----------------------------------- | :-------------------------------------------------------------------------------------------------- |
| `files`                       | `Record<string, string>`             | **Required**. Virtual file system with `Move.toml` and sources                                      |
| `network`                     | `"mainnet" \| "testnet" \| "devnet"` | Network environment (default: `"mainnet"`)                                                          |
| `githubToken`                 | `string`                             | GitHub API token to increase rate limits                                                            |
| `fetcher`                     | `MovePackageFetcher`                 | Optional host loader for git and local dependency package snapshots                                 |
| `silenceWarnings`             | `boolean`                            | Suppress compiler warnings (default: `false`)                                                       |
| `testMode`                    | `boolean`                            | Compile in test mode (include `#[test_only]` modules)                                               |
| `withUnpublishedDependencies` | `boolean`                            | Compile unpublished dependencies as `0x0` package IDs                                               |
| `modes`                       | `string[]`                           | Move compiler modes, equivalent to CLI `--mode` values                                              |
| `lintFlag`                    | `"none" \| "default" \| "all"`       | Move compiler lint level. Defaults to `"none"`                                                      |
| `ansiColor`                   | `boolean`                            | Enable ANSI color codes in output                                                                   |
| `stripMetadata`               | `boolean`                            | Reserved for metadata stripping; currently passed through but not applied by the WASM compiler path |
| `onProgress`                  | `(event) => void`                    | Callback for build progress events                                                                  |

### Build Output Reference

| Field           | Type       | Description                                                |
| --------------- | ---------- | ---------------------------------------------------------- |
| `modules`       | `string[]` | Base64-encoded compiled bytecode modules                   |
| `dependencies`  | `string[]` | Hex-encoded package IDs for linking                        |
| `digest`        | `number[]` | Package digest bytes (32 bytes)                            |
| `moveLock`      | `string`   | Generated Move.lock V4 content                             |
| `environment`   | `string`   | Build environment (e.g., "mainnet", "testnet")             |
| `intent`        | `string`   | Preparation intent: `dump`, `publish`, or `upgrade`        |
| `packageId`     | `string?`  | Upgrade package ID returned by `prepareMovePackageUpgrade` |
| `publishedToml` | `string?`  | Migrated Published.toml from supported V3 records          |
| `warnings`      | `string?`  | Compiler warnings (if `silenceWarnings: false`)            |

Build and test failures return `{ error, category, code? }`. The `category` value is a broad stage label such as `dependency_resolution`, `input_validation`, `compile`, `compiler_output`, `lockfile_generation`, `test_runner`, `wasm_init`, or `unknown`; the `error` string remains the detailed diagnostic. `code` is present only when a Rust/WASM helper produced a structured failure code.

## Fetching packages from GitHub

```ts
import {
  fetchMovePackageFromGitHub,
  dumpMovePackage,
  initMovePackageBuilder,
} from "@zktx.io/sui-move-builder";

await initMovePackageBuilder();

// Fetch a package from GitHub URL
const files = await fetchMovePackageFromGitHub(
  "https://github.com/MystenLabs/sui/tree/framework/mainnet/crates/sui-framework/packages/sui-framework",
  {
    githubToken: process.env.GITHUB_TOKEN, // optional
  }
);

// Compile directly
const result = await dumpMovePackage({
  files,
  githubToken: process.env.GITHUB_TOKEN, // optional
});
```

## How it works

Dependencies are resolved from the package inputs and, where possible, follow the relevant Sui CLI build behavior:

1. **Checks `Move.lock` first**: V4 pinned lockfiles are used when available for the selected environment. Older lockfile graph formats are not used as pinned graph sources and fall back to manifest resolution where supported.
2. **Falls back to manifests**: If the lockfile path is missing or cannot be used, dependencies are resolved from `Move.toml` files.
3. **Handles V3 publish data**: Supported V3 `Move.lock` publication records can be migrated into `Published.toml` output.
4. **Handles monorepos**: Local dependencies inside git-sourced packages are converted to git subdirectories.
5. **Adds implicit framework dependencies**: The root package gets an implicit Sui framework dependency when it does not declare one.
6. **Generates lockfile metadata**: V4 output includes computed manifest digests, and V4 pin loading checks manifest digests through the Rust/WASM helper before trusting a lockfile.

```ts
import {
  initMovePackageBuilder,
  dumpMovePackage,
} from "@zktx.io/sui-move-builder";

await initMovePackageBuilder();

const files = {
  "Move.toml": `
[package]
name = "my_package"
edition = "2024.beta"

[dependencies]
dep_name = { git = "https://github.com/org/repo.git", subdir = "packages/dep_name", rev = "main" }
`,
  "sources/main.move": "...",
};

const result = await dumpMovePackage({ files });

if ("error" in result) {
  console.error("Build failed:", result.error);
} else {
  console.log("Modules:", result.modules); // Base64-encoded bytecode
  console.log("Dependencies:", result.dependencies); // Hex-encoded IDs
  console.log("Digest:", result.digest); // Package digest
}
```

## Development WASM Build Flow

The WASM build is split into a preparation step and a prepared build step:

```bash
npm run prepare:wasm
npm run build:wasm:prepared:lite # builds dist/lite from prepared state
npm run build:wasm:prepared:full # builds dist/full from prepared state
npm run build:wasm:prepared      # builds both variants from prepared state
npm run build:wasm          # prepare + prepared build
npm run build               # WASM build + JS package build
npm run release:check       # typecheck + lint + format check + tests
```

`prepare:wasm` may download or update the pinned Sui source, create a disposable patched worktree, generate compatibility stubs/vendor patches, and install the matching local `wasm-bindgen` tool. It removes stale patch state at startup and writes `.sui-build/patch-state.json` only after successful preparation. The `build:wasm:prepared:*` scripts expect that prepared state to already exist and use it to build `dist/lite`, `dist/full`, or both. Full builds run a Binaryen `wasm-opt` strip pass after `wasm-bindgen`; set `WASM_OPT=/path/to/wasm-opt` if it is not on `PATH`, or `SUI_WASM_SKIP_WASM_OPT=1` to build without that size post-processing. Prepared builds are best-effort offline builds; set `SUI_WASM_STRICT_OFFLINE=1` when you want Cargo to fail instead of reaching the network.

The build keeps the upstream Sui checkout separate from generated and patched state:

- `.sui-build/source/`: pristine Sui checkout at the commit in `sui-version.json`
- `.sui-build/work/`: disposable git worktree where `sui-move-wasm` is overlaid and Cargo/WASM compatibility patches are applied
- `.sui-build/generated/stubs/`: generated WASM compatibility stub crates
- `.sui-build/generated/vendor/`: vendored dependency sources that need local WASM patching
- `.sui-build/generated/local-bin/`: local build tools such as the pinned `wasm-bindgen`
- `.sui-build/patch-state.json`: successful prepare marker checked by `build:wasm:prepared`
- `dist/full` and `dist/lite`: generated npm artifacts

Only edit tracked project sources such as `src/`, `sui-move-wasm/`, and `scripts/compat/`. The `.sui-build/` directory is ignored build/cache state and can be removed with `npm run clean` together with `dist/`. Set `SUI_SOURCE_DIR` or `SUI_WORK_DIR` only when you intentionally want those directories somewhere else.

The active `scripts/compat/` directory is the WASM compatibility overlay for the pinned Sui version. Its `manifest.json` is checked by `prepare:wasm`. `npm run build:wasm` fails before modifying the worktree if the active overlay is missing required compat files.

The default patched baseline is the version in `sui-version.json`. For an intentional port to another Sui release, override it explicitly:

```bash
SUI_VERSION=1.x.y SUI_TAG=mainnet-v1.x.y npm run build:wasm
# or
node scripts/build-wasm.mjs --sui-version 1.x.y --sui-tag mainnet-v1.x.y
```

For repeated version updates, use the process and prompt in [AGENTS.md](./AGENTS.md). The intended flow is to refresh and test the active compat overlay during `prepare:wasm`, then reuse the prepared worktree for lite/full builds and release checks.

## Package Management Logic

This builder follows the implemented parts of the Sui CLI package-management precedence:

1. **API options**: Explicit options (e.g., `network`) take highest precedence.
2. **Move.lock**: V4 pinned sections are used when present for the active environment. Older lockfile graph formats fall back to manifests where supported, and supported V3 publication data may be migrated.
   - Published package addresses can come from lockfile environment records, `Published.toml`, or manifest metadata depending on the package and lockfile format.
3. **Move.toml**: Used when there is no usable lockfile path. Defines direct dependencies and their sources.
4. **Published.toml**:
   - Used to resolve published package IDs for the selected environment when available.
   - **Does not** override dependency resolution; it is primarily an output record of deployment.
   - If a package has matching publication data, the builder uses that information for compilation/output address handling.

## Dependency caching and reuse

For faster builds when compiling multiple times with the same dependencies, you can resolve dependencies once and reuse them:

```ts
import {
  initMovePackageBuilder,
  resolveMovePackageDependencies,
  dumpMovePackage,
} from "@zktx.io/sui-move-builder";

await initMovePackageBuilder();

const files = {
  "Move.toml": `...`,
  "sources/main.move": "...",
};

// 1. Resolve dependencies once
const deps = await resolveMovePackageDependencies({
  files,
  network: "mainnet",
});

// 2. Build multiple times without re-resolving dependencies
const result1 = await dumpMovePackage({
  files,
  network: "mainnet",
  githubToken: process.env.GITHUB_TOKEN, // optional
  resolvedDependencies: deps, // Skip dependency resolution
});

// Modify source code
files["sources/main.move"] = "// updated code...";

// 3. Build again with cached dependencies
const result2 = await dumpMovePackage({
  files,
  network: "mainnet",
  githubToken: process.env.GITHUB_TOKEN, // optional
  resolvedDependencies: deps, // Reuse same dependencies
});
```

**Benefits:**

- Faster builds when dependencies have not changed
- Useful for watch mode or iterative development
- Reduced network requests by caching dependency resolution

## Limitations

- Dependencies are always compiled from source. Bytecode-only deps (.mv fallback used by the Sui CLI when sources are missing) are not supported in the wasm path.
- V0/V1/V2/V3 `Move.lock` graph sections are not used as pinned graph sources. Supported packages fall back to manifest resolution; V3 publication migration is supported where covered by tests.
- Publish and upgrade APIs prepare bytecode payload data only. Transaction signing, gas selection, PTB construction, dry-run, execution, and post-execution publication record updates are outside the WASM package boundary.
- CLI parity is verified for selected fixtures, not for every Sui package-manager path. Some compiler and test-runner behavior is still implemented through local compatibility glue.

## Best Practices

### Input Sanitization

When preparing the `files` object for `dumpMovePackage`, **exclude build artifacts** (e.g., the `build/` directory) and version control folders (`.git/`). Including these can cause:

- **Compilation Errors**: Duplicate modules or incorrect edition parsing (e.g., dependency files treated as root sources).
- **Performance Issues**: Unnecessary processing of large binary files.

Example filtering logic:

```ts
if (entry.name === "build" || entry.name === ".git") continue;
```

## CLI-vs-WASM Parity Tests

This package compares the same local Move package through the official Sui CLI and the WASM builder. The default dump parity package set includes auto-discovered examples from `.sui-build/parity-work/examples/move` plus the fixed framework fixture at `crates/sui-framework/packages/deepbook`; pass explicit package paths when you want to test a specific fixture.

```bash
npm run build       # required once; produces dist/full and dist/lite WASM artifacts
npm test            # runtime + semantic fixtures + full/lite CLI parity
npm run test:parity # compare Sui CLI vs both full and lite WASM
npm run test:audit  # compare CLI build/upgrade artifacts with WASM outputs
npm run test:browser # optional local browser smoke test for full and lite
npm run dev:browser-parity # interactive browser build + CLI comparison page
node test/integration/run.mjs semantic # runtime + semantic fixtures without CLI parity
node test/integration/run.mjs output-deps # run a single integration case
```

`dist/` artifacts are generated output and are not checked into this repository. Runtime, parity, and browser tests expect `npm run build` to have produced `dist/full` and `dist/lite` first.

Useful options:

- `SUI_CLI=/path/to/sui` selects the local Sui CLI binary.
- `BROWSER_BIN=/path/to/chrome` selects the browser binary for `test:browser`.
- `SUI_PARITY_LIMIT=10` changes the number of auto-discovered examples. Fixed framework fixtures still run unless explicit package paths are supplied.
- `SUI_PARITY_MIN_MOVE_FILES=3` requires larger multi-file examples.

The integration runner executes checks serially. Parity, audit, and browser checks are not run concurrently because they use shared `.sui-build`, `dist`, and Sui CLI cache state.

The parity test warns when the local Sui CLI version differs from `sui-version.json` and fails when the CLI is missing. It fails on any mismatch in module bytecode, dependency IDs, or package digest. It does not patch outputs or maintain expected-result snapshots.

`node test/integration/run.mjs audit build` runs `sui move build --path <package> --install-dir <output>` for `crates/sui-framework/packages/sui-framework` and `crates/sui-framework/packages/sui-system`, converts generated `.mv` artifacts to base64, runs the low-level WASM `compile` binding with `compileIntent: "publish"`, and compares module bytecode.

`node test/integration/run.mjs audit upgrade` uses `sui move build --dump-bytecode-as-base64` as the CLI artifact source for upgrade-intent bytecode and compares it with `prepareMovePackageUpgrade` for published package fixtures. The comparison covers modules, dependency IDs, and digest.

Passing parity tests are evidence for the covered fixtures only. See `CLI_PIPELINE.md` for current implementation boundaries.

For manual browser verification, run `npm run dev:browser-parity` and open the printed `http://127.0.0.1:<port>/` URL. The page loads a Move package from the pinned Sui examples, a local package path, or a GitHub repository; builds it with the selected browser WASM artifact; asks the local server to build the same package with `sui move build --dump-bytecode-as-base64 --path <package>`; then compares module bytecode, dependency IDs, and digest.

## Support Status

| Area                                                       | Status                | Current contract                                                                                                                                                                                      |
| ---------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full upstream `BuildPlan` execution                        | `not used at runtime` | Runtime builds use the snapshot-backed Rust/WASM package model described in `CLI_PIPELINE.md`. Package order, address resolution, source discovery, lint, and test-mode behavior are fixture-covered. |
| Bytecode-only `.mv` dependency fallback                    | `unsupported`         | Source snapshots are required. The package does not synthesize source or package metadata to stand in for missing `.mv` fallback behavior.                                                            |
| `stripMetadata`                                            | `reserved/no-op`      | The option is part of the public shape but should not be described as active compiler behavior.                                                                                                       |
| Dev-address / extra named-address API                      | `not exposed`         | No stable public override API is exposed.                                                                                                                                                             |
| V0/V1/V2/V3 lockfile graph loading as pinned graph sources | `unsupported`         | Supported packages use manifest fallback instead; V3 publication migration is separate from graph loading.                                                                                            |
