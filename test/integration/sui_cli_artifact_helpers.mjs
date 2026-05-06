import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  modulesToOutput,
  readNamedMoveModules,
} from "./artifact_parity_helpers.mjs";
import { formatSuiCliFailure, repoRoot } from "./parity_helpers.mjs";

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

export function runSuiCliUpgradeArtifact({
  suiCli,
  packageDir,
  outputDir,
  label,
  environment,
  upgradeCapability,
  sender,
  gasBudget,
  gasPrice,
  gas,
  skipVerifyCompatibility = false,
  skipDependencyVerification = false,
}) {
  if (!upgradeCapability) {
    throw new Error(
      "Sui CLI upgrade artifact build requires upgradeCapability"
    );
  }
  const command = [
    "client",
    "upgrade",
    "--upgrade-capability",
    upgradeCapability,
    "--install-dir",
    outputDir,
    "--build-env",
    environment,
    "--serialize-unsigned-transaction",
    "--force",
    "--silence-warnings",
  ];
  if (skipVerifyCompatibility) {
    command.push("--skip-verify-compatibility");
  }
  if (skipDependencyVerification) {
    command.push("--skip-dependency-verification");
  }
  if (sender) {
    command.push("--sender", sender);
  }
  if (gasBudget) {
    command.push("--gas-budget", String(gasBudget));
  }
  if (gasPrice) {
    command.push("--gas-price", String(gasPrice));
  }
  if (Array.isArray(gas) && gas.length > 0) {
    command.push("--gas", ...gas.map(String));
  }
  command.push("--", packageDir);
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
  upgradeCapability,
  sender,
  gasBudget,
  gasPrice,
  gas,
  skipVerifyCompatibility,
  skipDependencyVerification,
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

  if (intent === "upgrade") {
    const buildOutputDir = path.join(outputRoot, "cli-upgrade");
    const cliResult = runSuiCliUpgradeArtifact({
      suiCli,
      packageDir,
      outputDir: buildOutputDir,
      label: `Sui CLI upgrade artifact build failed for ${fixtureName}`,
      environment,
      upgradeCapability,
      sender,
      gasBudget,
      gasPrice,
      gas,
      skipVerifyCompatibility,
      skipDependencyVerification,
    });
    return {
      kind: "upgrade",
      intent,
      cliResult,
      output: await readSuiCliBuildArtifact(buildOutputDir),
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
