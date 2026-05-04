import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareBuildOutputs,
  normalizeOutput,
  writeJsonArtifact,
} from "./artifact_parity_helpers.mjs";
import {
  SUI_REPO_URL,
  LocalSuiFetcher,
  assertSuiCliVersion,
  createParityContext,
  formatSuiCliFailure,
  isInsideDir,
  pathExists,
  prepareParityWorktree,
  readMovePackageFiles,
  repoRoot,
  toArtifactPackageName,
} from "./parity_helpers.mjs";

const {
  suiVersion,
  mode,
  packageArgs,
  distDir,
  wasmPath,
  network,
  suiCli,
  suiBuildConfig,
  parityOutputDir,
  parityWorkDir,
} = createParityContext(
  process.argv.slice(2),
  "parity-cli-upgrade-artifact-output"
);
const defaultFrameworkPackageSubdirs = [
  "crates/sui-framework/packages/deepbook",
];

async function resolveDefaultPackages(workDir) {
  const resolved = [];
  for (const subdir of defaultFrameworkPackageSubdirs) {
    const packageDir = path.join(workDir, subdir);
    if (!(await pathExists(packageDir))) {
      throw new Error(
        `Default upgrade parity package does not exist: ${subdir}`
      );
    }
    resolved.push(packageDir);
  }
  return resolved;
}

async function resolvePackageArgs(workDir) {
  if (packageArgs.length === 0) {
    return resolveDefaultPackages(workDir);
  }

  const resolved = [];
  for (const arg of packageArgs) {
    const direct = path.resolve(repoRoot, arg);
    const underWorkDir = path.resolve(workDir, arg);
    if (await pathExists(direct)) {
      resolved.push(direct);
    } else if (await pathExists(underWorkDir)) {
      resolved.push(underWorkDir);
    } else {
      throw new Error(`Move package path does not exist: ${arg}`);
    }
  }
  return resolved;
}

function runSuiCliUpgradeCompileArtifact(packageDir) {
  const command = [
    "move",
    "build",
    "--dump-bytecode-as-base64",
    "--path",
    packageDir,
    "--build-env",
    network,
  ];
  const result = spawnSync(suiCli, command, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: Number(process.env.SUI_PARITY_CLI_TIMEOUT_MS || 180000),
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      formatSuiCliFailure({
        label: `Sui CLI upgrade compile artifact build failed in ${packageDir}`,
        command: [suiCli, ...command],
        packageDir,
        result,
      })
    );
  }

  const stdout = result.stdout.trim();
  const jsonStart = stdout.indexOf("{");
  const jsonEnd = stdout.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error(`Sui CLI did not emit JSON output for ${packageDir}`);
  }

  return JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
}

function toDisplayPackageName(packageDir, workDir) {
  if (isInsideDir(packageDir, workDir)) {
    return path.relative(workDir, packageDir).replace(/\\/g, "/");
  }
  return path.relative(repoRoot, packageDir).replace(/\\/g, "/");
}

async function main() {
  console.log(
    `Running CLI upgrade artifact parity tests in [${mode.toUpperCase()}] mode`
  );

  if (!(await pathExists(wasmPath))) {
    throw new Error(
      `Missing WASM artifact: ${wasmPath}. Run npm run build first.`
    );
  }

  assertSuiCliVersion(suiCli, suiVersion.version);

  const { resolvedCommit, workDir } = await prepareParityWorktree(
    suiBuildConfig,
    parityWorkDir
  );
  const packages = await resolvePackageArgs(workDir);

  const distUrl = pathToFileURL(path.join(distDir, "index.js")).href;
  const { initMovePackageBuilder, prepareMovePackageUpgrade } = await import(
    distUrl
  );
  await initMovePackageBuilder({ wasm: await fs.readFile(wasmPath) });

  const fetcher = new LocalSuiFetcher({
    sourceDir: suiBuildConfig.sourceDir,
    tag: suiVersion.tag,
    commit: resolvedCommit,
  });

  let failed = false;
  for (const packageDir of packages) {
    const packageName = toDisplayPackageName(packageDir, workDir);
    const artifactPackageName = toArtifactPackageName(packageName);
    const packageSubdir = isInsideDir(packageDir, workDir)
      ? path.relative(workDir, packageDir).replace(/\\/g, "/")
      : undefined;
    const rootGit = packageSubdir
      ? {
          git: SUI_REPO_URL,
          rev: suiVersion.tag || resolvedCommit,
          subdir: packageSubdir,
        }
      : undefined;
    console.log(`\n=== ${packageName} ===`);

    const rootFiles = await readMovePackageFiles(packageDir);
    const cliOutput = normalizeOutput(
      runSuiCliUpgradeCompileArtifact(packageDir)
    );
    const outputRoot = path.join(parityOutputDir, artifactPackageName);
    const wasmResult = await prepareMovePackageUpgrade({
      files: rootFiles,
      network,
      fetcher,
      rootGit,
      silenceWarnings: true,
    });

    await writeJsonArtifact(outputRoot, "cli.json", cliOutput);
    if ("error" in wasmResult) {
      failed = true;
      console.error(`[WASM] Upgrade preparation failed: ${wasmResult.error}`);
      await writeJsonArtifact(outputRoot, "wasm-error.json", wasmResult);
      continue;
    }

    const wasmOutput = normalizeOutput(wasmResult);
    const differences = compareBuildOutputs(
      "CLI",
      cliOutput,
      "WASM",
      wasmOutput
    );
    await writeJsonArtifact(outputRoot, "wasm.json", wasmOutput);

    if (differences.length > 0) {
      failed = true;
      console.error(`[Mismatch] ${differences.join("; ")}`);
    } else {
      console.log(
        `[OK] modules=${cliOutput.modules.length}, dependencies=${cliOutput.dependencies.length}, digest=${cliOutput.digest}`
      );
    }
  }

  if (failed) {
    throw new Error(
      `CLI upgrade artifact parity failed. See ${parityOutputDir}`
    );
  }

  console.log("\nCLI upgrade artifact parity tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
