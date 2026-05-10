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

For publish transaction payload modules that keep the package self address as `0x0`, provide `reference.packageId` as deployed package metadata and do not provide `reference.rootAddress`. Do not pass both `reference.packageId` and `reference.rootAddress` when verifying normal publish transaction payload modules whose package self address is `0x0`. Use `reference.rootAddress` only when the reference bytecode already contains the published package address as the module self address; it explicitly rewrites the current build's module identity for semantic comparison.

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

The verification entry can also lazy-load decoded-bytecode-version 6 verifier modules. Browser deployments that use `@zktx.io/sui-move-builder/verification` must publish the routed verifier JS and WASM files with the app assets:

- `v6/classic/sui_move_wasm.js`
- `v6/classic/sui_move_wasm_bg.wasm`
- `v6/v7source-2024/sui_move_wasm.js`
- `v6/v7source-2024/sui_move_wasm_bg.wasm`

If your bundler emits the verification entry under `/assets`, these files are requested under `/assets/v6/...`. A missing routed verifier JS file fails before source comparison with a dynamic import error.

If your app hosts routed verifier files under a browser asset prefix, pass a root-relative or absolute HTTP(S) base URL:

```ts
const result = await verifyMovePackageProvenance({
  files,
  intent: "publish",
  reference,
  verifierAssetBaseUrl: "/assets",
});
```

`verifierAssetBaseUrl` accepts values such as `/assets`, `/assets/`, and `https://cdn.example.com/assets`. Plain relative paths such as `assets`, `./assets`, and `../assets` are rejected. If you pass a custom `wasm` override, routed verifier asset loading is skipped.

Serve `.wasm` files with `Content-Type: application/wasm`. The loader retries transient route JS and WASM fetch failures such as `503`, but missing assets such as `404` still fail.

Browser deployment checklist:

- Keep each routed `sui_move_wasm.js` next to its `sui_move_wasm_bg.wasm` file under the same route directory.
- If your bundler or CDN moves package assets away from the verification entry chunk, set `verifierAssetBaseUrl` to the deployed root-relative or absolute HTTP(S) asset base.
- Probe the routed JS and WASM URLs after deploy, including both `v6/classic` and `v6/v7source-2024`.
- Treat `404` as an asset packaging or path error. Retry only covers transient network, gateway, or warmup failures.
- Fix `application/octet-stream` or missing WASM MIME settings to `application/wasm`; otherwise browsers fall back to slower non-streaming initialization and still fail on non-OK responses.
- Browser apps must pass source snapshots and dependency snapshots or a `fetcher`; they should not rely on host filesystem package roots.

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
| `verifierAssetBaseUrl`        | `string \| URL`                      | Verification-only browser asset base for routed verifier files     |

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
