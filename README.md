# @zktx.io/sui-move-builder

> **Upstream source:** [MystenLabs/sui](https://github.com/MystenLabs/sui) (see `sui-version.json`)

Build Sui Move package snapshots in browser or Node.js with WASM artifacts built from pinned Sui source.

This package compiles source snapshots and prepares bytecode payload data. It does not sign transactions, choose gas, execute transactions, fetch RPC data, or scan a host filesystem package root.

## Install

```bash
npm install @zktx.io/sui-move-builder
```

## Entries

| Entry        | Import path                              | Use                                                                   |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| Lite         | `@zktx.io/sui-move-builder`              | Build, publish preparation, upgrade preparation                       |
| Full         | `@zktx.io/sui-move-builder/full`         | Lite APIs plus `testMovePackage`                                      |
| Verification | `@zktx.io/sui-move-builder/verification` | Rebuild source and compare it with caller-provided reference bytecode |

The verification entry bundles the current verifier and decoded-bytecode-version 6 verifier artifacts. It selects the verifier from the decoded bytecode version in `reference.modules`.

## Build A Package

```ts
import {
  initMovePackageBuilder,
  dumpMovePackage,
} from "@zktx.io/sui-move-builder";

await initMovePackageBuilder();

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
  public fun hello() {}
}
`,
};

const result = await dumpMovePackage({ files });

if ("error" in result) {
  console.error(result.category, result.error);
} else {
  console.log(result.modules);
  console.log(result.dependencies);
  console.log(result.digest);
  console.log(result.moveLock);
}
```

`dumpMovePackage` returns base64 modules, dependency package IDs, package digest bytes, generated `Move.lock` content, and compiler warnings when available.

## Prepare Publish Or Upgrade

```ts
import {
  initMovePackageBuilder,
  prepareMovePackagePublish,
  prepareMovePackageUpgrade,
} from "@zktx.io/sui-move-builder";

await initMovePackageBuilder();

const publish = await prepareMovePackagePublish({
  files,
  network: "mainnet",
});

const upgrade = await prepareMovePackageUpgrade({
  files,
  network: "mainnet",
});
```

These APIs prepare bytecode payload data only. The calling app remains responsible for wallet flow, transaction construction, signing, execution, and persistence.

## Update Publication Files

After a successful external publish or upgrade transaction, use `updateMovePackagePublication` to update caller-owned package files.

```ts
import {
  prepareMovePackagePublish,
  updateMovePackagePublication,
} from "@zktx.io/sui-move-builder";

const prepared = await prepareMovePackagePublish({ files, network: "testnet" });
if ("error" in prepared) throw new Error(prepared.error);

const filesWithLock = { ...files, "Move.lock": prepared.moveLock };

// Build, sign, and execute the transaction in your app.
const result = await signAndExecuteTransaction({ transaction });
const { chainIdentifier } = await client.core.getChainIdentifier();

const updated = await updateMovePackagePublication({
  files: filesWithLock,
  prepared,
  result,
  network: "testnet",
  chainId: chainIdentifier,
});
```

Upgrade publication updates require existing publication data for the selected environment so the original package ID and UpgradeCap ID can be preserved.

## Run Move Unit Tests

`testMovePackage` is available from the full entry.

```ts
import {
  initMovePackageBuilder,
  testMovePackage,
} from "@zktx.io/sui-move-builder/full";

await initMovePackageBuilder();

const result = await testMovePackage({
  files,
  network: "mainnet",
});
```

`testMovePackage` returns the Move unit-test runner stdout in `output`. It does not expose CLI test-runner flags such as filter, list, thread count, statistics, or random-test options.

## Verify Source Against Reference Bytecode

```ts
import {
  initMovePackageVerifier,
  verifyMovePackageProvenance,
} from "@zktx.io/sui-move-builder/verification";

await initMovePackageVerifier();

const result = await verifyMovePackageProvenance({
  files,
  intent: "publish",
  reference: {
    modules: publishModules,
    dependencies: publishDependencies,
    packageId,
  },
});
```

Use `intent: "publish"` for publish transaction modules or publish `.mv` artifacts. Use `intent: "upgrade"` for upgrade transaction modules or upgrade preparation output.

For publish transaction payload modules that keep the package self address as `0x0`, provide `reference.packageId` as deployed package metadata and do not provide `reference.rootAddress`. Use `reference.rootAddress` only when the reference bytecode already contains the published package address as the module self address; it explicitly rewrites the current build's module identity for semantic comparison.

`verified` with `exact_bytecode_match` means the rebuilt raw modules match the reference bytes. Other statuses and verdicts are comparison evidence, not transaction execution results. See [VERIFICATION.md](./VERIFICATION.md).

## Fetch From GitHub

```ts
import {
  fetchMovePackageFromGitHub,
  dumpMovePackage,
  initMovePackageBuilder,
} from "@zktx.io/sui-move-builder";

await initMovePackageBuilder();

const input = await fetchMovePackageFromGitHub(
  "https://github.com/<owner>/<repo>/tree/<ref>/<path-to-move-package>",
  {
    githubToken: process.env.GITHUB_TOKEN,
  }
);

const result = await dumpMovePackage(input);
```

For local or custom dependency sources, provide package snapshots through `fetcher`. Browser builds should not assume direct host filesystem access.

## Browser Loading

Modern bundlers usually serve the bundled `sui_move_wasm_bg.wasm` next to the generated JS. If you host the WASM file yourself, pass its URL:

```ts
await initMovePackageBuilder({
  wasm: new URL("/assets/sui_move_wasm_bg.wasm", window.location.origin),
});
```

## Main Input Options

| Option                        | Type                                 | Notes                                                              |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `files`                       | `Record<string, string>`             | Required virtual package files such as `Move.toml` and `sources/*` |
| `network`                     | `"mainnet" \| "testnet" \| "devnet"` | Defaults to `mainnet`                                              |
| `githubToken`                 | `string`                             | Optional GitHub API token                                          |
| `fetcher`                     | `MovePackageFetcher`                 | Optional host loader for git and local dependency snapshots        |
| `silenceWarnings`             | `boolean`                            | Suppress compiler warnings                                         |
| `withUnpublishedDependencies` | `boolean`                            | Compile unpublished dependencies as `0x0` package IDs              |
| `modes`                       | `string[]`                           | Move compiler modes                                                |
| `lintFlag`                    | `"none" \| "default" \| "all"`       | Defaults to `none`                                                 |
| `ansiColor`                   | `boolean`                            | Enable ANSI output                                                 |
| `stripMetadata`               | `boolean`                            | Reserved; currently passed through but not applied                 |
| `onProgress`                  | `(event) => void`                    | Build progress callback                                            |

Build and test failures return `{ error, category, code? }`. `category` is a broad stage label; `error` is the detailed diagnostic.

## Practical Limits

- Source snapshots are required. Bytecode-only dependency fallback is not supported.
- Publish and upgrade helpers prepare bytecode payload data; they do not execute transactions.
- Older `Move.lock` graph formats are not used as pinned dependency graphs. Supported packages fall back to manifest resolution.
- Browser-compatible WASM builds use declared compatibility replacements for some host and native crates.

## More Documentation

| Document                                                     | Role                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| [VERIFICATION.md](./VERIFICATION.md)                         | Verification input, status, verdict, decoded bytecode version routing |
| [PACKAGE_BEHAVIOR.md](./PACKAGE_BEHAVIOR.md)                 | Package resolution behavior, output fields, limitations               |
| [DEVELOPMENT.md](./DEVELOPMENT.md)                           | Build, test, and release checks for this repository                   |
| [CLI_PIPELINE.md](./CLI_PIPELINE.md)                         | Implementation boundaries and covered CLI/WASM comparison stages      |
| [SECURITY.md](./SECURITY.md)                                 | WASM runtime boundary and compatibility replacement inventory         |
| [BYTECODE_VERSION_HISTORY.md](./BYTECODE_VERSION_HISTORY.md) | Decoded bytecode version source records used for verifier selection   |
