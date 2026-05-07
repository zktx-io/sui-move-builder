# Package Behavior

This document records package-loading and build behavior that is too detailed for the README.

## Source Snapshot Boundary

Callers pass package files as an in-memory snapshot. The WASM build path does not scan a host filesystem package root. Browser callers and server callers use the same boundary: provide the files needed for the root package and any dependency snapshots that cannot be fetched through the default GitHub loader.

When preparing the `files` object, exclude generated build output and version-control folders such as `build/` and `.git/`. Including them can create duplicate modules or make dependency files look like root source files.

## Behavior Summary

- JavaScript owns host fetching, source snapshots, option normalization, progress callbacks, WASM initialization, and result wrapping.
- Rust/WASM owns the supported package graph, lockfile, compiler, digest, output dependency, and publication metadata behavior.
- Address handling tracks `original_id` for compilation and `published_at` or latest IDs for output metadata where available.
- V4 `Move.lock` output includes deterministic pinned sections and `manifest_digest` values.
- `Published.toml` records are read per environment when present.
- Package editions such as `legacy`, `2024.alpha`, and `2024.beta` are preserved.
- Local dependencies inside git-sourced packages are converted to repository subdirectories.
- Same-name package variants are kept separate when the dependency graph requires it.

## Package Preparation APIs

| API                            | Purpose                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `dumpMovePackage`              | Prepare dump-style `{ modules, dependencies, digest }` output                        |
| `prepareMovePackagePublish`    | Prepare modules, dependency IDs, and digest for a publish payload                    |
| `prepareMovePackageUpgrade`    | Prepare modules, dependency IDs, digest, and package ID for an upgrade               |
| `updateMovePackagePublication` | Update caller-owned publication files from an externally executed publish or upgrade |

These APIs do not sign transactions, choose gas, dry-run, execute, or store package files.

## Publication File Updates

The package returns bytecode payloads and generated `Move.lock` content for publish and upgrade. The calling app builds and executes the transaction with its own wallet flow, then passes the successful result back to update the publication snapshot.

```ts
import {
  prepareMovePackagePublish,
  updateMovePackagePublication,
} from "@zktx.io/sui-move-builder";
import { Transaction } from "@mysten/sui/transactions";

const prepared = await prepareMovePackagePublish({ files, network: "testnet" });
if ("error" in prepared) throw new Error(prepared.error);

const filesWithLock = { ...files, "Move.lock": prepared.moveLock };

const tx = new Transaction();
const upgradeCap = tx.publish({
  modules: prepared.modules,
  dependencies: prepared.dependencies,
});
tx.transferObjects([upgradeCap], account.address);

const result = await signAndExecuteTransaction({ transaction: tx });
const { chainIdentifier } = await client.core.getChainIdentifier();

const updated = await updateMovePackagePublication({
  files: filesWithLock,
  prepared,
  result,
  network: "testnet",
  chainId: chainIdentifier,
});
if ("error" in updated) throw new Error(updated.error);

const nextFiles = updated.files;
console.log(updated.publishedToml);
```

Upgrade publication updates use `updateMovePackagePublication` after an externally executed upgrade transaction. The selected environment must already exist in `Published.toml` so the original package ID and UpgradeCap ID can be preserved.

## Dependency Resolution

The implemented precedence is:

1. API options, such as `network`.
2. V4 `Move.lock` pinned sections for the active environment, when usable.
3. `Move.toml` manifests.
4. `Published.toml` as publication metadata, not as a dependency graph source.

Older `Move.lock` graph formats are not used as pinned graph sources. Supported packages fall back to manifest resolution. Supported V3 publication records may be migrated into `Published.toml` output.

Published package addresses can come from lockfile environment records, `Published.toml`, or manifest metadata depending on the package and lockfile format. If a package has matching publication data, the builder uses that information for compilation and output address handling.

When a root package does not declare `sui` or `std`, the build path adds implicit framework dependencies for the selected network.

## Git And Local Dependencies

GitHub package sources can be fetched with `fetchMovePackageFromGitHub`. Local dependency packages must be supplied by the host through snapshots or a custom `fetcher`; the browser build does not assume direct filesystem access.

Local dependencies inside git-sourced packages are converted to repository subdirectories when the package graph requires it.

`githubToken` increases GitHub API rate limits when provided. Raw file fetch remains available for browser use when the host environment supports it.

## Dependency Reuse

For repeated builds with the same dependencies, resolve dependencies once and pass them back as `resolvedDependencies`:

```ts
import {
  initMovePackageBuilder,
  resolveMovePackageDependencies,
  dumpMovePackage,
} from "@zktx.io/sui-move-builder";

await initMovePackageBuilder();

const resolvedDependencies = await resolveMovePackageDependencies({
  files,
  network: "mainnet",
});

const result = await dumpMovePackage({
  files,
  network: "mainnet",
  resolvedDependencies,
});
```

This avoids repeating dependency resolution and can reduce network requests in watch-mode or iterative builds. It does not make stale dependency snapshots safe; callers still own cache invalidation.

## Output Reference

| Field           | Type       | Description                                                       |
| --------------- | ---------- | ----------------------------------------------------------------- |
| `modules`       | `string[]` | Base64-encoded compiled bytecode modules                          |
| `dependencies`  | `string[]` | Hex-encoded package IDs for linking                               |
| `digest`        | `number[]` | Package digest bytes                                              |
| `moveLock`      | `string`   | Generated V4 `Move.lock` content                                  |
| `environment`   | `string`   | Build environment                                                 |
| `intent`        | `string`   | `dump`, `publish`, or `upgrade`                                   |
| `packageId`     | `string?`  | Upgrade package ID returned by `prepareMovePackageUpgrade`        |
| `publishedToml` | `string?`  | Migrated `Published.toml` content, when supported data is present |
| `warnings`      | `string?`  | Compiler warnings when warnings are not silenced                  |

Failures return `{ error, category, code? }`. `category` is a broad stage label such as `dependency_resolution`, `input_validation`, `compile`, `compiler_output`, `lockfile_generation`, `test_runner`, `wasm_init`, or `unknown`.

## Progress Events

`onProgress` events include high-level lifecycle events and graph trace events:

| Event type          | Fields                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `resolve_start`     | Dependency resolution started                                                                            |
| `stage_trace`       | `stage`, `environment`, `modes`, and optional graph count fields for Rust/WASM graph and lockfile stages |
| `resolve_complete`  | `count` dependency packages selected for compiler input                                                  |
| `compile_start`     | Compiler invocation started                                                                              |
| `compile_complete`  | Compiler invocation completed                                                                            |
| `lockfile_generate` | `Move.lock` V4 generation started                                                                        |

## Move Unit Test Output

`testMovePackage` is a full-entry API. It returns the Move unit-test runner stdout in `output` and a `passed` boolean when the runner completes.

```ts
const result = await testMovePackage({ files, network: "mainnet" });

if ("error" in result) {
  console.error("Test failed to run:", result.error);
  console.error("Stage:", result.category);
  if (result.code) console.error("Code:", result.code);
} else {
  console.log("Tests Passed:", result.passed);
  console.log("Output:", result.output);
}
```

## Current Limits

| Area                                    | Current behavior                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Full upstream `BuildPlan` execution     | Runtime builds use the snapshot-backed Rust/WASM package model described in `CLI_PIPELINE.md`. |
| Bytecode-only `.mv` dependency fallback | Unsupported. Source snapshots are required.                                                    |
| `stripMetadata`                         | Reserved and currently not applied by the WASM compiler path.                                  |
| Dev-address or extra named-address API  | No stable public override API is exposed.                                                      |
| V0/V1/V2/V3 lockfile graph loading      | Unsupported as pinned graph sources; supported packages use manifest fallback.                 |

Passing integration checks are evidence for the covered packages and scenarios only. They are not a claim that every Sui package-manager path is covered.
