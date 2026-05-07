# Sui Bytecode Version History

This file is the human-reviewed record for verifier selection. It records which Sui source tag/commit represents each decoded Move bytecode version and what changed from the previous recorded bytecode version.

Machine-readable source records live in `scripts/verification/bytecode-version-sources.json`. Scripts use that JSON to fetch the relevant Sui repository files by tag/commit. Runtime routing lives in `scripts/verification/bytecode-verifiers.json`. Generated GitHub tag inventory and source hashes live under `.sui-build/bytecode-verifiers/` and must not be committed. This file is the human and AI readable explanation copied from generated evidence after review.

## Update Rules

1. Regenerate upstream tag inventory with `npm run inventory:sui-tags`.
2. Analyze decoded bytecode version signals with `npm run analyze:bytecode-versions`.
3. Update `scripts/verification/bytecode-version-sources.json` with the Sui tag/commit and upstream source files that scripts should fetch.
4. For every detected decoded bytecode version or serialization change, record here:
   - first observed Sui tag/commit,
   - last observed Sui tag/commit before the next decoded bytecode version or serialization change,
   - representative Sui tag/commit selected for verifier builds,
   - bytecode flavor, when present,
   - upstream evidence files and hashes,
   - change summary from the previous recorded version,
   - representative transaction or `.mv` fixture, when available.
5. Promote only supported verifier routes to `scripts/verification/bytecode-verifiers.json`.

## Records

Generated evidence covers 1029 upstream Sui tags: 400 network tags and 629 release tags. Release CLI tags start at `1.1.0` and only show decoded bytecode versions 6 and 7. Expanded network-tag analysis also found decoded bytecode version 5 in pre-release `devnet-0.x` tags through their `move-language/move` Cargo dependency. Versions 1 through 4 appear as historical constants in old Move source but were not observed as `VERSION_MAX` for any scanned Sui release or network tag. Runtime routes are enabled only after an isolated verifier build and fixture prove a distinct exact result.

| Decoded bytecode version | Flavor | Verifier ID         | First observed tag | Representative Sui tag | Representative commit                      | Last observed tag before next recorded change | Change from previous recorded version                                                                                                           | Fixture evidence                       |
| ------------------------ | ------ | ------------------- | ------------------ | ---------------------- | ------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 5                        | None   | `sui-devnet-0.13.2` | `devnet-0.1.0`     | `devnet-0.13.2`        | `7fff531f90d912d2d2d77c5eca2e98c3c23ccdcf` | `devnet-0.13.2`                               | Network-only pre-release record. Sui references `move-language/move`; `VERSION_MAX` is 5, no Sui flavor is encoded, and jump tables are absent. | Source record only                     |
| 6                        | None   | `sui-1.26.2`        | `devnet-0.14.0`    | `mainnet-v1.26.2`      | `f531168c745260b60a4ec4906c9f2b22240d872d` | `sui_v1.26.2_1717632279_release`              | First decoded bytecode version observed in release CLI tags. `VERSION_MAX` is 6, no Sui flavor is encoded, and jump tables are absent.          | `apps-kiosk` exact fixture             |
| 7                        | 5      | `sui-1.70.2`        | `testnet-v1.27.0`  | `mainnet-v1.70.2`      | `6d4ec0b0621dd9555753c9ecd5be021b25a0d267` | Not observed                                  | `VERSION_MAX` becomes 7, Sui flavor is encoded in the header, and function code units include version-gated jump tables.                        | Current provenance and artifact audits |

## Boundary Evidence

| Boundary   | Previous recorded tag            | First changed tag               | Evidence                                                                                                                                    |
| ---------- | -------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| v5         | None in recorded inventory       | `devnet-0.1.0`                  | Sui `Cargo.lock` references `move-language/move` revision `4e025186...`; that Move source records `VERSION_MAX = 5`.                        |
| v5 layout  | `devnet-0.4.0-rc`                | `devnet-0.5.0-rc`               | Decoded bytecode version remains 5, but the table layout hash changes from `5cabf7...` to `992ada...`.                                      |
| v6         | `devnet-0.13.2`                  | `devnet-0.14.0`                 | Sui `Cargo.lock` references `move-language/move` revision `be52c711...`; that Move source records `VERSION_MAX = 6`.                        |
| v6 release | None in release CLI tags         | `sui_v1.1.0_1683918278_release` | Release CLI tags start at Sui `1.1.0`; the first release-tag source group records `VERSION_MAX = 6`.                                        |
| v6 pin     | `sui_v1.24.1_1715125390_release` | `testnet-v1.25.0`               | Protocol config starts recording `move_binary_format_version = Some(6)` and `min_move_binary_format_version = Some(6)`.                     |
| v7         | `sui_v1.26.2_1717632279_release` | `testnet-v1.27.0`               | `file_format_common.rs` records `VERSION_MAX = 7`; serializer encodes `BinaryFlavor`; serializer/deserializer add jump-table version gates. |

## Evidence Checklist

Each completed record should cite generated evidence for these upstream source groups:

| Evidence group                   | Purpose                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `file_format_common.rs`          | Decoded bytecode version range, binary flavor support, and table layout.               |
| `serializer.rs`                  | Serialization behavior that can change module bytes without changing source semantics. |
| `deserializer.rs`                | Deserialization behavior and version gates used by verifier evidence.                  |
| `sui-protocol-config/src/lib.rs` | Protocol-configured Move binary format versions.                                       |

## Source Hashes

| Record              | Evidence group          | Source file                                                                | SHA-256                                                            |
| ------------------- | ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `sui-devnet-0.13.2` | `file_format_common.rs` | `language/move-binary-format/src/file_format_common.rs`                    | `2c5149988d344e0ae64c2f5898aaaae290d5435419d179e216f1e53c7b87b0bf` |
| `sui-devnet-0.13.2` | `serializer.rs`         | `language/move-binary-format/src/serializer.rs`                            | `99e6bbed9a9bca4c77d7649c6dabe53c7fd8f730655f7a4a5a52d6690eec68ea` |
| `sui-devnet-0.13.2` | `deserializer.rs`       | `language/move-binary-format/src/deserializer.rs`                          | `1783807255fc07177205f7e2dc98f14c3dabbc754160c58a46fdd8adf22d5630` |
| `sui-1.26.2`        | `file_format_common.rs` | `external-crates/move/crates/move-binary-format/src/file_format_common.rs` | `68c372a43a2f3272597eb1fb25b5ded799f8be0e9ae2e77ced5c016efbbd6fda` |
| `sui-1.26.2`        | `serializer.rs`         | `external-crates/move/crates/move-binary-format/src/serializer.rs`         | `62399dd85b9759bb51858fff2d518af77f0d0a8af4aebaec4be5fdb6c1f3dd9d` |
| `sui-1.26.2`        | `deserializer.rs`       | `external-crates/move/crates/move-binary-format/src/deserializer.rs`       | `c2afcbec0876e178f9fab317cd26df51e0d306a9ee570f5b4d5bf4606f1828f4` |
| `sui-1.26.2`        | `protocol config`       | `crates/sui-protocol-config/src/lib.rs`                                    | `65d196c9fa72138d4c363f0e9f07dd42c87b3f33cf8b0d13b26d2a9f10caead0` |
| `sui-1.70.2`        | `file_format_common.rs` | `external-crates/move/crates/move-binary-format/src/file_format_common.rs` | `1b2b41d74f5f12c6625c339a56a995119abbe0c19a7f98df53c7c494b04d10e1` |
| `sui-1.70.2`        | `serializer.rs`         | `external-crates/move/crates/move-binary-format/src/serializer.rs`         | `9b297ab9d609345623a05612f8b04b96284bc404f131088570df3413794ff79a` |
| `sui-1.70.2`        | `deserializer.rs`       | `external-crates/move/crates/move-binary-format/src/deserializer.rs`       | `5413482f3c9e556f60a01981864df207079634a5aab6c22b23da22f076aae014` |
| `sui-1.70.2`        | `protocol config`       | `crates/sui-protocol-config/src/lib.rs`                                    | `de0ddb0fef7bc62cb05021a8bb7056f645ed71ac429398d7c6f46ebd091fab4e` |

## Notes For Future Records

- Do not add one verifier per Sui patch release. Add verifier records only when decoded bytecode version or bytecode serialization evidence changes.
- Keep JSON machine-oriented and this Markdown human-oriented. The JSON should identify what to fetch; this file should explain why the version matters and what changed.
- Do not infer a representative commit from an old builder package. The representative commit must come from upstream Sui tag inventory.
- A verifier record is not enough by itself. A supported legacy verifier also needs an isolated compat recipe and a fixture that proves a distinct verification outcome.
