import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SUI_REPO_URL,
  ensureSuiSourceCheckout,
  getSuiBuildConfig,
  prepareSuiWorktree,
  resolveSuiVersionConfig,
  resolveSuiSourceCommit,
} from "../../scripts/sui-workspace.mjs";

const require = createRequire(import.meta.url);
const baseSuiVersion = require("../../sui-version.json");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const { suiVersion, restArgs } = resolveSuiVersionConfig(
  baseSuiVersion,
  process.argv.slice(2)
);
const modeArg =
  restArgs[0] === "full" || restArgs[0] === "lite" ? restArgs.shift() : "full";
const mode = modeArg === "lite" ? "lite" : "full";
const packageArgs = restArgs;
const distDir = path.join(repoRoot, "dist", mode);
const wasmPath = path.join(distDir, "sui_move_wasm_bg.wasm");
const network = process.env.SUI_PARITY_NETWORK || "mainnet";
const suiCli = resolveSuiCli(process.env.SUI_CLI || "sui");
const maxPackages = Number(process.env.SUI_PARITY_LIMIT || 5);
const minMoveFiles = Number(process.env.SUI_PARITY_MIN_MOVE_FILES || 2);
const defaultFrameworkPackageSubdirs = [
  "crates/sui-framework/packages/deepbook",
  "crates/sui-framework/packages/sui-system",
];

const suiBuildConfig = getSuiBuildConfig(repoRoot, suiVersion);
const parityWorkDir =
  process.env.SUI_PARITY_WORK_DIR ||
  path.join(suiBuildConfig.buildWorkspaceDir, "parity-work");
const parityOutputDir = path.join(
  suiBuildConfig.buildWorkspaceDir,
  "parity-output",
  mode
);

function resolveSuiCli(cli) {
  if (path.isAbsolute(cli) || cli.includes("/") || cli.includes("\\")) {
    return path.resolve(repoRoot, cli);
  }
  return cli;
}

class LocalSuiFetcher {
  constructor({ sourceDir, tag, commit }) {
    this.sourceDir = sourceDir;
    this.tag = tag;
    this.commit = commit;
  }

  isSuiRepo(gitUrl) {
    try {
      const url = new URL(gitUrl);
      const parts = url.pathname
        .replace(/\.git$/, "")
        .split("/")
        .filter(Boolean);
      return (
        url.hostname.toLowerCase() === "github.com" &&
        parts[0]?.toLowerCase() === "mystenlabs" &&
        parts[1]?.toLowerCase() === "sui"
      );
    } catch {
      return false;
    }
  }

  acceptsRev(rev) {
    return (
      rev === this.tag ||
      rev === this.commit ||
      (typeof rev === "string" && this.commit.startsWith(rev))
    );
  }

  async fetch(gitUrl, rev, subdir = "") {
    if (!this.isSuiRepo(gitUrl)) {
      throw new Error(`Unexpected git dependency in parity test: ${gitUrl}`);
    }
    if (!this.acceptsRev(rev)) {
      throw new Error(
        `Unexpected Sui revision in parity test: ${rev}. Expected ${this.tag} or ${this.commit}`
      );
    }
    return readMovePackageFiles(path.join(this.sourceDir, subdir));
  }

  async fetchFile(gitUrl, rev, filePath) {
    if (!this.isSuiRepo(gitUrl) || !this.acceptsRev(rev)) {
      return null;
    }
    try {
      return await fs.readFile(path.join(this.sourceDir, filePath), "utf8");
    } catch {
      return null;
    }
  }

  getResolvedSha(gitUrl, rev) {
    if (this.isSuiRepo(gitUrl) && this.acceptsRev(rev)) {
      return this.commit;
    }
    return undefined;
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isIgnoredDir(name) {
  return (
    name === ".git" ||
    name === "build" ||
    name === "target" ||
    name === "node_modules"
  );
}

async function readMovePackageFiles(packageDir) {
  const files = {};

  async function visit(currentDir, baseDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) {
          await visit(path.join(currentDir, entry.name), baseDir);
        }
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      if (
        entry.name.endsWith(".move") ||
        entry.name.endsWith(".toml") ||
        entry.name.endsWith(".lock")
      ) {
        files[relativePath] = await fs.readFile(fullPath, "utf8");
      }
    }
  }

  await visit(packageDir, packageDir);
  return files;
}

async function countMoveFiles(packageDir) {
  let count = 0;

  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) {
          await visit(path.join(currentDir, entry.name));
        }
      } else if (entry.name.endsWith(".move")) {
        count += 1;
      }
    }
  }

  await visit(packageDir);
  return count;
}

async function discoverMovePackages(examplesDir) {
  const packages = [];

  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const hasMoveToml = entries.some(
      (entry) => entry.isFile() && entry.name === "Move.toml"
    );

    if (hasMoveToml) {
      const moveFileCount = await countMoveFiles(currentDir);
      if (moveFileCount >= minMoveFiles) {
        packages.push({ dir: currentDir, moveFileCount });
      }
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !isIgnoredDir(entry.name)) {
        await visit(path.join(currentDir, entry.name));
      }
    }
  }

  await visit(examplesDir);
  packages.sort(
    (a, b) => b.moveFileCount - a.moveFileCount || a.dir.localeCompare(b.dir)
  );
  return packages.slice(0, maxPackages).map((pkg) => pkg.dir);
}

function uniquePackageDirs(packages) {
  const seen = new Set();
  return packages.filter((packageDir) => {
    const key = path.resolve(packageDir);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function resolveDefaultPackages(examplesDir, workDir) {
  const discovered = await discoverMovePackages(examplesDir);
  const frameworkPackages = [];

  for (const subdir of defaultFrameworkPackageSubdirs) {
    const packageDir = path.join(workDir, subdir);
    if (!(await pathExists(packageDir))) {
      throw new Error(`Default parity package does not exist: ${subdir}`);
    }
    frameworkPackages.push(packageDir);
  }

  return uniquePackageDirs([...discovered, ...frameworkPackages]);
}

async function resolvePackageArgs(examplesDir, workDir) {
  if (packageArgs.length === 0) {
    return resolveDefaultPackages(examplesDir, workDir);
  }

  const resolved = [];
  for (const arg of packageArgs) {
    const direct = path.resolve(repoRoot, arg);
    const underExamples = path.resolve(examplesDir, arg);
    const underWorkDir = path.resolve(workDir, arg);
    if (await pathExists(direct)) {
      resolved.push(direct);
    } else if (await pathExists(underExamples)) {
      resolved.push(underExamples);
    } else if (await pathExists(underWorkDir)) {
      resolved.push(underWorkDir);
    } else {
      throw new Error(`Move package path does not exist: ${arg}`);
    }
  }
  return uniquePackageDirs(resolved);
}

function runSuiCliBuild(packageDir) {
  const result = spawnSync(
    suiCli,
    ["move", "build", "--dump-bytecode-as-base64", "--path", packageDir],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
      timeout: Number(process.env.SUI_PARITY_CLI_TIMEOUT_MS || 180000),
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `Sui CLI build failed in ${packageDir}`,
        result.stderr?.trim(),
        result.stdout?.trim(),
      ]
        .filter(Boolean)
        .join("\n")
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

function assertSuiCliVersion() {
  const result = spawnSync(suiCli, ["--version"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim();
    throw new Error(
      `Unable to run '${suiCli} --version'. Set SUI_CLI to an installed Sui binary.${
        detail ? `\n${detail}` : ""
      }`
    );
  }

  const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
  if (!versionOutput) {
    throw new Error(`'${suiCli} --version' did not emit a version.`);
  }
  if (!versionOutput.includes(suiVersion.version)) {
    console.warn(
      `[WARN] Sui CLI version mismatch. Expected ${suiVersion.version}, got: ${versionOutput}.`
    );
  }
  console.log(`[CLI] ${versionOutput}`);
}

function normalizeDigest(digest) {
  if (Array.isArray(digest)) {
    return Buffer.from(digest).toString("hex");
  }
  if (typeof digest === "string") {
    return digest.replace(/^0x/, "").toLowerCase();
  }
  throw new Error(`Unsupported digest shape: ${typeof digest}`);
}

function normalizeDependencies(dependencies) {
  if (!Array.isArray(dependencies)) {
    throw new Error("Build output dependencies must be an array");
  }
  return dependencies.map((dep) => String(dep).toLowerCase());
}

function normalizeOutput(output) {
  if (!Array.isArray(output.modules)) {
    throw new Error("Build output modules must be an array");
  }
  return {
    modules: output.modules,
    dependencies: normalizeDependencies(output.dependencies || []),
    digest: normalizeDigest(output.digest),
  };
}

function compareArrays(label, left, right, differences) {
  if (left.length !== right.length) {
    differences.push(
      `${label} count differs: CLI=${left.length}, WASM=${right.length}`
    );
    return;
  }

  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      differences.push(`${label}[${i}] differs`);
      return;
    }
  }
}

function compareBuilds(cliOutput, wasmOutput) {
  const differences = [];
  compareArrays("modules", cliOutput.modules, wasmOutput.modules, differences);
  compareArrays(
    "dependencies",
    cliOutput.dependencies,
    wasmOutput.dependencies,
    differences
  );
  if (cliOutput.digest !== wasmOutput.digest) {
    differences.push(
      `digest differs: CLI=${cliOutput.digest}, WASM=${wasmOutput.digest}`
    );
  }
  return differences;
}

function isInsideDir(child, parent) {
  const relative = path.relative(parent, child);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function toDisplayPackageName(packageDir, examplesDir, workDir) {
  let baseDir = repoRoot;
  if (isInsideDir(packageDir, examplesDir)) {
    baseDir = examplesDir;
  } else if (isInsideDir(packageDir, workDir)) {
    baseDir = workDir;
  }
  return (
    path.relative(baseDir, packageDir).replace(/\\/g, "/") ||
    path.basename(packageDir)
  );
}

function toArtifactPackageName(displayName) {
  const safeParts = displayName
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_"));
  return safeParts.join("__") || "root";
}

async function writeArtifact(artifactPackageName, name, data) {
  const dir = path.join(parityOutputDir, artifactPackageName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), JSON.stringify(data, null, 2));
}

async function main() {
  console.log(
    `Running CLI-vs-WASM parity tests in [${mode.toUpperCase()}] mode`
  );

  if (!(await pathExists(wasmPath))) {
    throw new Error(
      `Missing WASM artifact: ${wasmPath}. Run npm run build first.`
    );
  }

  assertSuiCliVersion();

  await ensureSuiSourceCheckout(suiBuildConfig);
  const resolvedCommit = await resolveSuiSourceCommit(suiBuildConfig);
  const workDir = await prepareSuiWorktree(suiBuildConfig, {
    workDir: parityWorkDir,
    updateSubmodules: true,
  });

  const examplesDir = path.join(workDir, "examples", "move");
  const packages = await resolvePackageArgs(examplesDir, workDir);
  if (packages.length === 0) {
    throw new Error(`No Move packages found under ${examplesDir}`);
  }

  const distUrl = pathToFileURL(path.join(distDir, "index.js")).href;
  const { initMoveCompiler, buildMovePackage } = await import(distUrl);
  await initMoveCompiler({ wasm: await fs.readFile(wasmPath) });

  const fetcher = new LocalSuiFetcher({
    sourceDir: suiBuildConfig.sourceDir,
    tag: suiVersion.tag,
    commit: resolvedCommit,
  });

  let failed = false;
  for (const packageDir of packages) {
    const packageName = toDisplayPackageName(packageDir, examplesDir, workDir);
    const artifactPackageName = toArtifactPackageName(packageName);
    const packageSubdir = isInsideDir(packageDir, workDir)
      ? path.relative(workDir, packageDir).replace(/\\/g, "/")
      : undefined;
    console.log(`\n=== ${packageName} ===`);

    const rootFiles = await readMovePackageFiles(packageDir);
    const rootGit = packageSubdir
      ? {
          git: SUI_REPO_URL,
          rev: suiVersion.tag || resolvedCommit,
          subdir: packageSubdir,
        }
      : undefined;

    const cliOutput = normalizeOutput(runSuiCliBuild(packageDir));
    const wasmResult = await buildMovePackage({
      files: rootFiles,
      network,
      fetcher,
      rootGit,
      silenceWarnings: true,
    });

    if ("error" in wasmResult) {
      failed = true;
      console.error(`[WASM] Build failed: ${wasmResult.error}`);
      await writeArtifact(artifactPackageName, "cli.json", cliOutput);
      await writeArtifact(artifactPackageName, "wasm-error.json", wasmResult);
      continue;
    }

    const wasmOutput = normalizeOutput(wasmResult);
    const differences = compareBuilds(cliOutput, wasmOutput);
    await writeArtifact(artifactPackageName, "cli.json", cliOutput);
    await writeArtifact(artifactPackageName, "wasm.json", wasmOutput);

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
    throw new Error(`CLI-vs-WASM parity failed. See ${parityOutputDir}`);
  }

  console.log("\nCLI-vs-WASM parity tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
