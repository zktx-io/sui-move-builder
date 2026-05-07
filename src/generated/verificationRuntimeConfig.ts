// AUTO-GENERATED. Do not edit directly.
// Generated from scripts/verification/bytecode-verifiers.json and scripts/verification/bytecode-version-sources.json.
// Run npm run generate:verification-runtime-config after changing either source.

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
      defaultEdition: "legacy",
      importSpecifier: "./v6/sui_move_wasm.js",
      suiVersion: "1.26.2",
      supportedEditions: ["legacy", "2024.alpha", "2024.beta"],
      verifierId: "sui-1.26.2",
    },
    "sui-1.70.2": {
      bytecodeFlavor: 5,
      decodedBytecodeVersion: 7,
      defaultEdition: "2024",
      importSpecifier: null,
      suiVersion: "1.70.2",
      supportedEditions: ["legacy", "2024.alpha", "2024.beta", "2024"],
      verifierId: "sui-1.70.2",
    },
  },
} as const;
