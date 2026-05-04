# Security and Compatibility Boundaries

This package builds and verifies Sui Move packages through browser-compatible
WASM artifacts. The supported public APIs compile source snapshots, run the
full-artifact Move unit-test path, prepare publish or upgrade bytecode payload
data, update caller-provided publication files from successful external
execution results, and compare rebuilt bytecode with caller-provided reference
artifacts.

The WASM artifacts are not transaction executors, wallets, RPC clients, TLS
clients, filesystem scanners, signing tools, certificate validators, or general
cryptographic verification engines. Caller applications provide source files,
dependency snapshots, reference bytecode, and any transaction/RPC results.

## Runtime Boundaries

- Build and provenance APIs do not fetch RPC, execute transactions, sign data,
  choose gas, read host filesystem package roots, or validate remote TLS
  certificates.
- The full artifact can run Move unit tests for the supported package snapshot
  path. Unit-test execution is not a substitute for production cryptographic,
  certificate, networking, or randomness validation.
- Compatibility replacements are declared in `scripts/compat/manifest.json`.
  The prepared WASM build must use those declared replacements; missing
  overlays are build failures.
- `move-package-alt` and `move-package-alt-compilation` are compatibility-hollow
  placeholders in the prepared WASM build. The supported package-manager
  behavior is implemented in local Rust/WASM helpers and covered by parity
  fixtures for selected stages.

## Compat Manifest Inventory

The following JSON block is checked against `scripts/compat/manifest.json` by
`node test/integration/run.mjs security-doc`.

<!-- compat-inventory:start -->

```json
{
  "stubTemplates": {
    "anemo": {
      "compatSource": "anemo",
      "category": "networking",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "antithesis_sdk": {
      "compatSource": "antithesis-sdk",
      "category": "test-instrumentation",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "antithesis-sdk": {
      "compatSource": "antithesis-sdk",
      "category": "test-instrumentation",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "blst": {
      "compatSource": "blst_lib",
      "category": "cryptography",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "consensus-config": {
      "compatSource": "consensus-config",
      "category": "consensus",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "consensus-types": {
      "compatSource": "consensus-types",
      "category": "consensus",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "errno": {
      "compatSource": "errno",
      "category": "host-os",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "fastcrypto-tbls": {
      "compatSource": "fastcrypto-tbls",
      "category": "cryptography",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "fastcrypto-vdf": {
      "compatSource": "fastcrypto-vdf",
      "category": "cryptography",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "fastcrypto-zkp": {
      "compatSource": "fastcrypto-zkp",
      "category": "cryptography",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "fs4": {
      "compatSource": "fs4",
      "category": "filesystem-locking",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "getrandom": {
      "compatSource": "getrandom",
      "category": "randomness",
      "reachability": "linked by dependencies; supported public APIs must not rely on cryptographic randomness",
      "behavior": "returns zero-filled randomness values if called"
    },
    "move-package-alt": {
      "compatSource": "move-package-alt",
      "category": "package-manager-placeholder",
      "reachability": "not called by sui-move-wasm runtime package-manager path",
      "behavior": "placeholder exposes only the minimal Vanilla flavor shape used for compilation"
    },
    "move-package-alt-compilation": {
      "compatSource": "move-package-alt-compilation",
      "category": "build-plan-placeholder",
      "reachability": "not called by sui-move-wasm runtime package-manager path",
      "behavior": "placeholder BuildConfig method returns an error if called"
    },
    "mysten-metrics": {
      "compatSource": "mysten-metrics",
      "category": "metrics",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "mysten-network": {
      "compatSource": "mysten-network",
      "category": "networking",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "neptune": {
      "compatSource": "neptune_lib",
      "category": "cryptography",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "neptune-cash": {
      "compatSource": "neptune_lib",
      "category": "cryptography",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "neptune-triton": {
      "compatSource": "neptune_lib",
      "category": "cryptography",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "rustix": {
      "compatSource": "rustix",
      "category": "host-os",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "secp256k1": {
      "compatSource": "secp256k1_lib",
      "category": "cryptography",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "stacker": {
      "compatSource": "stacker",
      "category": "host-stack",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "sui-rpc": {
      "compatSource": "sui-rpc",
      "category": "rpc-networking",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "tonic": {
      "compatSource": "tonic",
      "category": "networking",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "x509-parser": {
      "compatSource": "x509-parser",
      "category": "x509-tls",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    },
    "zstd": {
      "compatSource": "zstd",
      "category": "compression",
      "reachability": "not part of supported public build/provenance side effects",
      "behavior": "compatibility replacement declared by manifest; see scripts/compat source for exact symbols"
    }
  },
  "filePatches": {
    "fastcryptoRistretto255Mod": {
      "compatFile": "fastcrypto_ristretto255_mod.rs",
      "category": "cryptography",
      "reachability": "only when the linked upstream crate calls this patched module",
      "behavior": "WASM-compatible patched source replaces the upstream module"
    },
    "fastcryptoSecp256r1Mod": {
      "compatFile": "fastcrypto_secp256r1_mod.rs",
      "category": "cryptography",
      "reachability": "only when the linked upstream crate calls this patched module",
      "behavior": "WASM-compatible patched source replaces the upstream module"
    },
    "moveUnitTestRunner": {
      "compatFile": "move_unit_test_runner_patch.rs",
      "category": "unit-test-runner",
      "reachability": "full artifact test runner path",
      "behavior": "uses deterministic WASM-safe runner behavior"
    },
    "nitroAttestation": {
      "compatFile": "nitro_attestation.rs",
      "category": "native-attestation",
      "reachability": "only when the linked upstream crate calls this patched module",
      "behavior": "native returns a not-supported error code"
    }
  },
  "emptyStubCrates": {
    "anstream": {
      "category": "terminal-output",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "anstyle": {
      "category": "terminal-output",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "anstyle-parse": {
      "category": "terminal-output",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "anstyle-query": {
      "category": "terminal-output",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "axum": {
      "category": "networking-runtime",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "blstrs": {
      "category": "cryptography",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "colorchoice": {
      "category": "terminal-output",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "named-lock": {
      "category": "filesystem-locking",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "nitro-attestation": {
      "category": "native-attestation",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "nitro-attestation-sys": {
      "category": "native-attestation",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "psm": {
      "category": "host-process",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "rustls": {
      "category": "tls-x509",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "rusty-fork": {
      "category": "host-process",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-analytics-indexer": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-benchmark": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-faucet": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-graphql-e2e-tests": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-graphql-rpc": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-alt": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-alt-consistent-api": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-alt-consistent-store": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-alt-e2e-tests": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-alt-framework-store-traits": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-alt-graphql": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-alt-jsonrpc": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-alt-metrics": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-alt-object-store": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-alt-reader": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-alt-restorer": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-indexer-builder": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-surfer": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "sui-tls": {
      "category": "tls-x509",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "suins-indexer": {
      "category": "rpc-indexer-or-service",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "terminal_size": {
      "category": "terminal-output",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "tokio-postgres-rustls": {
      "category": "tls-x509",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "tokio-stream": {
      "category": "networking-runtime",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "tokio-tungstenite": {
      "category": "networking-runtime",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "webpki": {
      "category": "tls-x509",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "x509-certificate": {
      "category": "tls-x509",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "zstd-safe": {
      "category": "compression",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    },
    "zstd-sys": {
      "category": "compression",
      "reachability": "not part of supported public runtime path",
      "behavior": "generated empty crate declared by compat manifest"
    }
  }
}
```

<!-- compat-inventory:end -->
