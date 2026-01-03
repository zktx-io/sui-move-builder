# @zktx.io/sui-move-builder

Build Move packages in web or Node.js with dependency fetching and dump outputs.

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
const result = await buildMovePackage({ files, dependencies: {} });

if (result.success) {
  console.log(result.digest);
  console.log(result.modules); // Base64-encoded Move modules
} else {
  console.error(result.error);
}
```

## Resolving dependencies from GitHub (optional)

```ts
import { resolve, GitHubFetcher } from "@zktx.io/sui-move-builder";

const resolution = await resolve(
  files["Move.toml"],
  files,
  new GitHubFetcher()
);

const filesJson =
  typeof resolution.files === "string"
    ? JSON.parse(resolution.files)
    : resolution.files;
const depsJson =
  typeof resolution.dependencies === "string"
    ? JSON.parse(resolution.dependencies)
    : resolution.dependencies;

const result = await buildMovePackage({
  files: filesJson,
  dependencies: depsJson,
});

// Enable ANSI-colored diagnostics (CLI-like output)
const resultWithColor = await buildMovePackage({
  files: filesJson,
  dependencies: depsJson,
  ansiColor: true,
});
```

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
