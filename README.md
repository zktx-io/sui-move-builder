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
const result = await buildMovePackage({
  files,
  dependencies: {},
  autoSystemDeps: true, // Sui CLI-like defaults for std/Sui packages
});

if (result.success) {
  console.log(result.digest);
  console.log(result.modules); // Base64-encoded Move modules
} else {
  console.error(result.error);
}
```

## Fetching packages from GitHub

Use the utility functions to fetch Move packages directly from GitHub URLs:

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

// files = {
//   'Move.toml': '...',
//   'Move.lock': '...',
//   'sources/object.move': '...',
//   ...
// }

// Compile directly
const result = await buildMovePackage({ files });
```

### Fetch multiple packages

```ts
import { fetchPackagesFromGitHub, githubUrl } from "@zktx.io/sui-move-builder";

const packages = await fetchPackagesFromGitHub({
  Sui: githubUrl(
    "MystenLabs/sui",
    "framework/mainnet",
    "crates/sui-framework/packages/sui-framework"
  ),
  deepbook: githubUrl("MystenLabs/deepbookv3", "main", "packages/deepbook"),
});

// packages = {
//   'Sui': { 'Move.toml': '...', ... },
//   'deepbook': { 'Move.toml': '...', ... }
// }
```

## Resolving dependencies from GitHub

The dependency resolver works exactly like Sui CLI:

1. **Tries Move.lock first**: If a valid `Move.lock` exists, dependencies are loaded from it (faster, deterministic)
2. **Falls back to manifests**: If lockfile is missing/invalid, resolves dependencies from `Move.toml` files
3. **Validates digests**: Checks manifest digests to detect changes
4. **Handles monorepos**: Converts local dependencies to git dependencies automatically

```ts
import { resolve, GitHubFetcher } from "@zktx.io/sui-move-builder";

const files = {
  "Move.toml": `
[package]
name = "my_package"
edition = "2024.beta"

[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework/mainnet" }
deepbook = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/deepbook", rev = "main" }
`,
  "Move.lock": "...", // Optional: will be used if valid
  "sources/main.move": "...",
};

const resolution = await resolve(
  files["Move.toml"],
  files,
  new GitHubFetcher(),
  "mainnet" // network: 'mainnet' | 'testnet' | 'devnet'
);

const filesJson = JSON.parse(resolution.files);
const depsJson = JSON.parse(resolution.dependencies);

const result = await buildMovePackage({
  files: filesJson,
  dependencies: depsJson,
  autoSystemDeps: true,
});
```

### How it works

The resolver implements Sui CLI's 3-layer architecture:

1. **Layer 1: Dependency Graph**
   - Builds a DAG of all packages
   - Resolves transitive dependencies recursively
   - Handles version conflicts (first version wins)
   - Converts local dependencies to git dependencies for monorepos

2. **Layer 2: Address Resolution**
   - Creates unified address table
   - Resolves all named addresses across packages
   - Uses `Move.lock` addresses when available

3. **Layer 3: Compilation Format**
   - Groups dependencies by package
   - Each package compiles with its own edition
   - Prepares format for WASM compiler

`buildMovePackage` returns:

- `success: true | false`
- on success: `modules` (Base64), `dependencies`, `digest`
- on failure: `error` with compiler logs

## Local test page

```
npm run serve:test   # serves ./test via python -m http.server
# open http://localhost:8000/test/index.html
```

## Source

> **Upstream source (Sui repository):** https://github.com/MystenLabs/sui
