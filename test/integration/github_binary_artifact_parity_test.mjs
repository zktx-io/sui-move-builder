import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareModuleBytecode,
  compareNamedModuleBytecode,
  modulesToOutput,
  normalizeOutput,
  readNamedMoveModules,
  writeJsonArtifact,
} from "./artifact_parity_helpers.mjs";
import {
  fetchGitHubBinaryModules,
  readGithubToken,
  writeGitHubSourceSnapshot,
} from "./github_artifact_helpers.mjs";
import {
  SUI_REPO_URL,
  LocalSuiFetcher,
  assertSuiCliVersion,
  createParityContext,
  ensureSuiSourceCheckout,
  formatSuiCliFailure,
  pathExists,
  readMovePackageFiles,
  repoRoot,
  toArtifactPackageName,
} from "./parity_helpers.mjs";

const {
  suiVersion,
  mode,
  distDir,
  wasmPath,
  network,
  suiCli,
  suiBuildConfig,
  parityOutputDir,
} = createParityContext(
  process.argv.slice(2),
  "parity-github-binary-artifact-output"
);

const fixtures = [
  {
    name: "sui-package-publish-bytecode-a",
    git: SUI_REPO_URL,
    commit: suiVersion.commit,
    packagePath:
      "crates/sui-single-node-benchmark/tests/data/package_publish_from_bytecode/package_a",
    binaryArtifactPath:
      "crates/sui-single-node-benchmark/tests/data/package_publish_from_bytecode/package_a/build/a/bytecode_modules",
    intent: "publish",
  },
];

function runSuiCliPublishArtifact(packageDir, outputDir, label, environment) {
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

async function readPublishCliOutput(outputDir) {
  const buildDir = path.join(outputDir, "build");
  const packageDirs = (await fs.readdir(buildDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(buildDir, entry.name))
    .sort();
  if (packageDirs.length !== 1) {
    throw new Error(
      `Expected exactly one built package under ${buildDir}, found ${packageDirs.length}`
    );
  }
  return modulesToOutput(
    await readNamedMoveModules(path.join(packageDirs[0], "bytecode_modules"))
  );
}

async function buildWasmPublishOutput({
  fixture,
  packageDir,
  distUrl,
  fetcher,
  environment,
}) {
  const { initMovePackageBuilder, prepareMovePackagePublish } = await import(
    distUrl
  );
  await initMovePackageBuilder({ wasm: await fs.readFile(wasmPath) });
  const result = await prepareMovePackagePublish({
    files: await readMovePackageFiles(packageDir),
    network: environment,
    fetcher,
    rootGit: {
      git: fixture.git,
      rev: fixture.commit,
      subdir: fixture.packagePath,
    },
    silenceWarnings: true,
  });
  if ("error" in result) {
    throw new Error(`WASM publish build failed: ${result.error}`);
  }
  return normalizeOutput(result);
}

async function main() {
  console.log(
    `Running GitHub binary artifact parity tests in [${mode.toUpperCase()}] mode`
  );
  if (!(await pathExists(wasmPath))) {
    throw new Error(
      `Missing WASM artifact: ${wasmPath}. Run npm run build first.`
    );
  }
  assertSuiCliVersion(suiCli, suiVersion.version);

  const token = await readGithubToken();
  const distUrl = pathToFileURL(path.join(distDir, "index.js")).href;
  await ensureSuiSourceCheckout(suiBuildConfig);
  const fetcher = new LocalSuiFetcher({
    sourceDir: suiBuildConfig.sourceDir,
    tag: suiVersion.tag,
    commit: suiVersion.commit,
  });
  let failed = false;

  for (const fixture of fixtures) {
    if (!fixture.intent) {
      throw new Error(`${fixture.name}: fixture must declare an intent`);
    }
    if (fixture.intent !== "publish") {
      throw new Error(
        `${fixture.name}: unsupported binary artifact intent ${fixture.intent}`
      );
    }

    const artifactPackageName = toArtifactPackageName(fixture.name);
    const outputRoot = path.join(parityOutputDir, artifactPackageName);
    const sourceRoot = path.join(outputRoot, "source");
    const packageDir = path.join(sourceRoot, fixture.packagePath);
    const cliOutputDir = path.join(outputRoot, "cli-build");
    const environment = fixture.network || network;
    console.log(`\n=== ${fixture.name} ===`);

    try {
      await fs.rm(outputRoot, { recursive: true, force: true });
      await fs.mkdir(outputRoot, { recursive: true });
      await writeGitHubSourceSnapshot({
        git: fixture.git,
        commit: fixture.commit,
        packagePath: fixture.packagePath,
        outputDir: sourceRoot,
        token,
      });

      const githubOutput = modulesToOutput(
        await fetchGitHubBinaryModules({
          git: fixture.git,
          commit: fixture.commit,
          binaryArtifactPath: fixture.binaryArtifactPath,
          token,
        })
      );
      await writeJsonArtifact(outputRoot, "github-binary.json", githubOutput);

      const cliResult = runSuiCliPublishArtifact(
        packageDir,
        cliOutputDir,
        `Sui CLI publish artifact build failed for ${fixture.name}`,
        environment
      );
      const cliOutput = await readPublishCliOutput(cliOutputDir);
      await writeJsonArtifact(outputRoot, "cli-output.json", cliResult);
      await writeJsonArtifact(outputRoot, "cli.json", cliOutput);

      const wasmOutput = await buildWasmPublishOutput({
        fixture,
        packageDir,
        distUrl,
        fetcher,
        environment,
      });
      await writeJsonArtifact(outputRoot, "wasm.json", wasmOutput);

      const githubVsCli = compareNamedModuleBytecode(
        "github",
        githubOutput,
        "cli",
        cliOutput
      );
      const githubVsWasmSorted = compareModuleBytecode(
        "github",
        githubOutput,
        "wasm",
        wasmOutput
      );
      const cliVsWasm = compareModuleBytecode(
        "CLI",
        cliOutput,
        "WASM",
        wasmOutput
      );
      const comparison = {
        ok: cliVsWasm.ok,
        githubVsCli,
        githubVsWasm: githubVsWasmSorted,
        cliVsWasm,
      };
      await writeJsonArtifact(outputRoot, "comparison.json", comparison);

      if (!comparison.ok) {
        failed = true;
        console.error(`[Mismatch] ${JSON.stringify(comparison, null, 2)}`);
      } else if (!githubVsCli.ok || !githubVsWasmSorted.ok) {
        console.log(
          `[DIFF] committed modules differ from current build output; see ${path.join(outputRoot, "comparison.json")}`
        );
      } else {
        console.log(`[OK] modules=${githubOutput.moduleCount}`);
      }
    } catch (error) {
      failed = true;
      console.error(error instanceof Error ? error.message : error);
    }
  }

  if (failed) {
    throw new Error(
      `GitHub binary artifact parity failed. See ${parityOutputDir}`
    );
  }
  console.log("\nGitHub binary artifact parity tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
