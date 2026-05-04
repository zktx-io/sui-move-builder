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
  network,
  fetcher,
  githubToken,
  rootGit,
  reference,
}) {
  const { verifyMovePackageProvenance } = await loadVerificationApi();
  return verifyMovePackageProvenance({
    files,
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
  return {
    ok: differences.length === 0,
    differences,
  };
}
