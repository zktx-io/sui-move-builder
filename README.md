# @zktx.io/sui-move-builder

> **Upstream source:** [MystenLabs/sui](https://github.com/MystenLabs/sui) (tag: `testnet-v1.63.1`)

Build Move packages in web or Node.js with Sui CLI-compatible dependency resolution and compilation.

## Features

- ✅ **Sui CLI Compatible**: Identical dependency resolution algorithm as Sui CLI
- ✅ **Lockfile Support**: Reads `Move.lock` for faster, deterministic builds
- ✅ **Per-Package Editions**: Each package can use its own Move edition (legacy, 2024.alpha, 2024.beta)
- ✅ **Monorepo Support**: Handles local dependencies in monorepo structures
- ✅ **Version Conflict Detection**: Matches Sui CLI behavior for conflicting dependency versions
- ✅ **Browser & Node.js**: Works in both environments with WASM-based compilation
- ✅ **GitHub Integration**: Fetches dependencies directly from git repositories
- ✅ **GitHub Token Support**: Optional token to raise rate limits (API calls only; raw fetch remains CORS-safe)

## Install

```bash
npm install @zktx.io/sui-move-builder
```

## Lite vs Full Version

The package comes in two variants:

1. **Full Version (Default)**: ~12MB. Includes `move-unit-test`, `sui-move-natives`, and testing capabilities.
2. **Lite Version**: ~5.1MB. Build-only. **Recommended for frontend applications** where testing infrastructure is not needed.

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
  // optional: bump GitHub API limits during dependency resolution
  githubToken: process.env.GITHUB_TOKEN,
  // optional: silence warnings from Move compiler
  silenceWarnings: true,
  // optional: enable test mode (include #[test_only] modules)
  testMode: false,
  // optional: set linting level (default: "all")
  lintFlag: "all",
});

if (result.success) {
  console.log("Digest:", result.digest);
  console.log("Modules:", result.modules); // Base64-encoded bytecode
} else {
  console.error("Build failed:", result.error);
}
```

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

Dependencies are automatically resolved from `Move.toml`:

1. **Tries Move.lock first**: If a valid `Move.lock` exists, dependencies are loaded from it (faster, deterministic)
2. **Falls back to manifests**: If lockfile is missing/invalid, resolves dependencies from `Move.toml` files
3. **Validates digests**: Checks manifest digests to detect changes
4. **Handles monorepos**: Converts local dependencies to git dependencies automatically
5. **Injects system packages**: Automatically adds Sui, MoveStdlib, SuiSystem, and Bridge packages if missing

```ts
import { initMoveCompiler, buildMovePackage } from "@zktx.io/sui-move-builder";

await initMoveCompiler();

const files = {
  "Move.toml": `
[package]
name = "my_package"
edition = "2024.beta"

[dependencies]
deepbook = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/deepbook", rev = "main" }
`,
  "sources/main.move": "...",
};

const result = await buildMovePackage({ files });

if (result.success) {
  console.log("Modules:", result.modules); // Base64-encoded bytecode
  console.log("Dependencies:", result.dependencies); // Hex-encoded IDs
  console.log("Digest:", result.digest); // Package digest
} else {
  console.error("Build failed:", result.error);
}
```

## Package Management Logic

This builder follows the official Sui CLI precedence rules for package management:

1. **CLI Overrides**: Explicit options (e.g., `network`) take highest precedence.
2. **Move.lock**: If present and valid, dependencies are resolved exactly as pinned in the lockfile. This ensures deterministic builds.
   - The addresses of dependencies (e.g., `Sui`, `Std`) are determined by the lockfile's `[move.package.addresses]` section for the active environment (e.g., `devnet`, `mainnet`).
3. **Move.toml**: Used if no lockfile exists or if it is invalid. Defines direct dependencies and their sources.
4. **Published.toml**:
   - Used to resolve the `published-at` address (original ID) for the root package if available.
   - **Does not** override dependency resolution; it is primarily an output record of deployment.
   - If a package is listed in `Published.toml` with a matching `id`, the builder uses that ID for linking, similar to how the Sui CLI handles upgrades.

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

// 3. Build again with cached dependencies (much faster!)
const result2 = await buildMovePackage({
  files,
  network: "mainnet",
  githubToken: process.env.GITHUB_TOKEN, // optional
  resolvedDependencies: deps, // Reuse same dependencies
});
```

**Benefits:**

- ⚡ Faster builds when dependencies haven't changed
- 🔄 Useful for watch mode or iterative development
- 💾 Reduce network requests by caching dependency resolution

## Limitations

- Dependencies are always compiled from source. Bytecode-only deps (.mv fallback used by the Sui CLI when sources are missing) are not supported in the wasm path.

## Best Practices

### Input Sanitization

When preparing the `files` object for `buildMovePackage`, **exclude build artifacts** (e.g., the `build/` directory) and version control folders (`.git/`). Including these can cause:

- **Compilation Errors**: Duplicate modules or incorrect edition parsing (e.g., dependency files treated as root sources).
- **Performance Issues**: Unnecessary processing of large binary files.

Example filtering logic:

```ts
if (entry.name === "build" || entry.name === ".git") continue;
```

## Local test page

```
npm run serve:test   # serves ./test via python -m http.server
# open http://localhost:8000/test/index.html
```
