#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";

import { loadBytecodeVerifierManifest } from "./bytecode-verifier-manifest.mjs";
import { inspectReferenceArtifact } from "./inspect-reference-artifact.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const networkUrls = {
  mainnet: {
    grpc: "https://fullnode.mainnet.sui.io:443",
    graphql: "https://graphql.mainnet.sui.io/graphql",
  },
  testnet: {
    grpc: "https://fullnode.testnet.sui.io:443",
    graphql: "https://graphql.testnet.sui.io/graphql",
  },
  devnet: {
    grpc: "https://fullnode.devnet.sui.io:443",
    graphql: "https://graphql.devnet.sui.io/graphql",
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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readGithubToken() {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }
  try {
    return (
      await fs.readFile(path.join(repoRoot, "test/.github_token"), "utf8")
    ).trim();
  } catch {
    return undefined;
  }
}

function parseGitHubUrl(gitUrl) {
  const url = new URL(gitUrl);
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (url.hostname.toLowerCase() !== "github.com" || parts.length < 2) {
    throw new Error(`Expected GitHub URL, got ${gitUrl}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function githubHeaders(token) {
  const headers = { accept: "application/vnd.github+json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchGitHubTree({ git, commit, token }) {
  const { owner, repo } = parseGitHubUrl(git);
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`;
  const response = await fetch(treeUrl, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch GitHub tree ${owner}/${repo}@${commit}: ${response.status} ${response.statusText}`
    );
  }
  const body = await response.json();
  if (body.truncated === true) {
    throw new Error(
      `GitHub tree response is truncated for ${owner}/${repo}@${commit}; verifier proof requires a complete tree`
    );
  }
  if (!Array.isArray(body.tree)) {
    throw new Error(
      `GitHub tree response has no tree array for ${owner}/${repo}@${commit}`
    );
  }
  return { owner, repo, tree: body.tree };
}

function isIncludedMovePackageFile(repoPath) {
  const fileName = path.posix.basename(repoPath);
  return (
    repoPath.endsWith(".move") ||
    fileName === "Move.toml" ||
    fileName === "Move.lock" ||
    fileName === "Published.toml" ||
    /^Move\.[^.\\/]+\.toml$/.test(fileName)
  );
}

async function fetchGitHubRawText({ owner, repo, commit, repoPath, token }) {
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${repoPath}`;
  const response = await fetch(rawUrl, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch GitHub raw file ${owner}/${repo}@${commit}:${repoPath}: ${response.status} ${response.statusText}`
    );
  }
  return Buffer.from(await response.arrayBuffer()).toString("utf8");
}

async function writeGitHubSourceSnapshot({
  git,
  commit,
  packagePath,
  outputDir,
  token,
}) {
  const { owner, repo, tree } = await fetchGitHubTree({ git, commit, token });
  const normalizedPackagePath = packagePath?.replace(/\/+$/, "");
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  for (const item of tree) {
    if (
      item.type !== "blob" ||
      !isIncludedMovePackageFile(item.path) ||
      (normalizedPackagePath &&
        item.path !== normalizedPackagePath &&
        !item.path.startsWith(`${normalizedPackagePath}/`))
    ) {
      continue;
    }
    const content = await fetchGitHubRawText({
      owner,
      repo,
      commit,
      repoPath: item.path,
      token,
    });
    const target = path.join(outputDir, item.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

async function fetchTransactionArtifact({ network, txDigest }) {
  const urls = networkUrls[network];
  if (!urls) {
    throw new Error(`Unsupported fixture network: ${network}`);
  }

  try {
    const grpcClient = new SuiGrpcClient({
      network,
      baseUrl: urls.grpc,
    });
    const transaction = await grpcClient.getTransaction({
      digest: txDigest,
      include: { transaction: true, effects: true, bcs: true },
    });
    return extractTransactionArtifact(
      unwrapSuccessfulTransaction(transaction, txDigest),
      "grpc"
    );
  } catch (grpcError) {
    const graphqlClient = new SuiGraphQLClient({
      network,
      url: urls.graphql,
    });
    const transaction = await graphqlClient.getTransaction({
      digest: txDigest,
      include: { transaction: true, effects: true, bcs: true },
    });
    return {
      ...extractTransactionArtifact(
        unwrapSuccessfulTransaction(transaction, txDigest),
        "graphql"
      ),
      grpcError:
        grpcError instanceof Error ? grpcError.message : String(grpcError),
    };
  }
}

function unwrapSuccessfulTransaction(result, digest) {
  if (result?.$kind === "Transaction" && result.Transaction) {
    return result.Transaction;
  }
  if (result?.$kind === "FailedTransaction" && result.FailedTransaction) {
    throw new Error(`Transaction ${digest} did not execute successfully`);
  }
  if (result?.digest) {
    return result;
  }
  throw new Error(`Transaction ${digest} response has no transaction payload`);
}

function extractTransactionArtifact(transaction, source) {
  const data =
    transaction.transaction ||
    (transaction.bcs ? Transaction.from(transaction.bcs).getData() : undefined);
  if (!data?.commands) {
    throw new Error(`Transaction ${transaction.digest} has no parsed commands`);
  }
  const artifactCommands = [];
  for (const command of data.commands) {
    if (command.Publish) {
      artifactCommands.push({
        kind: "publish",
        modules: normalizeTransactionModules(command.Publish.modules),
        dependencies: command.Publish.dependencies,
        packageId: extractPublishedPackageId(transaction),
      });
    }
    if (command.Upgrade) {
      artifactCommands.push({
        kind: "upgrade",
        modules: normalizeTransactionModules(command.Upgrade.modules),
        dependencies: command.Upgrade.dependencies,
        packageId: command.Upgrade.package,
      });
    }
  }
  if (artifactCommands.length !== 1) {
    throw new Error(
      `Expected exactly one publish/upgrade command in ${transaction.digest}, found ${artifactCommands.length}`
    );
  }
  const command = artifactCommands[0];
  return {
    source,
    digest: transaction.digest,
    status: transaction.status,
    kind: command.kind,
    modules: command.modules,
    dependencies: command.dependencies.map((dep) => String(dep).toLowerCase()),
    packageId: command.packageId,
  };
}

function extractPublishedPackageId(transaction) {
  const packageWrites = (transaction.effects?.changedObjects || []).filter(
    (change) =>
      change?.outputState === "PackageWrite" &&
      change?.idOperation === "Created"
  );
  if (packageWrites.length === 0) {
    return undefined;
  }
  if (packageWrites.length !== 1) {
    throw new Error(
      `Expected exactly one published package object in ${transaction.digest}, found ${packageWrites.length}`
    );
  }
  return String(packageWrites[0].objectId).toLowerCase();
}

function normalizeTransactionModules(modules) {
  return modules.map((module) => {
    if (typeof module === "string") {
      return module;
    }
    return Buffer.from(module).toString("base64");
  });
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
  return { mod, wasm, wasmPath, jsPath };
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
    displayMessage: result.displayMessage,
    failureStage: result.failureStage,
    error: result.error,
    selectedVerifier: result.selectedVerifier,
    referenceBytecode: result.referenceBytecode,
    sourceCompatibility: result.sourceCompatibility,
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
  const selectedVerifier = result.selectedVerifier;
  const actualSuiVersion = selectedVerifier?.suiVersion ?? result.suiVersion;
  if (
    args["expect-verifier-id"] &&
    selectedVerifier?.verifierId !== args["expect-verifier-id"]
  ) {
    errors.push(
      `expected selected verifier ${args["expect-verifier-id"]}, got ${selectedVerifier?.verifierId}`
    );
  }
  if (
    args["expect-sui-version"] &&
    actualSuiVersion !== args["expect-sui-version"]
  ) {
    errors.push(
      `expected selected verifier Sui version ${args["expect-sui-version"]}, got ${actualSuiVersion}`
    );
  }
  if (surface.forbiddenExportsPresent.length > 0) {
    errors.push(
      `verification-only surface exposed forbidden exports: ${surface.forbiddenExportsPresent.join(", ")}`
    );
  }
  return errors;
}

function verifierFixture(entry, fixtureName) {
  return entry.knownFixtures?.find((fixture) => fixture.name === fixtureName);
}

function fixtureRecords(manifest, fixtureName) {
  return Object.values(manifest.verifiers)
    .map((entry) => ({
      entry,
      fixture: verifierFixture(entry, fixtureName),
    }))
    .filter((record) => record.fixture);
}

function fixtureFromKnownFixture(fixture) {
  const rootGit = fixture.rootGit;
  return {
    name: fixture.name,
    network: fixture.network,
    git: rootGit.git,
    rev: rootGit.rev,
    subdir: rootGit.subdir || "",
    txDigest: fixture.txDigest,
    cachedAuditDir:
      fixture.proofCacheDir ||
      path.join(
        ".sui-build",
        "parity-transaction-artifact-output",
        "verification",
        fixture.name
      ),
  };
}

function fixtureFromArgs(args, fixtureName) {
  if (!args["package-dir"] && !args.transaction) {
    return null;
  }
  const required = [
    "package-dir",
    "transaction",
    "network",
    "git",
    "rev",
    "tx-digest",
  ];
  const missing = required.filter((key) => !args[key]);
  if (missing.length > 0) {
    throw new Error(
      `Explicit fixture '${fixtureName}' is missing required args: ${missing
        .map((key) => `--${key}`)
        .join(", ")}`
    );
  }
  return {
    name: fixtureName,
    network: args.network,
    git: args.git,
    rev: args.rev,
    subdir: args.subdir || "",
    txDigest: args["tx-digest"],
    packageDir: args["package-dir"],
    transactionPath: args.transaction,
  };
}

function proofRunName(fixtureName, verifierId) {
  return `${fixtureName}-${verifierId}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function refreshKnownFixture(fixture, verifierId) {
  const runRoot = path.join(
    repoRoot,
    ".sui-build",
    "bytecode-verifier-proof-runs",
    proofRunName(fixture.name, verifierId)
  );
  const sourceRoot = path.join(runRoot, "source");
  await fs.rm(runRoot, { recursive: true, force: true });
  await fs.mkdir(runRoot, { recursive: true });

  const token = await readGithubToken();
  await writeGitHubSourceSnapshot({
    git: fixture.git,
    commit: fixture.rev,
    packagePath: fixture.subdir,
    outputDir: sourceRoot,
    token,
  });

  const transaction = await fetchTransactionArtifact({
    network: fixture.network,
    txDigest: fixture.txDigest,
  });
  await writeJson(path.join(runRoot, "transaction.json"), transaction);

  return {
    ...fixture,
    cachedAuditDir: runRoot,
  };
}

function resolveFixtureRecord(manifest, fixtureName, verifierId) {
  if (verifierId) {
    const entry = manifest.verifiers[verifierId];
    if (!entry) {
      throw new Error(`Unknown verifier: ${verifierId}`);
    }
    const fixture = verifierFixture(entry, fixtureName);
    if (fixture) {
      return { entry, fixture };
    }
    const records = fixtureRecords(manifest, fixtureName);
    if (records.length === 1) {
      return records[0];
    }
    throw new Error(
      `Fixture '${fixtureName}' is not listed for verifier ${verifierId}`
    );
  }

  const records = fixtureRecords(manifest, fixtureName);
  if (records.length === 1) {
    return records[0];
  }
  if (records.length > 1) {
    throw new Error(
      `Fixture '${fixtureName}' is known by multiple verifiers (${records
        .map((record) => record.entry.verifierId)
        .join(", ")}); pass --verifier-id explicitly`
    );
  }
  throw new Error(
    `Fixture '${fixtureName}' is not listed in bytecode verifier knownFixtures`
  );
}

function inferVerifierId(manifest, fixtureName) {
  const candidates = fixtureRecords(manifest, fixtureName).map(
    (record) => record.entry.verifierId
  );
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    throw new Error(
      `Fixture '${fixtureName}' is known by multiple verifiers (${candidates.join(
        ", "
      )}); pass --verifier-id explicitly`
    );
  }
  throw new Error(
    `--verifier-id is required for unknown fixture ${fixtureName}`
  );
}

function defaultSuiSourceDir(verifierId, entry) {
  if (entry.status === "current") {
    return path.join(".sui-build", "source");
  }
  return path.join(".sui-build", "bytecode-verifiers", verifierId, "source");
}

function defaultDistDir(verifierId, entry) {
  if (entry.status !== "current") {
    return path.join(
      ".sui-build",
      "bytecode-verifiers",
      verifierId,
      "dist",
      "verification"
    );
  }
  return path.dirname(entry.verificationWasmPath);
}

function applyVerifierDefaults(args, fixtureName, manifest, knownFixture) {
  const verifierId =
    args["verifier-id"] || inferVerifierId(manifest, fixtureName);
  const entry = manifest.verifiers[verifierId];
  if (!entry) {
    throw new Error(`Unknown verifier: ${verifierId}`);
  }
  const useLocalSuiSource =
    knownFixture && knownFixture.proofDependencySource !== "github";
  return {
    ...args,
    "verifier-id": verifierId,
    "dist-dir": args["dist-dir"] || defaultDistDir(verifierId, entry),
    "sui-source-dir":
      args["sui-source-dir"] ||
      (useLocalSuiSource ? defaultSuiSourceDir(verifierId, entry) : undefined),
    "sui-source-commit": args["sui-source-commit"] || entry.commit,
    "sui-source-tag": args["sui-source-tag"] || entry.tag,
    "expect-status": args["expect-status"] || knownFixture?.expectedStatus,
    "expect-verdict": args["expect-verdict"] || knownFixture?.expectedVerdict,
    "expect-verifier-id": args["expect-verifier-id"] || verifierId,
    "expect-sui-version": args["expect-sui-version"] || entry.suiVersion,
  };
}

async function main() {
  let args = parseArgs(process.argv.slice(2));
  const fixtureName = args.fixture || "apps-kiosk";
  const { manifest } = loadBytecodeVerifierManifest(repoRoot);
  const explicitFixture = fixtureFromArgs(args, fixtureName);
  const fixtureRecord = explicitFixture
    ? null
    : resolveFixtureRecord(manifest, fixtureName, args["verifier-id"]);
  const knownFixture = fixtureRecord?.fixture;
  args = applyVerifierDefaults(args, fixtureName, manifest, knownFixture);
  if (args["refresh-fixture"] && explicitFixture) {
    throw new Error("--refresh-fixture is only supported for known fixtures");
  }
  const fixture =
    explicitFixture ??
    (args["refresh-fixture"]
      ? await refreshKnownFixture(
          fixtureFromKnownFixture(knownFixture),
          args["verifier-id"]
        )
      : fixtureFromKnownFixture(knownFixture));

  const auditDir = fixture.cachedAuditDir
    ? path.resolve(repoRoot, fixture.cachedAuditDir)
    : null;
  const packageDir = path.resolve(
    repoRoot,
    fixture.packageDir ?? path.join(auditDir, "source", fixture.subdir)
  );
  const transactionPath = path.resolve(
    repoRoot,
    fixture.transactionPath ?? path.join(auditDir, "transaction.json")
  );
  if (!(await pathExists(packageDir)) || !(await pathExists(transactionPath))) {
    throw new Error(
      `Missing ${fixture.name} proof source/transaction. Expected package at ${packageDir} and transaction at ${transactionPath}.`
    );
  }

  const distDir = path.resolve(repoRoot, args["dist-dir"]);
  const suiSourceDir = args["sui-source-dir"]
    ? path.resolve(repoRoot, args["sui-source-dir"])
    : null;
  const transaction = await readJson(transactionPath);
  const referenceInspection = inspectReferenceArtifact(transaction);
  const files = await readMovePackageFiles(packageDir);
  const { mod, wasm, wasmPath, jsPath } = await loadVerifier(distDir);
  const surface = verificationOnlySurface(mod);
  const suiVersion = await mod.getPinnedSuiVersion();
  const verifierEntry = manifest.verifiers[args["verifier-id"]];
  const progressEvents = [];
  const githubToken = await readGithubToken();

  const result = await mod.verifyMovePackageProvenance({
    wasm,
    wasmVerifier: {
      verifierId: args["verifier-id"],
      epochId: verifierEntry.epochId,
      suiVersion: verifierEntry.suiVersion,
      decodedBytecodeVersion: verifierEntry.bytecodeVersion,
      bytecodeFlavor: verifierEntry.bytecodeFlavor,
    },
    files,
    intent: transaction.kind,
    network: fixture.network,
    ...(suiSourceDir
      ? {
          fetcher: new LocalSuiSourceFetcher({
            sourceDir: suiSourceDir,
            commit: args["sui-source-commit"],
            tag: args["sui-source-tag"],
          }),
        }
      : {}),
    rootGit: {
      git: fixture.git,
      rev: fixture.rev,
      subdir: fixture.subdir,
    },
    ...(githubToken ? { githubToken } : {}),
    reference: {
      modules: transaction.modules,
      dependencies: transaction.dependencies,
      packageId: transaction.packageId,
      cliVersion: args["reference-cli-version"],
    },
    silenceWarnings: true,
    onProgress: (event) => {
      progressEvents.push(event);
    },
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
    progressEvents,
    fetchFailures: progressEvents.filter(
      (event) => event.type === "fetch_failed"
    ),
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
