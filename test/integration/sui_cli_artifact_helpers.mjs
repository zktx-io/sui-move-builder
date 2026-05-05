import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  modulesToOutput,
  normalizeOutput,
  readNamedMoveModules,
} from "./artifact_parity_helpers.mjs";
import { formatSuiCliFailure, repoRoot } from "./parity_helpers.mjs";

export function runSuiCliDumpArtifact({
  suiCli,
  packageDir,
  label,
  environment,
}) {
  const command = [
    "move",
    "build",
    "--dump-bytecode-as-base64",
    "--path",
    packageDir,
    "--build-env",
    environment,
  ];
  const result = runSuiCli({ suiCli, command, packageDir, label });
  const stdout = result.stdout.trim();
  const jsonStart = stdout.indexOf("{");
  const jsonEnd = stdout.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error(`Sui CLI did not emit JSON output for ${packageDir}`);
  }
  return JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
}

export function runSuiCliBuildArtifact({
  suiCli,
  packageDir,
  outputDir,
  label,
  environment,
}) {
  const command = [
    "move",
    "build",
    "--path",
    packageDir,
    "--install-dir",
    outputDir,
    "--build-env",
    environment,
  ];
  return runSuiCli({ suiCli, command, packageDir, label });
}

export async function readSuiCliBuildArtifact(outputDir) {
  const buildDir = path.join(outputDir, "build");
  const entries = await fs.readdir(buildDir, { withFileTypes: true });
  const packageDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(buildDir, entry.name))
    .sort();
  if (packageDirs.length !== 1) {
    throw new Error(
      `Expected exactly one built package under ${buildDir}, found ${packageDirs.length}`
    );
  }
  const modulesDir = path.join(packageDirs[0], "bytecode_modules");
  return modulesToOutput(await readNamedMoveModules(modulesDir));
}

export async function runSuiCliReferenceArtifact({
  suiCli,
  packageDir,
  outputRoot,
  fixtureName,
  intent,
  environment,
}) {
  if (intent === "publish") {
    const buildOutputDir = path.join(outputRoot, "cli-build");
    const cliResult = runSuiCliBuildArtifact({
      suiCli,
      packageDir,
      outputDir: buildOutputDir,
      label: `Sui CLI publish artifact build failed for ${fixtureName}`,
      environment,
    });
    return {
      kind: "publish",
      intent,
      cliResult,
      output: await readSuiCliBuildArtifact(buildOutputDir),
    };
  }

  if (intent === "dump" || intent === "upgrade") {
    return {
      kind: "dump",
      intent,
      cliResult: undefined,
      output: normalizeOutput(
        runSuiCliDumpArtifact({
          suiCli,
          packageDir,
          label: `Sui CLI current source build failed for ${fixtureName}`,
          environment,
        })
      ),
    };
  }

  throw new Error(`Unsupported CLI reference artifact intent: ${intent}`);
}

function runSuiCli({ suiCli, command, packageDir, label }) {
  const result = spawnSync(suiCli, command, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: Number(process.env.SUI_PARITY_CLI_TIMEOUT_MS || 180000),
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      formatSuiCliFailure({
        label,
        command: [suiCli, ...command],
        packageDir,
        result,
      })
    );
  }
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}
