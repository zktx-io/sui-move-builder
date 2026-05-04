import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const semanticCases = [
  "dist-load",
  "compat-manifest",
  "cli-pipeline-table",
  "doc-freshness",
  "package-loading",
  "manifest-digest",
  "manifest-digest-cli-parity",
  "manifest-fallback",
  "lockfile-graph",
  "lockfile-generation",
  "source-discovery",
  "compiler-lint",
  "intent-api",
  "published-toml-recording",
  "build-options",
  "output-deps",
  "unit-test-output-parity",
  "unit-test-modes",
  "unit-test-ownership",
];

const caseFiles = new Map([
  ["dist-load", "runtime_smoke.mjs"],
  ["compat-manifest", "compat_manifest_test.mjs"],
  ["cli-pipeline-table", "cli_pipeline_table_test.mjs"],
  ["doc-freshness", "doc_freshness_test.mjs"],
  ["package-loading", "package_loading_test.mjs"],
  ["manifest-digest", "manifest_digest_test.mjs"],
  ["manifest-digest-cli-parity", "manifest_digest_cli_parity_test.mjs"],
  ["manifest-fallback", "manifest_fallback_test.mjs"],
  ["lockfile-graph", "lockfile_digest_test.mjs"],
  ["lockfile-generation", "lockfile_generation_test.mjs"],
  ["source-discovery", "source_discovery_test.mjs"],
  ["compiler-lint", "compiler_lint_test.mjs"],
  ["intent-api", "intent_api_test.mjs"],
  ["published-toml-recording", "published_toml_recording_test.mjs"],
  ["build-options", "build_options_test.mjs"],
  ["output-deps", "output_dependency_test.mjs"],
  ["unit-test-output-parity", "test_output_parity_test.mjs"],
  ["unit-test-modes", "test_modes_test.mjs"],
  ["unit-test-ownership", "test_ownership_test.mjs"],
]);

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCase(name, extraArgs = []) {
  const file = caseFiles.get(name);
  if (!file) {
    throw new Error(`Unknown integration case: ${name}`);
  }
  runNode([`test/integration/${file}`, ...extraArgs]);
}

function runSemantic() {
  for (const name of semanticCases) {
    runCase(name);
  }
}

function runParity(args) {
  const [first, ...rest] = args;
  if (first === "full" || first === "lite") {
    runNode(["test/integration/fidelity_test.mjs", first, ...rest]);
    return;
  }
  runNode(["test/integration/fidelity_test.mjs", "full", ...args]);
  runNode(["test/integration/fidelity_test.mjs", "lite", ...args]);
}

function auditCommands(kind, mode) {
  const kinds = kind ? [kind] : ["build", "upgrade"];
  const modes = mode ? [mode] : ["full", "lite"];
  const commands = [];
  for (const selectedKind of kinds) {
    const file =
      selectedKind === "build"
        ? "cli_build_artifact_parity_test.mjs"
        : "cli_upgrade_artifact_parity_test.mjs";
    for (const selectedMode of modes) {
      commands.push([`test/integration/${file}`, selectedMode]);
    }
  }
  return commands;
}

function runAudit(args) {
  let kind;
  let mode;
  for (const arg of args) {
    if (arg === "build" || arg === "upgrade") {
      kind = arg;
    } else if (arg === "full" || arg === "lite") {
      mode = arg;
    } else {
      throw new Error(`Unknown audit argument: ${arg}`);
    }
  }
  for (const command of auditCommands(kind, mode)) {
    runNode(command);
  }
}

function runBrowser(args) {
  const [mode] = args;
  if (mode === "full" || mode === "lite") {
    runNode(["test/integration/browser_smoke.mjs", mode]);
    return;
  }
  if (mode) {
    throw new Error(`Unknown browser argument: ${mode}`);
  }
  runNode(["test/integration/browser_smoke.mjs", "lite"]);
  runNode(["test/integration/browser_smoke.mjs", "full"]);
}

const [command = "default", ...args] = process.argv.slice(2);

if (command === "default") {
  runSemantic();
  runParity([]);
} else if (command === "semantic") {
  runSemantic();
} else if (command === "parity") {
  runParity(args);
} else if (command === "audit") {
  runAudit(args);
} else if (command === "browser") {
  runBrowser(args);
} else {
  runCase(command, args);
}
