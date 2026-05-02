# @zktx.io/sui-move-builder

> **Upstream source:** [MystenLabs/sui](https://github.com/MystenLabs/sui) (see `sui-version.json`)

Build Move packages in web or Node.js with a WASM compiler path that tracks the Sui CLI build pipeline where practical.

## Features

- **Sui CLI-oriented build flow**: Resolves dependencies in JavaScript and compiles through the Move compiler compiled to WASM.
- **Parity harness**: Compares local Sui CLI output with full and lite WASM build outputs for selected packages.
- **Address resolution**: Tracks `original_id` for compilation and `published_at` / latest IDs for output metadata where available.
- **Lockfile handling**: Reads V4 pinned lockfiles, handles older lockfile layouts on a best-effort basis, and migrates legacy publish data when possible.
- **Move.lock V4 output**: Generates V4 lockfile content with deterministic pinned sections and `manifest_digest` values.
- **Published.toml support**: Reads deployment records per environment when present.
- **Per-package editions**: Preserves package editions such as legacy, 2024.alpha, and 2024.beta.
- **Monorepo support**: Converts local dependencies inside git-sourced packages to repository subdirectories.
- **Diamond dependency/linkage handling**: Keeps same-name package variants separate when the dependency graph requires it.
- **Browser and Node.js targets**: Provides WASM-based compilation for both environments, with browser smoke tests available.
- **GitHub integration**: Fetches Move package sources from GitHub repositories.
- **GitHub token support**: Optional token for GitHub API requests; raw file fetches stay browser/CORS-friendly.

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
  initMoveCompiler,
  buildMovePackage,
  testMovePackage,
} from "@zktx.io/sui-move-builder";
```

### Using the Lite Version

```ts
import {
  initMoveCompiler,
  buildMovePackage,
} from "@zktx.io/sui-move-builder/lite";
```

## Quick start (Node.js or browser)

```ts
import { initMoveCompiler, buildMovePackage } from "@zktx.io/sui-move-builder";

// 1) Load the WASM once
await initMoveCompiler();

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

// 3) Compile
const result = await buildMovePackage({
  files,
  // optional: silence warnings from Move compiler (default: false)
  silenceWarnings: false,
  // optional: enable test mode (include #[test_only] modules)
  testMode: false,
});

if ("error" in result) {
  console.error("Build failed:", result.error);
} else {
  // Compilation outputs
  console.log("Modules:", result.modules); // Array<string>: Base64-encoded bytecode
  console.log("Dependencies:", result.dependencies); // Array<string>: Hex-encoded package IDs
  console.log("Digest:", result.digest); // Array<number>: Package digest bytes

  // Lockfile outputs
  console.log("Move.lock:", result.moveLock); // string: generated V4 lockfile content
  console.log("Environment:", result.environment); // string: e.g., "mainnet"

  // Migration output (V3 → V4)
  if (result.publishedToml) {
    console.log("Published.toml:", result.publishedToml); // string: Migrated from legacy Move.lock
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
  initMoveCompiler,
  buildMovePackage,
} from "@zktx.io/sui-move-builder/lite";

await initMoveCompiler();
const result = await buildMovePackage({ files });
```

Modern bundlers normally serve the bundled `sui_move_wasm_bg.wasm` next to the generated JS. If you host the WASM file yourself, pass its URL explicitly:

```ts
await initMoveCompiler({
  wasm: new URL("/assets/sui_move_wasm_bg.wasm", window.location.origin),
});
```

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
} else {
  console.log("Tests Passed:", result.passed);
  console.log("Output:", result.output);
}
```

### Build Options (`BuildInput`)

| Option            | Type                                 | Description                                                                                         |
| :---------------- | :----------------------------------- | :-------------------------------------------------------------------------------------------------- |
| `files`           | `Record<string, string>`             | **Required**. Virtual file system with `Move.toml` and sources                                      |
| `network`         | `"mainnet" \| "testnet" \| "devnet"` | Network environment (default: `"mainnet"`)                                                          |
| `githubToken`     | `string`                             | GitHub API token to increase rate limits                                                            |
| `fetcher`         | `Fetcher`                            | Optional host loader for git and local dependency package snapshots                                 |
| `silenceWarnings` | `boolean`                            | Suppress compiler warnings (default: `false`)                                                       |
| `testMode`        | `boolean`                            | Compile in test mode (include `#[test_only]` modules)                                               |
| `lintFlag`        | `"none" \| "default" \| "all"`       | Move compiler lint level. Defaults to `"none"`                                                      |
| `ansiColor`       | `boolean`                            | Enable ANSI color codes in output                                                                   |
| `stripMetadata`   | `boolean`                            | Reserved for metadata stripping; currently passed through but not applied by the WASM compiler path |
| `onProgress`      | `(event) => void`                    | Callback for build progress events                                                                  |

### Build Output Reference

| Field           | Type       | Description                                     |
| --------------- | ---------- | ----------------------------------------------- |
| `modules`       | `string[]` | Base64-encoded compiled bytecode modules        |
| `dependencies`  | `string[]` | Hex-encoded package IDs for linking             |
| `digest`        | `number[]` | Package digest bytes (32 bytes)                 |
| `moveLock`      | `string`   | Generated Move.lock V4 content                  |
| `environment`   | `string`   | Build environment (e.g., "mainnet", "testnet")  |
| `publishedToml` | `string?`  | Migrated Published.toml (if V3→V4 migration)    |
| `warnings`      | `string?`  | Compiler warnings (if `silenceWarnings: false`) |

## Fetching packages from GitHub

```ts
import {
  fetchPackageFromGitHub,
  buildMovePackage,
  initMoveCompiler,
} from "@zktx.io/sui-move-builder";

await initMoveCompiler();

// Fetch a package from GitHub URL
const files = await fetchPackageFromGitHub(
  "https://github.com/MystenLabs/sui/tree/framework/mainnet/crates/sui-framework/packages/sui-framework",
  {
    githubToken: process.env.GITHUB_TOKEN, // optional
  }
);

// Compile directly
const result = await buildMovePackage({
  files,
  githubToken: process.env.GITHUB_TOKEN, // optional
});
```

## How it works

Dependencies are resolved from the package inputs and, where possible, follow the relevant Sui CLI build behavior:

1. **Checks `Move.lock` first**: V4 pinned lockfiles are used when available for the selected environment; legacy lockfiles are handled on a best-effort basis.
2. **Falls back to manifests**: If the lockfile path is missing or cannot be used, dependencies are resolved from `Move.toml` files.
3. **Handles legacy publish data**: Legacy `Move.lock` publication records can be migrated into `Published.toml` output.
4. **Handles monorepos**: Local dependencies inside git-sourced packages are converted to git subdirectories.
5. **Adds implicit framework dependencies**: The root package gets an implicit Sui framework dependency when it does not declare one.
6. **Generates lockfile metadata**: V4 output includes computed manifest digests, and V4 pin loading checks manifest digests through the Rust/WASM helper before trusting a lockfile.

```ts
import { initMoveCompiler, buildMovePackage } from "@zktx.io/sui-move-builder";

await initMoveCompiler();

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

const result = await buildMovePackage({ files });

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
npm run build:wasm:prepared:all  # builds both variants from prepared state
npm run build:wasm:prepared      # alias for build:wasm:prepared:all
npm run build:wasm          # compatibility script: prepare + prepared build
npm run build               # WASM build + JS package build
npm run release:check       # typecheck + lint + format check + tests
```

`prepare:wasm` may download or update the pinned Sui source, create a disposable patched worktree, generate compatibility stubs/vendor patches, and install the matching local `wasm-bindgen` tool. The `build:wasm:prepared:*` scripts expect that prepared state to already exist and use it to build `dist/lite`, `dist/full`, or both. Prepared builds are best-effort offline builds; set `SUI_WASM_STRICT_OFFLINE=1` when you want Cargo to fail instead of reaching the network.

The build keeps the upstream Sui checkout separate from generated and patched state:

- `.sui-build/source/`: pristine Sui checkout at the commit in `sui-version.json`
- `.sui-build/work/`: disposable git worktree where `sui-move-wasm` is overlaid and Cargo/WASM compatibility patches are applied
- `.sui-build/generated/stubs/`: generated WASM compatibility stub crates
- `.sui-build/generated/vendor/`: vendored dependency sources that need local WASM patching
- `.sui-build/generated/local-bin/`: local build tools such as the pinned `wasm-bindgen`
- `.sui-build/patch-state.json`: prepared workspace metadata checked by `build:wasm:prepared`
- `dist/full` and `dist/lite`: generated npm artifacts

Only edit tracked project sources such as `src/`, `sui-move-wasm/`, and `scripts/templates/`. The `.sui-build/` directory is ignored build/cache state. Set `SUI_SOURCE_DIR` or `SUI_WORK_DIR` only when you intentionally want those directories somewhere else.

Each Sui version needs a matching `scripts/templates/v<version>/` WASM compatibility template set with a `manifest.json` checked by `prepare:wasm`. `npm run build:wasm` fails before modifying the worktree if the selected version has not been ported yet.

The default patched baseline is the version in `sui-version.json`. For an intentional port to another Sui release, override it explicitly:

```bash
SUI_VERSION=1.x.y SUI_TAG=mainnet-v1.x.y npm run build:wasm
# or
node scripts/build-wasm.mjs --sui-version 1.x.y --sui-tag mainnet-v1.x.y
```

For repeated version updates, use the process and prompt in [AGENTS.md](./AGENTS.md). The intended flow is to generate and test the new patch/template set during `prepare:wasm`, then reuse the prepared worktree for lite/full builds and release checks.

## Package Management Logic

This builder follows the Sui CLI package-management precedence where that behavior is implemented in the WASM path:

1. **CLI Overrides**: Explicit options (e.g., `network`) take highest precedence.
2. **Move.lock**: V4 pinned sections are used when present for the active environment. Legacy V3 publication data may be migrated, and dependency resolution can fall back to manifests.
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
  initMoveCompiler,
  resolveDependencies,
  buildMovePackage,
} from "@zktx.io/sui-move-builder";

await initMoveCompiler();

const files = {
  "Move.toml": `...`,
  "sources/main.move": "...",
};

// 1. Resolve dependencies once
const deps = await resolveDependencies({ files, network: "mainnet" });

// 2. Build multiple times without re-resolving dependencies
const result1 = await buildMovePackage({
  files,
  network: "mainnet",
  githubToken: process.env.GITHUB_TOKEN, // optional
  resolvedDependencies: deps, // Skip dependency resolution
});

// Modify source code
files["sources/main.move"] = "// updated code...";

// 3. Build again with cached dependencies
const result2 = await buildMovePackage({
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
- CLI parity is verified for selected fixtures, not for every Sui package-manager path. Some lockfile, system dependency, and test-runner behavior is still implemented through local compatibility glue.

## Best Practices

### Input Sanitization

When preparing the `files` object for `buildMovePackage`, **exclude build artifacts** (e.g., the `build/` directory) and version control folders (`.git/`). Including these can cause:

- **Compilation Errors**: Duplicate modules or incorrect edition parsing (e.g., dependency files treated as root sources).
- **Performance Issues**: Unnecessary processing of large binary files.

Example filtering logic:

```ts
if (entry.name === "build" || entry.name === ".git") continue;
```

## CLI-vs-WASM Parity Tests

This package compares the same local Move package through the official Sui CLI and the WASM builder. The default package set includes auto-discovered examples from `.sui-build/parity-work/examples/move` plus fixed framework fixtures at `crates/sui-framework/packages/deepbook` and `crates/sui-framework/packages/sui-system`; pass explicit package paths when you want to test a specific fixture.

```bash
npm run build       # required once; produces dist/full and dist/lite WASM artifacts
npm run test:dist-load # validate dist full/lite ESM/CJS loading
npm run test:template-manifest # validate versioned template manifest coverage
npm run test:package-loading # validate git/local package snapshot loading boundaries
npm run test:manifest-digest # validate Rust Move.toml manifest digest helper
npm run test:manifest-fallback # validate Rust-owned manifest fallback package groups
npm run test:lockfile-graph # validate lockfile digest and malformed graph handling
npm run test:lockfile-generation # validate Rust-owned V4 lockfile generation
npm run test:source-discovery # validate normal build source filtering
npm run test:compiler-lint # validate compiler lintFlag handling
npm run test:output-deps # validate explicit system dependency output filtering
npm run test:unit-test-ownership # validate full test runner root package ownership
npm run test:parity:full # compare Sui CLI vs full WASM
npm run test:parity:lite # compare Sui CLI vs lite WASM
npm run test:parity # compare Sui CLI vs both full and lite WASM
npm run test:browser # optional local browser smoke test for full and lite
npm run dev:browser-parity # interactive browser build + CLI comparison page
npm test            # runtime + semantic fixtures + full/lite CLI parity
```

`dist/` artifacts are generated output and are not checked into this repository. Runtime, parity, and browser tests expect `npm run build` to have produced `dist/full` and `dist/lite` first.

Useful options:

- `SUI_CLI=/path/to/sui` selects the local Sui CLI binary.
- `BROWSER_BIN=/path/to/chrome` selects the browser binary for `test:browser`.
- `SUI_PARITY_LIMIT=10` changes the number of auto-discovered examples. Fixed framework fixtures still run unless explicit package paths are supplied.
- `SUI_PARITY_MIN_MOVE_FILES=3` requires larger multi-file examples.

The parity test warns when the local Sui CLI version differs from `sui-version.json` and fails when the CLI is missing. It fails on any mismatch in module bytecode, dependency IDs, or package digest. It does not patch outputs or maintain expected-result snapshots.

Passing parity tests are evidence for the covered fixtures only. See `CLI_PIPELINE.md` for current implementation boundaries.

For manual browser verification, run `npm run dev:browser-parity` and open the printed `http://127.0.0.1:<port>/` URL. The page loads a Move package from the pinned Sui examples, a local package path, or a GitHub repository; builds it with the selected browser WASM artifact; asks the local server to build the same package with `sui move build --dump-bytecode-as-base64 --path <package>`; then compares module bytecode, dependency IDs, and digest.

## Planned Work

- **BuildPlan-equivalent compiler path**: Reduce direct `PackagePaths` assembly where upstream Sui compiler/package-manager behavior can be reused.
- **Legacy graph cleanup**: Decide whether v0/v1/v2 lockfile compatibility should remain best-effort or move behind the Rust package model.
- **Legacy lockfiles**: Keep V3 migration behavior explicit and covered by fixtures where supported.
- **Published.toml generation**: Generate deployment records after successful publication when this package adds publish support.
- **Bytecode dependencies**: Support `.mv`-only dependency fallback used by the Sui CLI when sources are unavailable.
