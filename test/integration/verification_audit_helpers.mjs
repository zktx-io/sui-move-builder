import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareBuildOutputs,
  compareModuleBytecode,
  normalizeOutput,
} from "./artifact_parity_helpers.mjs";
import { pathExists, repoRoot } from "./parity_helpers.mjs";

let verificationApi;

export async function loadVerificationApi() {
  if (verificationApi) {
    return verificationApi;
  }

  const distDir = path.join(repoRoot, "dist", "verification");
  const wasmPath = path.join(distDir, "sui_move_wasm_bg.wasm");
  if (!(await pathExists(wasmPath))) {
    throw new Error(
      `Missing verification WASM artifact: ${wasmPath}. Run npm run build first.`
    );
  }

  const mod = await import(pathToFileURL(path.join(distDir, "index.js")).href);
  await mod.initMovePackageVerifier({ wasm: await fs.readFile(wasmPath) });
  verificationApi = mod;
  return verificationApi;
}

export async function verifyReferenceProvenance({
  files,
  intent,
  network,
  fetcher,
  githubToken,
  rootGit,
  reference,
}) {
  const { verifyMovePackageProvenance } = await loadVerificationApi();
  return verifyMovePackageProvenance({
    files,
    intent,
    network,
    fetcher,
    githubToken,
    rootGit,
    reference,
    silenceWarnings: true,
  });
}

export function compareCliWithVerificationCurrent(cliOutput, verification) {
  if (!verification.currentBuild) {
    return {
      ok: false,
      currentBuild: undefined,
      modules: {
        ok: false,
        differences: ["verification result has no currentBuild"],
      },
      output: ["verification result has no currentBuild"],
    };
  }
  const currentBuild = normalizeOutput(verification.currentBuild);
  const modules = compareModuleBytecode(
    "CLI",
    cliOutput,
    "verification",
    currentBuild
  );
  const output = compareBuildOutputs(
    "CLI",
    cliOutput,
    "verification",
    currentBuild
  );
  return {
    ok: modules.ok && output.length === 0,
    currentBuild,
    modules,
    output,
  };
}

export function compareCliReferenceWithVerificationCurrent(
  cliReference,
  verification
) {
  if (cliReference.kind === "dump") {
    return compareCliWithVerificationCurrent(cliReference.output, verification);
  }
  if (!verification.currentBuild) {
    return {
      ok: false,
      currentBuild: undefined,
      modules: {
        ok: false,
        differences: ["verification result has no currentBuild"],
      },
      output: ["verification result has no currentBuild"],
    };
  }
  const currentBuild = normalizeOutput(verification.currentBuild);
  const modules = compareModuleBytecode(
    "CLI publish",
    cliReference.output,
    "verification",
    currentBuild
  );
  return {
    ok: modules.ok,
    currentBuild,
    modules,
    output: [],
  };
}

export function verificationStatusGate(fixture, verification) {
  const differences = [];
  if (!fixture.expectedStatus) {
    differences.push(`${fixture.name}: fixture must declare expectedStatus`);
  }
  if (
    verification.status === "build_failure" ||
    verification.status === "invalid_reference"
  ) {
    differences.push(
      `${fixture.name}: verification returned ${verification.status}: ${
        verification.error || "<no error>"
      }`
    );
  }
  if (
    fixture.expectedStatus &&
    verification.status !== fixture.expectedStatus
  ) {
    differences.push(
      `${fixture.name}: expected verification status ${fixture.expectedStatus}, got ${verification.status}`
    );
  }
  if (
    fixture.expectedVerdict &&
    verification.verdict !== fixture.expectedVerdict
  ) {
    differences.push(
      `${fixture.name}: expected verification verdict ${fixture.expectedVerdict}, got ${verification.verdict}`
    );
  }
  if (fixture.expectedVerdict === "format_drift") {
    differences.push(
      ...formatDriftConsistencyDifferences(fixture, verification)
    );
  }
  return {
    ok: differences.length === 0,
    differences,
  };
}

function formatDriftConsistencyDifferences(fixture, verification) {
  const differences = [];
  const bytecodeDiffs = verification.bytecodeDiffs || [];
  if (bytecodeDiffs.length === 0) {
    differences.push(`${fixture.name}: format_drift has no bytecodeDiffs`);
    return differences;
  }
  for (const diff of bytecodeDiffs) {
    const label = diff.module || "<unnamed module>";
    if (diff.classification !== "format_drift") {
      differences.push(
        `${fixture.name}: ${label} expected format_drift bytecode classification, got ${diff.classification}`
      );
    }
    const changedTables = diff.changedTables || [];
    if (changedTables.length === 0) {
      differences.push(`${fixture.name}: ${label} has no changedTables`);
    }
    for (const table of changedTables) {
      if (table.name !== "function_defs") {
        differences.push(
          `${fixture.name}: ${label} changed unexpected table ${table.name}`
        );
      }
      if (!table.referenceSha256 || !table.currentBuildSha256) {
        differences.push(
          `${fixture.name}: ${label} ${table.name} is missing table hash evidence`
        );
      }
      if (table.sameSha256 !== false) {
        differences.push(
          `${fixture.name}: ${label} ${table.name} should have distinct table hashes`
        );
      }
    }
    if (diff.identity?.matches !== true) {
      differences.push(
        `${fixture.name}: ${label} identity evidence does not match`
      );
    }
    if (diff.shape?.matches !== true) {
      differences.push(
        `${fixture.name}: ${label} shape evidence does not match`
      );
    }
  }
  return differences;
}
