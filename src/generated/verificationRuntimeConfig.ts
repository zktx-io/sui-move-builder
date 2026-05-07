// AUTO-GENERATED. Do not edit directly.
// Generated from scripts/verification/bytecode-verifiers.json.
// Run npm run generate:verification-runtime-config after changing that source.

export const VERIFICATION_RUNTIME_CONFIG = {
  currentBytecodeFlavor: 5,
  currentBytecodeVersion: 7,
  currentVerifierId: "sui-1.71.1",
  routes: {
    "6": {
      candidates: [
        {
          bytecodeFlavor: null,
          decodedBytecodeVersion: 6,
          epochId: "v6-classic",
          verifierId: "sui-1.26.2",
        },
        {
          bytecodeFlavor: null,
          decodedBytecodeVersion: 6,
          epochId: "v6-v7source-2024",
          verifierId: "sui-1.58.3-v6",
        },
      ],
      decodedBytecodeVersion: 6,
    },
    "7": {
      candidates: [
        {
          bytecodeFlavor: 5,
          decodedBytecodeVersion: 7,
          epochId: "v7-current",
          verifierId: "sui-1.71.1",
        },
      ],
      decodedBytecodeVersion: 7,
    },
  },
  verifiers: {
    "sui-1.26.2": {
      bytecodeFlavor: null,
      decodedBytecodeVersion: 6,
      epochId: "v6-classic",
      importSpecifier: "./v6/classic/sui_move_wasm.js",
      suiVersion: "1.26.2",
      verifierId: "sui-1.26.2",
    },
    "sui-1.58.3-v6": {
      bytecodeFlavor: null,
      decodedBytecodeVersion: 6,
      epochId: "v6-v7source-2024",
      importSpecifier: "./v6/v7source-2024/sui_move_wasm.js",
      suiVersion: "1.58.3",
      verifierId: "sui-1.58.3-v6",
    },
    "sui-1.71.1": {
      bytecodeFlavor: 5,
      decodedBytecodeVersion: 7,
      epochId: "v7-current",
      importSpecifier: null,
      suiVersion: "1.71.1",
      verifierId: "sui-1.71.1",
    },
  },
} as const;
