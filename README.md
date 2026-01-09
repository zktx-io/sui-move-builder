# @zktx.io/sui-move-builder

Build Move packages in web or Node.js with Sui CLI-compatible dependency resolution and compilation.

## Features

- ✅ **Sui CLI Compatible**: Identical dependency resolution algorithm as Sui CLI
- ✅ **Lockfile Support**: Reads `Move.lock` for faster, deterministic builds
- ✅ **Per-Package Editions**: Each package can use its own Move edition (legacy, 2024.alpha, 2024.beta)
- ✅ **Monorepo Support**: Handles local dependencies in monorepo structures
- ✅ **Version Conflict Resolution**: Automatically resolves dependency version conflicts
- ✅ **Browser & Node.js**: Works in both environments with WASM-based compilation
- ✅ **GitHub Integration**: Fetches dependencies directly from git repositories

## Install

```bash
npm install @zktx.io/sui-move-builder
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
const result = await buildMovePackage({ files });

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
  "https://github.com/MystenLabs/sui/tree/framework/mainnet/crates/sui-framework/packages/sui-framework"
);

// Compile directly
const result = await buildMovePackage({ files });
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

## Dependency caching and reuse

For faster builds when compiling multiple times with the same dependencies, you can resolve dependencies once and reuse them:

```ts
import { 
  initMoveCompiler, 
  resolveDependencies, 
  buildMovePackage 
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
  resolvedDependencies: deps, // Skip dependency resolution
});

// Modify source code
files["sources/main.move"] = "// updated code...";

// 3. Build again with cached dependencies (much faster!)
const result2 = await buildMovePackage({
  files,
  network: "mainnet",
  resolvedDependencies: deps, // Reuse same dependencies
});
```

**Benefits:**
- ⚡ Faster builds when dependencies haven't changed
- 🔄 Useful for watch mode or iterative development
- 💾 Reduce network requests by caching dependency resolution

## Local test page

```
npm run serve:test   # serves ./test via python -m http.server
# open http://localhost:8000/test/index.html
```

## Source

> **Upstream source (Sui repository):** https://github.com/MystenLabs/sui
