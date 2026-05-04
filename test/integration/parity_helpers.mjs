import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUI_REPO_URL,
  ensureSuiSourceCheckout,
  getSuiBuildConfig,
  prepareSuiWorktree,
  resolveSuiSourceCommit,
  resolveSuiVersionConfig,
} from "../../scripts/sui-workspace.mjs";

const require = createRequire(import.meta.url);
const baseSuiVersion = require("../../sui-version.json");

export { SUI_REPO_URL, ensureSuiSourceCheckout };

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

export function createParityContext(argv, outputDirName) {
  const { suiVersion, restArgs } = resolveSuiVersionConfig(
    baseSuiVersion,
    argv
  );
  const modeArg =
    restArgs[0] === "full" || restArgs[0] === "lite"
      ? restArgs.shift()
      : "full";
  const mode = modeArg === "lite" ? "lite" : "full";
  const suiBuildConfig = getSuiBuildConfig(repoRoot, suiVersion);
  const parityWorkDir =
    process.env.SUI_PARITY_WORK_DIR ||
    path.join(suiBuildConfig.buildWorkspaceDir, "parity-work");

  return {
    suiVersion,
    mode,
    packageArgs: restArgs,
    distDir: path.join(repoRoot, "dist", mode),
    wasmPath: path.join(repoRoot, "dist", mode, "sui_move_wasm_bg.wasm"),
    network: process.env.SUI_PARITY_NETWORK || "mainnet",
    suiCli: resolveSuiCli(process.env.SUI_CLI || "sui"),
    suiBuildConfig,
    parityWorkDir,
    parityOutputDir: path.join(
      suiBuildConfig.buildWorkspaceDir,
      outputDirName,
      mode
    ),
  };
}

export function createVerificationAuditContext(argv, outputDirName) {
  const { suiVersion, restArgs } = resolveSuiVersionConfig(
    baseSuiVersion,
    argv
  );
  if (restArgs[0] === "verification") {
    restArgs.shift();
  }
  if (restArgs.length > 0) {
    throw new Error(`Unknown verification audit argument: ${restArgs[0]}`);
  }

  const mode = "verification";
  const suiBuildConfig = getSuiBuildConfig(repoRoot, suiVersion);
  return {
    suiVersion,
    mode,
    distDir: path.join(repoRoot, "dist", mode),
    wasmPath: path.join(repoRoot, "dist", mode, "sui_move_wasm_bg.wasm"),
    network: process.env.SUI_PARITY_NETWORK || "mainnet",
    suiCli: resolveSuiCli(process.env.SUI_CLI || "sui"),
    suiBuildConfig,
    parityOutputDir: path.join(
      suiBuildConfig.buildWorkspaceDir,
      outputDirName,
      mode
    ),
  };
}

export function resolveSuiCli(cli) {
  if (path.isAbsolute(cli) || cli.includes("/") || cli.includes("\\")) {
    return path.resolve(repoRoot, cli);
  }
  return cli;
}

export class LocalSuiFetcher {
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

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function isIgnoredDir(name) {
  return (
    name === ".git" ||
    name === "build" ||
    name === "target" ||
    name === "node_modules"
  );
}

export async function readMovePackageFiles(packageDir) {
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

export function isInsideDir(child, parent) {
  const relative = path.relative(parent, child);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function toArtifactPackageName(displayName) {
  const safeParts = displayName
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_"));
  return safeParts.join("__") || "root";
}

export function assertSuiCliVersion(suiCli, expectedVersion) {
  const result = spawnSync(suiCli, ["--version"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim();
    throw new Error(
      [
        `Unable to run '${suiCli} --version'. Set SUI_CLI to an installed Sui binary.`,
        "Category: missing local tool",
        detail,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
  if (!versionOutput) {
    throw new Error(`'${suiCli} --version' did not emit a version.`);
  }
  if (!versionOutput.includes(expectedVersion)) {
    console.warn(
      `[WARN] Sui CLI version mismatch. Expected ${expectedVersion}, got: ${versionOutput}.`
    );
  }
  console.log(`[CLI] ${versionOutput}`);
}

export function classifySuiCliFailure(result) {
  if (isMissingSuiCli(result)) {
    return "missing local tool";
  }

  if (isNetworkSuiCliFailure(result)) {
    return "network";
  }

  return "CLI build failure";
}

function isMissingSuiCli(result) {
  return result?.error?.code === "ENOENT";
}

function isNetworkSuiCliFailure(result) {
  if (result?.error?.code === "ETIMEDOUT") {
    return true;
  }

  const output = [result?.error?.message, result?.stdout, result?.stderr]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return /tcp connect error|could not resolve|connection (timed out|refused|reset)|operation timed out|temporary failure in name resolution|failed to clone|unable to access|network (error|failure|timeout)/.test(
    output
  );
}

export function formatSuiCliFailure({ label, command, packageDir, result }) {
  const category = classifySuiCliFailure(result);
  return [
    label,
    `Category: ${category}`,
    command ? `Command: ${command.join(" ")}` : undefined,
    packageDir ? `Package: ${packageDir}` : undefined,
    result?.error?.message,
    result?.stderr?.trim(),
    result?.stdout?.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function prepareParityWorktree(suiBuildConfig, parityWorkDir) {
  await ensureSuiSourceCheckout(suiBuildConfig);
  const resolvedCommit = await resolveSuiSourceCommit(suiBuildConfig);
  const workDir = await prepareSuiWorktree(suiBuildConfig, {
    workDir: parityWorkDir,
    updateSubmodules: true,
  });
  return { resolvedCommit, workDir };
}
