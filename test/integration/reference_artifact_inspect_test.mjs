import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectReferenceArtifact } from "../../scripts/verification/inspect-reference-artifact.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function moduleBase64(version, flavor = 0) {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32LE(0x0b_eb_1c_a1, 0);
  bytes.writeUInt32LE(((flavor & 0xff) << 24) | version, 4);
  return bytes.toString("base64");
}

function invalidMagicModuleBase64() {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32LE(0, 0);
  bytes.writeUInt32LE(6, 4);
  return bytes.toString("base64");
}

function fixture(modules) {
  return {
    modules,
    dependencies: ["0x1", "0x2"],
    packageId: "0xabc",
    txDigest: "digest",
    network: "mainnet",
    sourceGit: "https://github.com/example/repo.git",
    sourceRev: "0123456789abcdef0123456789abcdef01234567",
    sourceSubdir: "packages/example",
  };
}

const v6 = inspectReferenceArtifact(fixture([moduleBase64(6)]));
if (v6.bytecode.decodedVersion !== 6 || v6.bytecode.flavor !== null) {
  throw new Error(`Expected v6 with no flavor, got ${JSON.stringify(v6)}`);
}

const v7 = inspectReferenceArtifact(fixture([moduleBase64(7, 5)]));
if (v7.bytecode.decodedVersion !== 7 || v7.bytecode.flavor !== 5) {
  throw new Error(`Expected v7 flavor 5, got ${JSON.stringify(v7)}`);
}

const v7FlavorZero = inspectReferenceArtifact(fixture([moduleBase64(7, 0)]));
if (
  v7FlavorZero.bytecode.decodedVersion !== 7 ||
  v7FlavorZero.bytecode.flavor !== 0
) {
  throw new Error(
    `Expected v7 flavor 0 to stay observable, got ${JSON.stringify(
      v7FlavorZero
    )}`
  );
}

const transactionArtifactShape = inspectReferenceArtifact({
  source: "grpc",
  digest: "transaction-digest",
  status: "success",
  kind: "upgrade",
  modules: [moduleBase64(6)],
  dependencies: ["0x1"],
  packageId: "0xabc",
});
if (
  transactionArtifactShape.artifact.txDigest !== "transaction-digest" ||
  transactionArtifactShape.artifact.intent !== "upgrade" ||
  transactionArtifactShape.artifact.dependencyCount !== 1
) {
  throw new Error(
    `Expected transaction artifact aliases to be accepted, got ${JSON.stringify(
      transactionArtifactShape
    )}`
  );
}

const nestedRootGitShape = inspectReferenceArtifact({
  reference: {
    modules: [moduleBase64(7, 5)],
    rootGit: {
      git: "https://github.com/example/repo.git",
      rev: "0123456789abcdef0123456789abcdef01234567",
      subdir: "packages/example",
    },
  },
  txDigest: "digest",
  network: "mainnet",
  intent: "publish",
});
if (
  nestedRootGitShape.artifact.rootGit.git !==
    "https://github.com/example/repo.git" ||
  nestedRootGitShape.artifact.rootGit.rev !==
    "0123456789abcdef0123456789abcdef01234567" ||
  nestedRootGitShape.artifact.dependencyCount !== 0
) {
  throw new Error(
    `Expected nested rootGit and optional dependencies, got ${JSON.stringify(
      nestedRootGitShape
    )}`
  );
}

const v6WithFlavor = inspectReferenceArtifact({
  modules: [moduleBase64(6, 1)],
});
if (!v6WithFlavor.warnings?.[0]?.includes("high byte")) {
  throw new Error(
    `Expected v6 non-zero high-byte warning, got ${JSON.stringify(v6WithFlavor)}`
  );
}

try {
  inspectReferenceArtifact(fixture([moduleBase64(6), moduleBase64(7, 5)]));
  throw new Error("Mixed decoded bytecode versions should be rejected");
} catch (error) {
  if (
    !String(error?.message ?? error).includes("one decoded bytecode version")
  ) {
    throw error;
  }
}

try {
  inspectReferenceArtifact(fixture([invalidMagicModuleBase64()]));
  throw new Error("Invalid Move bytecode magic should be rejected");
} catch (error) {
  if (!String(error?.message ?? error).includes("Move bytecode magic")) {
    throw error;
  }
}

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "sui-move-builder-reference-artifact-")
);
const artifactPath = path.join(tempDir, "artifact.json");
await fs.writeFile(
  artifactPath,
  JSON.stringify({ reference: fixture([moduleBase64(6)]) })
);
const cli = spawnSync(
  process.execPath,
  [
    "scripts/verification/inspect-reference-artifact.mjs",
    "--artifact",
    artifactPath,
  ],
  { cwd: repoRoot, encoding: "utf8" }
);
if (cli.status !== 0) {
  throw new Error(`inspect-reference-artifact CLI failed: ${cli.stderr}`);
}
const parsed = JSON.parse(cli.stdout);
if (parsed.bytecode.decodedVersion !== 6 || parsed.artifact.moduleCount !== 1) {
  throw new Error(`Unexpected CLI inspection: ${cli.stdout}`);
}

const warningArtifactPath = path.join(tempDir, "warning-artifact.json");
await fs.writeFile(
  warningArtifactPath,
  JSON.stringify({ modules: [moduleBase64(6, 1)] })
);
const warningCli = spawnSync(
  process.execPath,
  [
    "scripts/verification/inspect-reference-artifact.mjs",
    "--artifact",
    warningArtifactPath,
    "--fail-on-warning",
  ],
  { cwd: repoRoot, encoding: "utf8" }
);
if (warningCli.status === 0) {
  throw new Error("--fail-on-warning should reject warning-bearing artifacts");
}
if (
  !warningCli.stderr.includes(
    "Reference artifact inspection failed (warnings as errors)"
  )
) {
  throw new Error(
    `Expected warning rejection message, got stderr: ${warningCli.stderr}`
  );
}

console.log("[OK] reference artifact inspection checks passed");
