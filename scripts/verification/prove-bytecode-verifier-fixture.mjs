#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inspectReferenceArtifact } from "./inspect-reference-artifact.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const fixtures = {
  "apps-kiosk": {
    name: "apps-kiosk",
    network: "mainnet",
    git: "https://github.com/MystenLabs/apps.git",
    rev: "e159ab3fc45a6f1ca46025c46c915988023af8b6",
    subdir: "kiosk",
    txDigest: "LexwBJLt1jMwhNsNCkU4jiWwZPaAeqwhgLy2RPZbd2n",
    cachedAuditDir:
      ".sui-build/parity-transaction-artifact-output/verification/apps-kiosk",
  },
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      throw new Error(`Unexpected argument: ${value}`);
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
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

      if (
        !entry.name.endsWith(".move") &&
        !entry.name.endsWith(".toml") &&
        !entry.name.endsWith(".lock")
      ) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      files[relativePath] = await fs.readFile(fullPath, "utf8");
    }
  }

  await visit(packageDir, packageDir);
  return files;
}

class LocalSuiSourceFetcher {
  constructor({ sourceDir, commit, tag }) {
    this.sourceDir = sourceDir;
    this.commit = commit;
    this.tag = tag;
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
      rev === "framework/mainnet" ||
      rev === this.tag ||
      rev === this.commit ||
      (typeof rev === "string" && this.commit?.startsWith(rev))
    );
  }

  async fetch(gitUrl, rev, subdir = "") {
    if (!this.isSuiRepo(gitUrl)) {
      throw new Error(`Unexpected git dependency in verifier proof: ${gitUrl}`);
    }
    if (!this.acceptsRev(rev)) {
      throw new Error(
        `Unexpected Sui revision in verifier proof: ${rev}. Expected framework/mainnet, ${this.tag}, or ${this.commit}`
      );
    }
    return readMovePackageFiles(path.join(this.sourceDir, subdir));
  }

  async fetchLocal(localPath, context) {
    const parent = context?.parentSource;
    if (parent?.type !== "git" || !this.isSuiRepo(parent.git)) {
      throw new Error(
        `Unexpected local dependency parent in verifier proof: ${JSON.stringify(
          parent
        )}`
      );
    }
    if (!this.acceptsRev(parent.rev)) {
      throw new Error(
        `Unexpected Sui local dependency parent revision in verifier proof: ${parent.rev}`
      );
    }

    const parentSubdir = parent.subdir || "";
    const resolved = path.resolve(this.sourceDir, parentSubdir, localPath);
    const sourceRoot = path.resolve(this.sourceDir);
    if (
      resolved !== sourceRoot &&
      !resolved.startsWith(`${sourceRoot}${path.sep}`)
    ) {
      throw new Error(
        `Local dependency escaped verifier source directory: ${localPath}`
      );
    }
    return readMovePackageFiles(resolved);
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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function loadVerifier(distDir) {
  const wasmPath = path.join(distDir, "sui_move_wasm_bg.wasm");
  const jsPath = path.join(distDir, "index.js");
  if (!(await pathExists(wasmPath))) {
    throw new Error(`Missing verifier WASM: ${wasmPath}`);
  }
  if (!(await pathExists(jsPath))) {
    throw new Error(`Missing verifier JS entry: ${jsPath}`);
  }
  const mod = await import(pathToFileURL(jsPath).href);
  const wasm = await fs.readFile(wasmPath);
  await mod.initMovePackageVerifier({ wasm });
  return { mod, wasmPath, jsPath };
}

function verificationOnlySurface(mod) {
  const forbidden = [
    "buildMovePackage",
    "dumpMovePackage",
    "testMovePackage",
    "updateMovePackagePublication",
  ];
  return {
    exports: Object.keys(mod).sort(),
    forbiddenExportsPresent: forbidden.filter((name) => name in mod),
  };
}

function summarize(result) {
  return {
    status: result.status,
    verdict: result.verdict,
    summary: result.summary,
    failureStage: result.failureStage,
    error: result.error,
    currentModuleCount: result.currentBuild?.modules?.length,
    referenceModuleCount: result.referenceSummary?.moduleCount,
    bytecodeDiffCount: result.bytecodeDiffs?.length ?? 0,
    differences: result.differences,
  };
}

function assertExpected(args, result, surface, referenceInspection) {
  const errors = [];
  if (referenceInspection.warnings.length > 0) {
    errors.push(
      `reference artifact inspection failed (warnings as errors): ${referenceInspection.warnings.join("; ")}`
    );
  }
  if (args["expect-status"] && result.status !== args["expect-status"]) {
    errors.push(
      `expected status ${args["expect-status"]}, got ${result.status}`
    );
  }
  if (args["expect-verdict"] && result.verdict !== args["expect-verdict"]) {
    errors.push(
      `expected verdict ${args["expect-verdict"]}, got ${result.verdict}`
    );
  }
  if (
    args["expect-sui-version"] &&
    result.suiVersion !== args["expect-sui-version"]
  ) {
    errors.push(
      `expected verifier Sui version ${args["expect-sui-version"]}, got ${result.suiVersion}`
    );
  }
  if (surface.forbiddenExportsPresent.length > 0) {
    errors.push(
      `verification-only surface exposed forbidden exports: ${surface.forbiddenExportsPresent.join(", ")}`
    );
  }
  return errors;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixtureName = args.fixture || "apps-kiosk";
  const fixture = fixtures[fixtureName];
  if (!fixture) {
    throw new Error(`Unknown fixture: ${fixtureName}`);
  }
  if (!args["verifier-id"]) {
    throw new Error("--verifier-id is required");
  }
  if (!args["dist-dir"]) {
    throw new Error("--dist-dir is required");
  }
  if (!args["sui-source-dir"]) {
    throw new Error("--sui-source-dir is required");
  }
  if (!args["sui-source-commit"]) {
    throw new Error("--sui-source-commit is required");
  }

  const auditDir = path.resolve(repoRoot, fixture.cachedAuditDir);
  const packageDir = path.join(auditDir, "source", fixture.subdir);
  const transactionPath = path.join(auditDir, "transaction.json");
  if (!(await pathExists(packageDir)) || !(await pathExists(transactionPath))) {
    throw new Error(
      `Missing cached ${fixture.name} audit source/transaction under ${auditDir}. Run the transaction verification audit first.`
    );
  }

  const distDir = path.resolve(repoRoot, args["dist-dir"]);
  const suiSourceDir = path.resolve(repoRoot, args["sui-source-dir"]);
  const transaction = await readJson(transactionPath);
  const referenceInspection = inspectReferenceArtifact(transaction);
  const files = await readMovePackageFiles(packageDir);
  const { mod, wasmPath, jsPath } = await loadVerifier(distDir);
  const surface = verificationOnlySurface(mod);
  const suiVersion = await mod.getPinnedSuiVersion();

  const result = await mod.verifyMovePackageProvenance({
    files,
    intent: transaction.kind,
    network: fixture.network,
    fetcher: new LocalSuiSourceFetcher({
      sourceDir: suiSourceDir,
      commit: args["sui-source-commit"],
      tag: args["sui-source-tag"],
    }),
    rootGit: {
      git: fixture.git,
      rev: fixture.rev,
      subdir: fixture.subdir,
    },
    reference: {
      modules: transaction.modules,
      dependencies: transaction.dependencies,
      packageId: transaction.packageId,
      cliVersion: args["reference-cli-version"],
    },
    silenceWarnings: true,
  });

  const proof = {
    fixture: {
      name: fixture.name,
      network: fixture.network,
      txDigest: fixture.txDigest,
      intent: transaction.kind,
      rootGit: {
        git: fixture.git,
        rev: fixture.rev,
        subdir: fixture.subdir,
      },
    },
    verifier: {
      id: args["verifier-id"],
      distDir,
      wasmPath,
      jsPath,
      suiVersion,
      surface,
    },
    dependencySource: {
      sourceDir: suiSourceDir,
      commit: args["sui-source-commit"],
      tag: args["sui-source-tag"],
    },
    referenceInspection,
    result: summarize(result),
    fullResult: result,
  };

  const errors = assertExpected(
    { ...args, "expect-sui-version": args["expect-sui-version"] },
    { ...result, suiVersion },
    surface,
    referenceInspection
  );
  proof.ok = errors.length === 0;
  proof.errors = errors;

  if (args.out) {
    const outputPath = path.resolve(repoRoot, args.out);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(
      `${outputPath}.tmp`,
      `${JSON.stringify(proof, null, 2)}\n`
    );
    await fs.rename(`${outputPath}.tmp`, outputPath);
  }

  console.log(JSON.stringify(proof, null, 2));
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
