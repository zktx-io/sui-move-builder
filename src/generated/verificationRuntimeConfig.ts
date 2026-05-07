// AUTO-GENERATED. Do not edit directly.
// Generated from scripts/verification/bytecode-verifiers.json.
// Run npm run generate:verification-runtime-config after changing that source.

export const VERIFICATION_RUNTIME_CONFIG = {
  currentBytecodeFlavor: 5,
  currentBytecodeVersion: 7,
  currentVerifierId: "sui-1.70.2",
  routes: {
    "6": {
      bytecodeFlavor: null,
      decodedBytecodeVersion: 6,
      verifierId: "sui-1.26.2",
    },
    "7": {
      bytecodeFlavor: 5,
      decodedBytecodeVersion: 7,
      verifierId: "sui-1.70.2",
    },
  },
  verifiers: {
    "sui-1.26.2": {
      bytecodeFlavor: null,
      decodedBytecodeVersion: 6,
      importSpecifier: "./v6/sui_move_wasm.js",
      suiVersion: "1.26.2",
      verifierId: "sui-1.26.2",
    },
    "sui-1.70.2": {
      bytecodeFlavor: 5,
      decodedBytecodeVersion: 7,
      importSpecifier: null,
      suiVersion: "1.70.2",
      verifierId: "sui-1.70.2",
    },
  },
} as const;
