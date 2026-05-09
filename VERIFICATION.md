# Verification

The verification entrypoint rebuilds caller-provided source and compares the result with caller-provided reference Move bytecode. It reports source-to-bytecode comparison evidence; it does not execute transactions.

## Inputs

`verifyMovePackageProvenance` uses the same source snapshot and dependency resolution inputs as the build APIs, plus:

- `intent`: `publish` or `upgrade`
- `reference.modules`: base64 Move modules from the reference artifact
- `reference.dependencies`: optional dependency IDs from the reference artifact
- `reference.packageId`: optional deployed package object ID metadata
- `reference.rootAddress`: optional explicit root address for on-chain package module comparison
- `reference.digest`: optional package digest
- `reference.cliVersion` and `reference.buildConfig`: optional caller-declared evidence metadata

The verifier does not fetch RPC, GitHub, transaction, or filesystem data. Transaction callers extract `Publish` or `Upgrade` externally and pass the matching reference artifact.

## Bytecode Version Routing

The wrapper reads the decoded bytecode version from `reference.modules` and lazy-loads the matching bundled verifier:

| Decoded bytecode version | Bundled verifier path                |
| ------------------------ | ------------------------------------ |
| 7                        | `dist/verification`                  |
| 6                        | `dist/verification/v6/classic`       |
| 6                        | `dist/verification/v6/v7source-2024` |

Browser bundles must keep each routed verifier's `sui_move_wasm.js` and `sui_move_wasm_bg.wasm` reachable relative to the verification entry chunk. For example, if the verification entry is served from `/assets`, decoded-bytecode-version 6 routes are loaded from `/assets/v6/classic/sui_move_wasm.js` and `/assets/v6/v7source-2024/sui_move_wasm.js`, and each route then initializes its adjacent WASM file.

The selected verifier's Sui source version is reported as `bytecodeHeaderEvidence.currentVerifierSuiVersion`. This is build-time verifier metadata, not a local CLI probe. `reference.cliVersion` is caller-declared metadata and does not replace bytecode comparison.

Declared `reference.cliVersion` and `reference.buildConfig` are returned as evidence when provided. They are caller-provided metadata and are not used as a substitute for bytecode comparison.

Verification results also include:

- `displayMessage`: one UI-ready summary string. Show this first for failures.
- `selectedVerifier`: verifier ID, baked Sui source version, decoded bytecode version, and bytecode flavor when known.
- `referenceBytecode`: decoded bytecode version/flavor/module count from the reference modules.
- `sourceCompatibility`: root/dependency manifest edition evidence and unsupported edition entries when detected.

For UI display, prefer `displayMessage`; if it is absent, fall back to `error`, then `summary`.

## Move Edition Compatibility

Each verifier follows the Sui CLI/source version it was built from. The decoded bytecode version selects the verifier first; the verifier then applies its own Move edition rules.

| Verifier        | Supported editions                          | Missing package edition fallback | Plain `2024` |
| --------------- | ------------------------------------------- | -------------------------------- | ------------ |
| `sui-1.26.2`    | `legacy`, `2024.alpha`, `2024.beta`         | `legacy`                         | Rejected     |
| `sui-1.58.3-v6` | `legacy`, `2024.alpha`, `2024.beta`, `2024` | `legacy`                         | Accepted     |
| `sui-1.71.1`    | `legacy`, `2024.alpha`, `2024.beta`, `2024` | `legacy`                         | Accepted     |

The missing package edition fallback is the CLI package manifest behavior for a
package that does not declare `[package].edition`; it is separate from the
compiler edition enum's default value recorded in bytecode-version source
evidence.

When an attempted verifier does not support a declared edition, that candidate returns `status: "build_failure"`, `failureStage: "input_validation"`, and `verdict: "unverified"`. The wrapper may then try the next candidate for the same decoded bytecode version. The verifier does not silently fall back to `legacy`.

## Reference Artifact Inspector

Use the inspector before adding a new reference fixture:

```bash
npm run inspect:reference-artifact -- --artifact ./reference.json
```

The command decodes the Move bytecode header from `modules`, reports decoded bytecode version, bytecode flavor when present, module count, dependency count, and any caller-provided fixture metadata. It does not fetch source, RPC data, or transaction data.

Use `--fail-on-warning` when checking an artifact before fixture promotion:

```bash
npm run inspect:reference-artifact -- --artifact ./reference.json --fail-on-warning
```

When `--fail-on-warning` is set, warning-bearing artifacts fail the command and `--out` is not written. Run the command without `--fail-on-warning` if you need the inspection JSON while diagnosing the warning.

Accepted input shapes:

```json
{
  "modules": ["...base64..."],
  "dependencies": ["0x1"],
  "packageId": "0x...",
  "txDigest": "...",
  "network": "mainnet",
  "intent": "publish",
  "rootGit": {
    "git": "https://github.com/owner/repo.git",
    "rev": "0123456789abcdef0123456789abcdef01234567",
    "subdir": "path/to/package"
  }
}
```

The inspector also accepts:

- `{ "reference": { ... } }` wrappers.
- Existing transaction audit artifacts with `modules` plus top-level `digest` and transaction-shaped metadata such as `kind`, `status`, or `source: "grpc" | "graphql"`. In that shape, `digest` is treated as the transaction digest.
- Older flat source metadata fields: `sourceGit`, `sourceRev`, and `sourceSubdir`.

`modules` is the only required field for header inspection. `dependencies`, `packageId`, `txDigest`, `network`, `intent`, and `rootGit` are optional metadata for fixture review. A supported verifier fixture still needs pinned source metadata before it can be promoted to `knownFixtures`.

For decoded bytecode version 6 or lower, a non-zero high byte in the raw version word is reported as a warning because those versions normally do not encode Sui flavor in the header.

## Intent

| Reference artifact source                                 | `intent`  | Meaning                                                                                                       |
| --------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| Publish transaction modules or publish `.mv` artifacts    | `publish` | Compares publish-time bytecode using the package root address selected by the source and reference modules.   |
| Upgrade transaction modules or upgrade preparation output | `upgrade` | Compares upgrade-time bytecode. The current rebuild stays root-as-zero and does not use dump output as proxy. |

`dumpMovePackage` remains a build API. Dump JSON is not a transaction provenance reference.

## Status

| `status`                    | Meaning                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `verified`                  | The selected verifier accepted the source/reference comparison. Check `verdict` for the match type. |
| `bytecode_version_mismatch` | Header or recognized bytecode format evidence differs without a semantic mismatch classification.   |
| `mismatch`                  | Bytecode, module identity, dependency, digest, or address evidence differs semantically.            |
| `build_failure`             | Source resolution, compilation, or verifier execution failed before comparison completed.           |
| `invalid_reference`         | Caller-provided reference bytes or metadata could not be parsed as a supported reference.           |

`verified`, `mismatch`, and `bytecode_version_mismatch` results do not include `failureStage`. Failure statuses may include it.

`bytecode_version_mismatch` results may include populated `differences` and `bytecodeDiffs` fields. Treat those fields as comparison evidence.

## Verdicts

`verdict` is an evidence classification, not a transaction execution result.

| `verdict`                          | Meaning                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `exact_bytecode_match`             | Reference modules match the current source rebuild byte-for-byte.                                                  |
| `root_address_substitution_match`  | Reference modules match after applying root-address substitution, but raw module bytes differ.                     |
| `bytecode_version_header_mismatch` | The only module difference is the Move bytecode version word.                                                      |
| `bytecode_format_drift`            | Module identity and shape match, and differences are limited to bytecode version metadata and `function_defs`.     |
| `semantic_mismatch`                | Module identity, shape, dependency/digest data, or bytecode tables differ beyond recognized bytecode format drift. |
| `unverified`                       | The verifier could not classify the comparison, usually because input validation, dependency, or build failed.     |

`verified` with `exact_bytecode_match` is the only byte-for-byte match result. `verified` with `root_address_substitution_match` means compiled-module comparison matched after documented root-address substitution, but raw bytes did not match. When root-address substitution is applied, current module summaries keep the pre-substitution address in `originalAddress`.

## Address Rules

For `publish` references, `reference.rootAddress` explicitly aligns the current build's module self address for on-chain package module comparison.

For `upgrade` references, the current rebuild stays root-as-zero. Package ID metadata does not rewrite the current module identity.

If source compiles with a root address of `0x0` but the reference module bytecode itself contains a published package address, pass that published address as `reference.rootAddress`.
`reference.packageId` records the deployed package object ID and does not request root-address substitution.

A conflicting non-zero current module address and requested `rootAddress` is reported as `mismatch` with `semantic_mismatch`, not as a build failure. If package source embeds its own address in constants or other bytecode-sensitive positions, use the matching `intent` and source metadata for the artifact being checked.

## Failure Stages

| `failureStage`          | Meaning                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `wasm_init`             | The verification WASM module could not initialize.                                            |
| `dependency_resolution` | Source snapshot dependency resolution failed before Rust verification ran.                    |
| `input_validation`      | JS or Rust rejected the verification input or caller-provided reference artifact.             |
| `compile`               | Rust compilation of the caller-provided source snapshot failed.                               |
| `compiler_output`       | Rust could not parse or normalize current build output JSON, digest, or bytecode module data. |
| `verification_output`   | The JS wrapper could not call the verifier or could not parse the verifier JSON response.     |

## Byte-For-Byte Match Requirements

Older decoded bytecode versions require source snapshots and dependency snapshots, or a fetcher, pinned to revisions the selected verifier can compile. A matching decoded bytecode version alone is not enough; the rebuilt raw modules must match the reference bytes.
