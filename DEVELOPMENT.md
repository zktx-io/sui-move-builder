# Development

This document is for repository maintenance. It is not required for normal package use.

## Build From Source

```bash
npm run prepare:wasm
npm run build:wasm:prepared:lite
npm run build:wasm:prepared:full
npm run build:wasm:prepared:verification
npm run build:wasm:prepared
npm run build:js
npm run build:verification:v6
npm run build:bytecode-verifiers
npm run inspect:reference-artifact -- --artifact ./reference.json --fail-on-warning
npm run build
```

`prepare:wasm` may download or update the pinned Sui source, create a disposable patched worktree, generate compatibility stubs and vendor patches, install the matching local `wasm-bindgen`, remove stale patch state at startup, and write `.sui-build/patch-state.json` after successful preparation.

Prepared build scripts consume existing prepared state:

- `build:wasm:prepared:lite` writes `dist/lite`.
- `build:wasm:prepared:full` writes `dist/full`.
- `build:wasm:prepared:verification` writes `dist/verification`.
- `build:verification:v6` writes decoded-bytecode-version 6 verifier files under `dist/verification/v6/classic` and `dist/verification/v6/v7source-2024`.
- `inspect:reference-artifact` decodes caller-provided reference artifact headers for fixture review. Use `--fail-on-warning` before promoting a fixture.
- `build` runs WASM preparation, JS build, and bundled bytecode verifier builds.

Full builds run a Binaryen `wasm-opt` strip pass after `wasm-bindgen`. Set `WASM_OPT=/path/to/wasm-opt` if it is not on `PATH`, or set `SUI_WASM_SKIP_WASM_OPT=1` to build without that size pass. Set `SUI_WASM_STRICT_OFFLINE=1` when you want Cargo to fail instead of reaching the network.

## Build State Layout

| Path                                          | Role                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `.sui-build/source/`                          | Pristine Sui checkout at the commit in `sui-version.json`                      |
| `.sui-build/work/`                            | Disposable worktree where `sui-move-wasm` is overlaid and patches are applied  |
| `.sui-build/generated/stubs/`                 | Generated WASM compatibility stub crates                                       |
| `.sui-build/generated/vendor/`                | Vendored dependency sources that need local WASM patching                      |
| `.sui-build/generated/local-bin/`             | Local build tools such as pinned `wasm-bindgen`                                |
| `.sui-build/patch-state.json`                 | Successful prepare marker checked by prepared builds                           |
| `dist/full`, `dist/lite`, `dist/verification` | Generated package artifacts                                                    |
| `dist/verification/v6/classic`                | Generated classic verifier artifact for decoded bytecode version 6             |
| `dist/verification/v6/v7source-2024`          | Generated v7-source verifier artifact that can emit decoded bytecode version 6 |

Only edit tracked project sources such as `src/`, `sui-move-wasm/`, and `scripts/compat/`. `.sui-build/` is ignored build/cache state and can be removed with `npm run clean` together with `dist/`. Set `SUI_SOURCE_DIR` or `SUI_WORK_DIR` only when intentionally moving those directories.

The active `scripts/compat/` directory is the WASM compatibility overlay for the pinned Sui version. Its `manifest.json` is checked by `prepare:wasm`. Missing required compat files are prepare failures.

For an intentional build against another Sui source version, override it explicitly:

```bash
SUI_VERSION=1.x.y SUI_TAG=mainnet-v1.x.y npm run build:wasm
# or, when calling the low-level script directly:
node scripts/build-wasm.mjs --sui-version 1.x.y --sui-tag mainnet-v1.x.y
```

## Checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:parity
npm run test:audit
npm run test:browser
node test/integration/run.mjs semantic
node test/integration/run.mjs doc-freshness
node test/integration/run.mjs cli-pipeline-table
```

Run `npm run build` first when a check needs generated `dist/` artifacts.

The local Sui CLI must be installed or selected with `SUI_CLI` for CLI comparison checks. A version difference from `sui-version.json` is a warning and comparison risk, not a reason to accept mismatched output.

Before publishing or deploying a browser app that uses the verification entry, confirm the package or deploy artifact includes the routed verifier assets:

- `dist/verification/v6/classic/sui_move_wasm.js`
- `dist/verification/v6/classic/sui_move_wasm_bg.wasm`
- `dist/verification/v6/v7source-2024/sui_move_wasm.js`
- `dist/verification/v6/v7source-2024/sui_move_wasm_bg.wasm`

When checking npm package contents locally, `npm pack --dry-run --json --cache /private/tmp/sui-move-builder-npm-cache` avoids relying on a user-global npm cache. Consumer web-app deploy artifacts may rewrite the prefix, but the `v6/classic` and `v6/v7source-2024` route files must remain reachable next to the emitted verification entry chunk.

For browser deploy checks, request the routed verifier JS and adjacent WASM URLs directly and confirm successful responses. The `.wasm` responses should use `Content-Type: application/wasm`. The loader retries transient route JS and WASM fetch failures, including provider or cache warmup `503` responses, but `404` remains a deployment error.

Useful environment variables:

- `SUI_CLI=/path/to/sui` selects the local Sui CLI binary.
- `BROWSER_BIN=/path/to/chrome` selects the browser binary for `test:browser`.
- `SUI_PARITY_LIMIT=10` changes the number of auto-discovered examples.
- `SUI_PARITY_MIN_MOVE_FILES=3` requires larger multi-file examples.

Checks run serially because `.sui-build`, `dist`, and Sui CLI cache state are shared.

## Verifier Fixture Proof

Use `scripts/verification/prove-bytecode-verifier-fixture.mjs` when promoting a decoded-bytecode-version verifier fixture. The proof output includes:

- `fixture`: the mainnet transaction, intent, and pinned source location being checked.
- `verifier`: the selected verifier ID, dist path, Sui source version, and public export surface.
- `dependencySource`: the Sui source checkout used for framework dependencies.
- `referenceInspection`: header inspection output from `inspect:reference-artifact`.
- `result` and `fullResult`: summarized and complete verifier outputs.
- `ok` and `errors`: the promotion gate result.

Proof fails when `referenceInspection.warnings` is non-empty. A promoted `knownFixtures` entry must record the warning-free inspection summary and expected `verified` + `exact_bytecode_match` result.

Use `--refresh-fixture` to rebuild a known fixture proof from its pinned GitHub source and transaction digest into `.sui-build/bytecode-verifier-proof-runs/` instead of reusing an existing proof cache.

## CLI Comparison Checks

CLI comparison checks use the installed Sui CLI, or the binary selected by `SUI_CLI`. They fail when the CLI is missing. They warn when the CLI version differs from `sui-version.json`.

The parity checks compare covered packages and scenarios only. They do not patch outputs or maintain expected-result snapshots.

Available groups:

| Command                                     | Role                                                       |
| ------------------------------------------- | ---------------------------------------------------------- |
| `npm test`                                  | Runtime, semantic, and configured comparison checks        |
| `npm run test:parity`                       | Compare Sui CLI output with full and lite WASM outputs     |
| `npm run test:audit`                        | Compare selected CLI artifacts and verification references |
| `npm run test:browser`                      | Optional browser smoke test                                |
| `npm run dev:browser-parity`                | Interactive browser build and local CLI comparison page    |
| `node test/integration/run.mjs semantic`    | Runtime and semantic checks without CLI comparison         |
| `node test/integration/run.mjs output-deps` | One integration case                                       |

Audit groups:

- `audit build` runs `sui move build --path <package> --install-dir <output>`, converts generated `.mv` artifacts to base64, runs the low-level WASM compile binding with publish intent, and compares module bytecode.
- `audit upgrade` is a non-verification root-as-zero compile comparison harness for `prepareMovePackageUpgrade`; it still uses dump output and must not be treated as upgrade transaction `.mv` proof. Verification audits do not use dump output as an upgrade reference. Real Sui CLI upgrade `.mv` comparison requires caller-provided upgrade inputs such as `upgradeCapability` and any required sender or gas fields so the helper can run `sui client upgrade --install-dir`.
- `audit transaction` uses Sui RPC and GitHub access to fetch configured publish or upgrade transactions, extracts the single `Publish` or `Upgrade` command payload, passes that kind as verification `intent`, and rebuilds the configured GitHub source commit through the verification artifact.
- `audit github-binary` uses GitHub API and raw file access to fetch configured committed `.mv` artifacts, requires each artifact to declare `publish` or `upgrade` intent, rebuilds the same source commit through the verification artifact, and records bytecode diff summaries plus the expected verification status.

For manual browser comparison, run `npm run dev:browser-parity` and open the printed local URL. The page loads a package from the pinned Sui examples, a local package path, or a GitHub repository; builds it with the selected browser WASM artifact; asks the local server to build the same package with `sui move build --dump-bytecode-as-base64 --path <package>`; and compares module bytecode, dependency IDs, and digest.

## Generated State

Do not commit generated `.sui-build/` state or `dist/` artifacts unless a task explicitly requires generated output to be committed.

The repository keeps upstream Sui source pristine. Patches and generated compatibility state belong in the disposable build paths created by `prepare:wasm`.

## Documentation Checks

When changing `README.md`, `VERIFICATION.md`, `PACKAGE_BEHAVIOR.md`, `DEVELOPMENT.md`, `CLI_PIPELINE.md`, or `AGENTS.md`, run:

```bash
node test/integration/run.mjs doc-freshness
node test/integration/run.mjs cli-pipeline-table
```

Keep documentation limited to current behavior, current limitations, and verified checks. Do not add work logs or retrospective notes.

## Version Updates

For Sui version updates, follow `AGENTS.md`. For decoded bytecode version records used by verification, see `BYTECODE_VERSION_HISTORY.md` and `scripts/verification/bytecode-version-sources.json`.

Builder updates track the pinned Sui CLI/source version in `sui-version.json`. Refresh and test the active compat overlay during `prepare:wasm`, then reuse the prepared worktree for lite, full, verification, and release checks.

Verification routing is decoded-bytecode-version-first. When a Sui source update keeps decoded bytecode version and serialization behavior unchanged, update the current verifier with the builder. When either changes, preserve the previous verifier as a bytecode verifier and pin the Sui tag/commit that represents that decoded bytecode version in `scripts/verification/bytecode-verifiers.json`.

If several Sui releases were skipped, regenerate upstream tag inventory with `npm run inventory:sui-tags`, analyze decoded bytecode version changes with `npm run analyze:bytecode-versions`, and restore any missing verifier that changes verification evidence.
