import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dirExists,
  getSuiBuildConfig,
  resolveSuiVersionConfig,
} from "../sui-workspace.mjs";

const require = createRequire(import.meta.url);

export function getRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function createWasmBuildContext(argv = process.argv.slice(2)) {
  const repoRoot = getRepoRoot();
  const baseSuiVersion = require("../../sui-version.json");
  const buildConfig = require("../build-config.json");
  const { suiVersion, restArgs } = resolveSuiVersionConfig(
    baseSuiVersion,
    argv
  );
  const suiBuildConfig = getSuiBuildConfig(repoRoot, suiVersion);
  const generatedDir = path.join(suiBuildConfig.buildWorkspaceDir, "generated");

  return {
    repoRoot,
    baseSuiVersion,
    buildConfig,
    suiVersion,
    restArgs,
    suiBuildConfig,
    suiWorkDir: suiBuildConfig.workDir,
    localSourceDir: path.join(repoRoot, "sui-move-wasm"),
    templateVersion: suiBuildConfig.templateVersion,
    templatesDir: path.join(
      repoRoot,
      "scripts",
      "templates",
      suiBuildConfig.templateVersion
    ),
    distDir: path.join(repoRoot, "dist"),
    generatedDir,
    generatedStubsDir: path.join(generatedDir, "stubs"),
    generatedVendorDir: path.join(generatedDir, "vendor"),
    localBinDir: path.join(generatedDir, "local-bin"),
    patchStatePath: path.join(
      suiBuildConfig.buildWorkspaceDir,
      "patch-state.json"
    ),
  };
}

export async function readPatchState(context) {
  const raw = await fs.readFile(context.patchStatePath, "utf8");
  return JSON.parse(raw);
}

export async function writePatchState(context, details = {}) {
  const state = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sui: {
      version: context.suiVersion.version,
      tag: context.suiVersion.tag,
      commit: context.suiVersion.commit,
      resolvedCommit: details.resolvedCommit ?? null,
      repo: context.suiBuildConfig.repoUrl,
      templateVersion: context.templateVersion,
    },
    paths: {
      sourceDir: context.suiBuildConfig.sourceDir,
      workDir: context.suiWorkDir,
      generatedDir: context.generatedDir,
      stubsDir: context.generatedStubsDir,
      vendorDir: context.generatedVendorDir,
      localBinDir: context.localBinDir,
      crateDir: path.join(context.suiWorkDir, "crates", "sui-move-wasm"),
    },
    appliedPatchGroups: details.appliedPatchGroups ?? [],
  };

  await fs.mkdir(path.dirname(context.patchStatePath), { recursive: true });
  await fs.writeFile(
    context.patchStatePath,
    JSON.stringify(state, null, 2) + "\n"
  );
  return state;
}

export async function assertPreparedWorkspace(context) {
  if (!(await dirExists(context.patchStatePath))) {
    throw new Error(
      `Missing patch state ${context.patchStatePath}. Run npm run prepare:wasm first.`
    );
  }

  const state = await readPatchState(context);
  const expected = {
    version: context.suiVersion.version,
    tag: context.suiVersion.tag,
    commit: context.suiVersion.commit,
    templateVersion: context.templateVersion,
  };
  const actual = {
    version: state.sui?.version,
    tag: state.sui?.tag,
    commit: state.sui?.commit,
    templateVersion: state.sui?.templateVersion,
  };

  for (const [key, expectedValue] of Object.entries(expected)) {
    if ((expectedValue ?? null) !== (actual[key] ?? null)) {
      throw new Error(
        `Prepared WASM workspace was created for ${key}=${actual[key] ?? "undefined"}, expected ${expectedValue ?? "undefined"}. Run npm run prepare:wasm.`
      );
    }
  }

  const requiredPaths = [
    path.join(context.suiWorkDir, "Cargo.toml"),
    path.join(context.suiWorkDir, "Cargo.lock"),
    path.join(context.suiWorkDir, "crates", "sui-move-wasm", "Cargo.toml"),
    context.generatedStubsDir,
  ];

  for (const requiredPath of requiredPaths) {
    if (!(await dirExists(requiredPath))) {
      throw new Error(
        `Prepared WASM workspace is missing ${requiredPath}. Run npm run prepare:wasm first.`
      );
    }
  }

  return state;
}
