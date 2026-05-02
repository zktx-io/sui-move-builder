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

export async function deletePatchState(context) {
  await fs.rm(context.patchStatePath, { force: true });
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
  const tempPath = `${context.patchStatePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2) + "\n");
  await fs.rename(tempPath, context.patchStatePath);
  return state;
}

function recoveryHint() {
  return "Run npm run prepare:wasm.";
}

function normalizeStatePath(value) {
  return value ? path.resolve(value) : undefined;
}

async function assertPathExists(requiredPath, label) {
  if (!(await dirExists(requiredPath))) {
    throw new Error(
      `Prepared WASM workspace is missing ${label} at ${requiredPath}. ${recoveryHint()}`
    );
  }
}

export async function assertPreparedWorkspace(context) {
  if (!(await dirExists(context.patchStatePath))) {
    throw new Error(
      `Missing patch state ${context.patchStatePath}. ${recoveryHint()}`
    );
  }

  const state = await readPatchState(context);
  if (state.version !== 1) {
    throw new Error(
      `Unsupported patch state version ${state.version ?? "undefined"} in ${context.patchStatePath}. ${recoveryHint()}`
    );
  }

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
        `Prepared WASM workspace was created for ${key}=${actual[key] ?? "undefined"}, expected ${expectedValue ?? "undefined"}. ${recoveryHint()}`
      );
    }
  }

  const expectedPaths = {
    sourceDir: context.suiBuildConfig.sourceDir,
    workDir: context.suiWorkDir,
    generatedDir: context.generatedDir,
    stubsDir: context.generatedStubsDir,
    vendorDir: context.generatedVendorDir,
    localBinDir: context.localBinDir,
    crateDir: path.join(context.suiWorkDir, "crates", "sui-move-wasm"),
  };

  for (const [key, expectedPath] of Object.entries(expectedPaths)) {
    const actualPath = normalizeStatePath(state.paths?.[key]);
    const normalizedExpected = path.resolve(expectedPath);
    if (actualPath !== normalizedExpected) {
      throw new Error(
        `Prepared WASM workspace path mismatch for paths.${key}: ${actualPath ?? "undefined"}; expected ${normalizedExpected}. ${recoveryHint()}`
      );
    }
  }

  const requiredPaths = [
    {
      label: "work Cargo.toml",
      path: path.join(context.suiWorkDir, "Cargo.toml"),
    },
    {
      label: "work Cargo.lock",
      path: path.join(context.suiWorkDir, "Cargo.lock"),
    },
    {
      label: "sui-move-wasm Cargo.toml",
      path: path.join(
        context.suiWorkDir,
        "crates",
        "sui-move-wasm",
        "Cargo.toml"
      ),
    },
    { label: "generated directory", path: context.generatedDir },
    { label: "generated stubs directory", path: context.generatedStubsDir },
    { label: "generated vendor directory", path: context.generatedVendorDir },
    { label: "local tool directory", path: context.localBinDir },
  ];

  for (const required of requiredPaths) {
    await assertPathExists(required.path, required.label);
  }

  return state;
}
