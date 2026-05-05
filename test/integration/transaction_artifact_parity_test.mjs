import { promises as fs } from "node:fs";
import path from "node:path";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  compareBuildOutputs,
  compareModuleBytecode,
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
    expectedStatus: "toolchain_mismatch",
  },
  {
    name: "apps-kiosk",
    network: "mainnet",
    git: "https://github.com/MystenLabs/apps.git",
    commit: "e159ab3fc45a6f1ca46025c46c915988023af8b6",
    packagePath: "kiosk",
    txDigest: "LexwBJLt1jMwhNsNCkU4jiWwZPaAeqwhgLy2RPZbd2n",
    expectedKind: "upgrade",
    expectedStatus: "toolchain_mismatch",
  },
];

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

      const cliReference = await runSuiCliReferenceArtifact({
        suiCli,
        packageDir,
        outputRoot,
        fixtureName: fixture.name,
        intent: transactionArtifact.kind,
        environment: fixture.network,
      });
      await writeJsonArtifact(outputRoot, "cli.json", cliReference.output);
      if (cliReference.cliResult) {
        await writeJsonArtifact(outputRoot, "cli-output.json", {
          kind: cliReference.kind,
          intent: cliReference.intent,
          ...cliReference.cliResult,
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
      const cliVsVerification = compareCliReferenceWithVerificationCurrent(
        cliReference,
        verification
      );
      if (cliVsVerification.currentBuild) {
        await writeJsonArtifact(
          outputRoot,
          "verification-current-build.json",
          cliVsVerification.currentBuild
        );
      }

      const compareDependencyOutputs = transactionArtifact.kind === "upgrade";
      const txVsCli = compareModuleBytecode(
        "transaction",
        txOutput,
        "cli",
        cliReference.output
      );
      const txVsCliOutput = compareDependencyOutputs
        ? compareBuildOutputs(
            "transaction",
            txOutput,
            "CLI",
            cliReference.output
          )
        : [];
      const comparison = {
        ok: verificationGate.ok && cliVsVerification.ok,
        transactionMatchesCurrent: txVsCli.ok && txVsCliOutput.length === 0,
        verificationGate,
        transactionVsCli: txVsCli,
        cliVsVerification,
        verification,
        transactionVsCliOutput: txVsCliOutput,
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
        console.log(
          `[OK] kind=${transactionArtifact.kind}, status=${verification.status}, modules=${cliReference.output.modules.length}`
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
