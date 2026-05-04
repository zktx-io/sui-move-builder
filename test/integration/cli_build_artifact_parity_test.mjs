import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareModuleBytecode,
  modulesToOutput,
  readNamedMoveModules,
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
import { loadWasmBindings } from "./wasm_helpers.mjs";

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
  "parity-cli-build-artifact-output"
);
const defaultFrameworkPackageSubdirs = [
  "crates/sui-framework/packages/sui-framework",
  "crates/sui-framework/packages/sui-system",
];

function toDisplayPackageName(packageDir, workDir) {
  if (isInsideDir(packageDir, workDir)) {
    return path.relative(workDir, packageDir).replace(/\\/g, "/");
  }
  return path.relative(repoRoot, packageDir).replace(/\\/g, "/");
}

async function resolveDefaultPackages(workDir) {
  const resolved = [];
  for (const subdir of defaultFrameworkPackageSubdirs) {
    const packageDir = path.join(workDir, subdir);
    if (!(await pathExists(packageDir))) {
      throw new Error(
        `Default CLI build artifact package does not exist: ${subdir}`
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

function runSuiCliBuild(packageDir, outputDir) {
  const command = [
    "move",
    "build",
    "--path",
    packageDir,
    "--install-dir",
    outputDir,
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
        label: `Sui CLI build failed in ${packageDir}`,
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

function parseScalar(line) {
  const value = line.split(":").slice(1).join(":").trim();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "~") {
    return null;
  }
  return value;
}

function parseBuildInfoYaml(content) {
  const buildFlags = {};
  const dependencies = [];
  const lines = content.split(/\r?\n/);
  let inBuildFlags = false;
  let inDependencies = false;
  const flagIndent = /^ {4}[A-Za-z0-9_]+:/;

  for (const line of lines) {
    if (line === "  build_flags:") {
      inBuildFlags = true;
      inDependencies = false;
      continue;
    }
    if (line === "dependencies:") {
      inBuildFlags = false;
      inDependencies = true;
      continue;
    }

    if (inBuildFlags && flagIndent.test(line)) {
      const key = line.trim().split(":")[0];
      buildFlags[key] = parseScalar(line);
      continue;
    }

    if (inBuildFlags && line && !line.startsWith("    ")) {
      inBuildFlags = false;
    }

    if (inDependencies) {
      const match = line.match(/^[ ]{2}-\s+(.+)$/);
      if (match) {
        dependencies.push(match[1]);
      } else if (line && !line.startsWith("  ")) {
        inDependencies = false;
      }
    }
  }

  return { buildFlags, dependencies };
}

async function findPackageBuildDir(outputDir) {
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
  return packageDirs[0];
}

async function readCliBuildArtifacts(outputDir, packageName) {
  const packageBuildDir = await findPackageBuildDir(outputDir);
  const buildInfoPath = path.join(packageBuildDir, "BuildInfo.yaml");
  const modulesDir = path.join(packageBuildDir, "bytecode_modules");
  const buildInfoContent = await fs.readFile(buildInfoPath, "utf8");
  const { buildFlags, dependencies } = parseBuildInfoYaml(buildInfoContent);
  const namedModules = await readNamedMoveModules(modulesDir);

  const selectedFlags = {
    root_as_zero: buildFlags.root_as_zero,
    set_unpublished_deps_to_zero: buildFlags.set_unpublished_deps_to_zero,
    test_mode: buildFlags.test_mode,
  };

  return {
    package: packageName,
    ...modulesToOutput(namedModules),
    buildFlags: selectedFlags,
    dependencies,
  };
}

function assertCliBuildArtifactShape(output) {
  if (output.moduleCount < 1 || output.modules.length !== output.moduleCount) {
    throw new Error(`Invalid module count for ${output.package}`);
  }
  if (output.namedModules.length !== output.moduleCount) {
    throw new Error(`Invalid named module count for ${output.package}`);
  }
  for (const module of output.namedModules) {
    if (!module.name || !module.base64) {
      throw new Error(`Invalid module entry for ${output.package}`);
    }
  }
  if (output.buildFlags.root_as_zero !== false) {
    throw new Error(
      `${output.package}: expected root_as_zero=false, got ${output.buildFlags.root_as_zero}`
    );
  }
  if (output.buildFlags.set_unpublished_deps_to_zero !== false) {
    throw new Error(
      `${output.package}: expected set_unpublished_deps_to_zero=false, got ${output.buildFlags.set_unpublished_deps_to_zero}`
    );
  }
  if (output.buildFlags.test_mode !== false) {
    throw new Error(
      `${output.package}: expected test_mode=false, got ${output.buildFlags.test_mode}`
    );
  }
}

function ensureRawCompileSuccess(result, label) {
  const success =
    typeof result.success === "function" ? result.success() : result.success;
  const output =
    typeof result.output === "function" ? result.output() : result.output;
  if (!success) {
    return { error: output, category: "compile" };
  }
  try {
    return JSON.parse(output);
  } catch (error) {
    return {
      error: `${label} emitted invalid JSON: ${
        error instanceof Error ? error.message : error
      }`,
      category: "compiler_output",
    };
  }
}

async function compileWasmPublishPackage({
  resolveMovePackageDependencies,
  wasm,
  files,
  fetcher,
  rootGit,
}) {
  let resolved;
  try {
    resolved = await resolveMovePackageDependencies({
      files,
      network,
      fetcher,
      rootGit,
      silenceWarnings: true,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      category: "dependency_resolution",
    };
  }

  const raw = wasm.compile(
    resolved.files,
    resolved.dependencies,
    JSON.stringify({ compileIntent: "publish", silenceWarnings: true })
  );
  const result = ensureRawCompileSuccess(raw, "WASM publish compile");
  if (!("error" in result)) {
    result.intent = "publish";
  }
  return result;
}

async function main() {
  console.log(
    `Running CLI build artifact parity tests in [${mode.toUpperCase()}] mode`
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
  const { initMovePackageBuilder, resolveMovePackageDependencies } =
    await import(distUrl);
  await initMovePackageBuilder({ wasm: await fs.readFile(wasmPath) });
  const wasm = await loadWasmBindings(mode);
  const fetcher = new LocalSuiFetcher({
    sourceDir: suiBuildConfig.sourceDir,
    tag: suiVersion.tag,
    commit: resolvedCommit,
  });

  let failed = false;
  for (const packageDir of packages) {
    const packageName = toDisplayPackageName(packageDir, workDir);
    const artifactPackageName = toArtifactPackageName(packageName);
    const outputRoot = path.join(parityOutputDir, artifactPackageName);
    const buildOutputDir = path.join(outputRoot, "cli-build");
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

    try {
      await fs.rm(outputRoot, { recursive: true, force: true });
      await fs.mkdir(outputRoot, { recursive: true });
      const cliResult = runSuiCliBuild(packageDir, buildOutputDir);
      const cliOutput = await readCliBuildArtifacts(
        buildOutputDir,
        packageName
      );
      assertCliBuildArtifactShape(cliOutput);
      await writeJsonArtifact(outputRoot, "cli-build-artifact.json", cliOutput);
      await writeJsonArtifact(outputRoot, "cli-output.json", cliResult);

      const files = await readMovePackageFiles(packageDir);
      const wasmResult = await compileWasmPublishPackage({
        resolveMovePackageDependencies,
        wasm,
        files,
        fetcher,
        rootGit,
      });
      if ("error" in wasmResult) {
        const comparison = {
          ok: false,
          differences: ["WASM publish build failed"],
        };
        await writeJsonArtifact(outputRoot, "wasm-error.json", wasmResult);
        await writeJsonArtifact(outputRoot, "comparison.json", comparison);
        throw new Error(wasmResult.error);
      }

      const comparison = compareModuleBytecode(
        "cli",
        cliOutput,
        "wasm",
        wasmResult
      );

      await writeJsonArtifact(outputRoot, "wasm-package-artifact.json", {
        package: packageName,
        intent: wasmResult.intent,
        moduleCount: wasmResult.modules.length,
        modules: wasmResult.modules,
        dependencies: wasmResult.dependencies,
        digest: wasmResult.digest,
      });
      await writeJsonArtifact(outputRoot, "comparison.json", comparison);

      if (!comparison.ok) {
        failed = true;
        console.error(`[Mismatch] ${comparison.differences.join("; ")}`);
      } else {
        console.log(
          `[OK] intent=${wasmResult.intent}, modules=${cliOutput.moduleCount}`
        );
      }
    } catch (error) {
      failed = true;
      console.error(error instanceof Error ? error.message : error);
    }
  }

  if (failed) {
    throw new Error(`CLI build artifact parity failed. See ${parityOutputDir}`);
  }

  console.log("\nCLI build artifact parity tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
