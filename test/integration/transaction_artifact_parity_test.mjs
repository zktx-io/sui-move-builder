import { promises as fs } from "node:fs";
import path from "node:path";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  compareBuildOutputs,
  compareModuleBytecode,
  normalizeOutput,
  writeJsonArtifact,
} from "./artifact_parity_helpers.mjs";
import {
  readGithubToken,
  writeGitHubSourceSnapshot,
} from "./github_artifact_helpers.mjs";
import {
  assertSuiCliVersion,
  createVerificationAuditContext,
  readMovePackageFiles,
  repoRoot,
  toArtifactPackageName,
} from "./parity_helpers.mjs";
import { runSuiCliReferenceArtifact } from "./sui_cli_artifact_helpers.mjs";
import {
  compareCliReferenceWithVerificationCurrent,
  verificationStatusGate,
  verifyReferenceProvenance,
} from "./verification_audit_helpers.mjs";

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

const fixtures = [
  {
    name: "nautilus",
    network: "mainnet",
    git: "https://github.com/MystenLabs/nautilus.git",
    commit: "d919402aadf15e21b3cf31515b3a46d1ca6965e4",
    packagePath: "move/enclave",
    txDigest: "B2eHopwUuSgMhJNHQA6LNMkQYVKesPe6M6MorbiwiaGX",
    expectedKind: "publish",
    expectedStatus: "build_failure",
    expectedVerdict: "unverified",
    expectedFailureStage: "compile",
    verifierSource: {
      sourceDir: ".sui-build/bytecode-verifiers/sui-1.26.2/source",
      tag: "mainnet-v1.26.2",
      commit: "f531168c745260b60a4ec4906c9f2b22240d872d",
    },
  },
  {
    name: "apps-kiosk",
    network: "mainnet",
    git: "https://github.com/MystenLabs/apps.git",
    commit: "e159ab3fc45a6f1ca46025c46c915988023af8b6",
    packagePath: "kiosk",
    txDigest: "LexwBJLt1jMwhNsNCkU4jiWwZPaAeqwhgLy2RPZbd2n",
    expectedKind: "upgrade",
    expectedStatus: "verified",
    expectedVerdict: "exact_bytecode_match",
    verifierSource: {
      sourceDir: ".sui-build/bytecode-verifiers/sui-1.26.2/source",
      tag: "mainnet-v1.26.2",
      commit: "f531168c745260b60a4ec4906c9f2b22240d872d",
    },
  },
];

class LocalSuiSourceFetcher {
  constructor({ sourceDir, tag, commit }) {
    this.sourceDir = path.resolve(repoRoot, sourceDir);
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
      rev === "framework/mainnet" ||
      rev === "framework/testnet" ||
      rev === this.tag ||
      rev === this.commit ||
      (typeof rev === "string" && this.commit.startsWith(rev))
    );
  }

  async fetch(gitUrl, rev, subdir = "") {
    if (!this.isSuiRepo(gitUrl)) {
      throw new Error(
        `Unexpected git dependency for verifier source: ${gitUrl}`
      );
    }
    if (!this.acceptsRev(rev)) {
      throw new Error(
        `Unexpected Sui dependency revision ${rev}; expected framework/mainnet, framework/testnet, ${this.tag}, or ${this.commit}`
      );
    }
    return readMovePackageFiles(path.join(this.sourceDir, subdir));
  }

  async fetchLocal(localPath, context) {
    const parent = context?.parentSource;
    if (parent?.type !== "git" || !this.isSuiRepo(parent.git)) {
      throw new Error(
        `Unexpected local dependency parent for verifier source: ${JSON.stringify(
          parent
        )}`
      );
    }
    if (!this.acceptsRev(parent.rev)) {
      throw new Error(
        `Unexpected Sui local dependency revision ${parent.rev}; expected framework/mainnet, framework/testnet, ${this.tag}, or ${this.commit}`
      );
    }

    const parentSubdir = parent.subdir || "";
    const resolved = path.resolve(this.sourceDir, parentSubdir, localPath);
    if (
      resolved !== this.sourceDir &&
      !resolved.startsWith(`${this.sourceDir}${path.sep}`)
    ) {
      throw new Error(`Local dependency escaped verifier source: ${localPath}`);
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

const { suiVersion, mode, suiCli, parityOutputDir } =
  createVerificationAuditContext(
    process.argv.slice(2),
    "parity-transaction-artifact-output"
  );

async function fetchTransactionArtifact(fixture) {
  const urls = networkUrls[fixture.network];
  if (!urls) {
    throw new Error(
      `Unsupported transaction fixture network: ${fixture.network}`
    );
  }

  try {
    const grpcClient = new SuiGrpcClient({
      network: fixture.network,
      baseUrl: urls.grpc,
    });
    const transaction = await grpcClient.getTransaction({
      digest: fixture.txDigest,
      include: { transaction: true, effects: true, bcs: true },
    });
    return extractTransactionArtifact(
      unwrapSuccessfulTransaction(transaction, fixture.txDigest),
      "grpc"
    );
  } catch (grpcError) {
    const graphqlClient = new SuiGraphQLClient({
      network: fixture.network,
      url: urls.graphql,
    });
    const transaction = await graphqlClient.getTransaction({
      digest: fixture.txDigest,
      include: { transaction: true, effects: true, bcs: true },
    });
    return {
      ...extractTransactionArtifact(
        unwrapSuccessfulTransaction(transaction, fixture.txDigest),
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

async function main() {
  console.log(
    `Running transaction artifact provenance audit in [${mode.toUpperCase()}] mode`
  );
  assertSuiCliVersion(suiCli, suiVersion.version);

  const token = await readGithubToken();
  let failed = false;

  for (const fixture of fixtures) {
    const artifactPackageName = toArtifactPackageName(fixture.name);
    const outputRoot = path.join(parityOutputDir, artifactPackageName);
    const sourceRoot = path.join(outputRoot, "source");
    const packageDir = path.join(sourceRoot, fixture.packagePath);
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

      const transactionArtifact = await fetchTransactionArtifact(fixture);
      if (transactionArtifact.kind !== fixture.expectedKind) {
        throw new Error(
          `${fixture.name}: expected ${fixture.expectedKind} transaction, got ${transactionArtifact.kind}`
        );
      }
      await writeJsonArtifact(
        outputRoot,
        "transaction.json",
        transactionArtifact
      );

      const hasUpgradeCliInput =
        transactionArtifact.kind === "upgrade" && fixture.upgradeCapability;
      const cliReference =
        transactionArtifact.kind === "publish" || hasUpgradeCliInput
          ? await runSuiCliReferenceArtifact({
              suiCli,
              packageDir,
              outputRoot,
              fixtureName: fixture.name,
              intent: transactionArtifact.kind,
              environment: fixture.network,
              upgradeCapability: fixture.upgradeCapability,
              sender: fixture.sender,
              gasBudget: fixture.gasBudget,
              gasPrice: fixture.gasPrice,
              gas: fixture.gas,
              skipVerifyCompatibility: fixture.skipVerifyCompatibility,
              skipDependencyVerification: fixture.skipDependencyVerification,
            })
          : undefined;
      if (cliReference) {
        await writeJsonArtifact(outputRoot, "cli.json", cliReference.output);
        await writeJsonArtifact(outputRoot, "cli-output.json", {
          kind: cliReference.kind,
          intent: cliReference.intent,
          ...cliReference.cliResult,
        });
      } else {
        await writeJsonArtifact(outputRoot, "cli-reference-skipped.json", {
          kind: transactionArtifact.kind,
          reason:
            "Sui CLI upgrade .mv artifacts require user-provided upgradeCapability and transaction context; verification does not use dump output as an upgrade reference.",
        });
      }

      const files = await readMovePackageFiles(packageDir);
      const txOutput = {
        modules: transactionArtifact.modules,
        dependencies: transactionArtifact.dependencies,
      };
      const reference = {
        ...txOutput,
      };
      const verification = await verifyReferenceProvenance({
        files,
        intent: transactionArtifact.kind,
        network: fixture.network,
        fetcher: fixture.verifierSource
          ? new LocalSuiSourceFetcher(fixture.verifierSource)
          : undefined,
        githubToken: token,
        rootGit: {
          git: fixture.git,
          rev: fixture.commit,
          subdir: fixture.packagePath,
        },
        reference,
      });
      await writeJsonArtifact(outputRoot, "verification.json", verification);
      const verificationGate = verificationStatusGate(fixture, verification);
      const expectsVerifierFailure =
        fixture.expectedStatus === "build_failure" ||
        fixture.expectedStatus === "invalid_reference";
      const cliVsVerification = expectsVerifierFailure
        ? {
            ok: true,
            skipped: true,
            reason:
              "Fixture records a verifier failure state; no currentBuild comparison is expected.",
          }
        : cliReference
          ? compareCliReferenceWithVerificationCurrent(
              cliReference,
              verification
            )
          : {
              ok: true,
              skipped: true,
              reason:
                "Upgrade transaction verification compares the extracted transaction modules against the verifier's upgrade-intent currentBuild; no dump reference is used.",
            };
      const verificationCurrentBuild = verification.currentBuild
        ? normalizeOutput(verification.currentBuild)
        : undefined;
      if (verificationCurrentBuild) {
        await writeJsonArtifact(
          outputRoot,
          "verification-current-build.json",
          verificationCurrentBuild
        );
      }

      const txVsCli = cliReference
        ? compareModuleBytecode(
            "transaction",
            txOutput,
            "cli",
            cliReference.output
          )
        : { ok: true, skipped: true, differences: [] };
      const txVsVerification = verificationCurrentBuild
        ? compareModuleBytecode(
            "transaction",
            txOutput,
            "verification",
            verificationCurrentBuild
          )
        : expectsVerifierFailure
          ? {
              ok: true,
              skipped: true,
              differences: [],
            }
          : {
              ok: false,
              differences: ["verification result has no currentBuild"],
            };
      const compareDependencyOutputs = transactionArtifact.kind === "upgrade";
      const txVsVerificationOutput =
        compareDependencyOutputs && verificationCurrentBuild
          ? compareBuildOutputs(
              "transaction",
              txOutput,
              "verification",
              verificationCurrentBuild
            )
          : [];
      const txVsCliOutput =
        compareDependencyOutputs &&
        cliReference?.output.dependencies &&
        cliReference?.output.digest
          ? compareBuildOutputs(
              "transaction",
              txOutput,
              "CLI",
              cliReference.output
            )
          : [];
      const currentLabel =
        transactionArtifact.kind === "upgrade"
          ? "verification"
          : cliReference
            ? "cli"
            : "verification";
      const transactionMatchesVerification =
        txVsVerification.ok && txVsVerificationOutput.length === 0;
      const transactionMatchesCli = txVsCli.ok && txVsCliOutput.length === 0;
      const currentBuildPresent = Boolean(verificationCurrentBuild);
      const currentBuildGate =
        expectsVerifierFailure || transactionArtifact.kind !== "upgrade"
          ? true
          : currentBuildPresent;
      const comparison = {
        ok: verificationGate.ok && cliVsVerification.ok && currentBuildGate,
        transactionMatchesCurrent:
          transactionArtifact.kind === "upgrade"
            ? transactionMatchesVerification
            : transactionMatchesCli,
        transactionMatchesCli,
        transactionMatchesVerification,
        transactionCurrentArtifact: currentLabel,
        verificationGate,
        transactionVsCli: txVsCli,
        transactionVsVerification: txVsVerification,
        cliVsVerification,
        verification,
        transactionVsCliOutput: txVsCliOutput,
        transactionVsVerificationOutput: txVsVerificationOutput,
      };
      await writeJsonArtifact(outputRoot, "comparison.json", comparison);

      if (!comparison.ok) {
        failed = true;
        console.error(`[Mismatch] ${JSON.stringify(comparison, null, 2)}`);
      } else if (!comparison.transactionMatchesCurrent) {
        console.log(
          `[DIFF] transaction modules differ from current build output; see ${path.join(outputRoot, "comparison.json")}`
        );
      } else {
        const moduleCount =
          verification.currentBuild?.modules?.length ??
          cliReference?.output?.modules?.length ??
          transactionArtifact.modules.length;
        console.log(
          `[OK] kind=${transactionArtifact.kind}, status=${verification.status}, modules=${moduleCount}`
        );
      }
    } catch (error) {
      failed = true;
      console.error(error instanceof Error ? error.message : error);
    }
  }

  if (failed) {
    throw new Error(
      `Transaction artifact provenance audit failed. See ${parityOutputDir}`
    );
  }
  console.log("\nTransaction artifact provenance audit passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
