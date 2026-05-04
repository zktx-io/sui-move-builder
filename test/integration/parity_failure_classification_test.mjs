import {
  classifySuiCliFailure,
  formatSuiCliFailure,
} from "./parity_helpers.mjs";

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

assertEqual(
  classifySuiCliFailure({ error: { code: "ENOENT", message: "spawn sui" } }),
  "missing local tool",
  "missing CLI binary"
);

assertEqual(
  classifySuiCliFailure({
    status: 1,
    stderr:
      "Failed to fetch package MoveStdlib\nCaused by:\n    tcp connect error",
  }),
  "network",
  "CLI dependency fetch failure"
);

assertEqual(
  classifySuiCliFailure({
    error: { code: "ETIMEDOUT", message: "spawn sui ETIMEDOUT" },
  }),
  "network",
  "CLI timeout failure"
);

assertEqual(
  classifySuiCliFailure({
    status: 1,
    stderr: "BUILDING Fixture\nerror[E03001]: invalid module",
  }),
  "CLI build failure",
  "real CLI build failure"
);

assertEqual(
  classifySuiCliFailure({
    status: 1,
    stderr:
      "BUILDING network_module\nerror[E04001]: cannot find module network::fixture",
  }),
  "CLI build failure",
  "real CLI build failure containing network text"
);

const formatted = formatSuiCliFailure({
  label: "Sui CLI build failed",
  command: ["sui", "move", "build"],
  result: {
    status: 1,
    stderr: "Failed to fetch package MoveStdlib",
  },
});
if (!formatted.includes("Category: network")) {
  throw new Error("formatted CLI failure should include category");
}

console.log("[OK] CLI parity failures are categorized");
