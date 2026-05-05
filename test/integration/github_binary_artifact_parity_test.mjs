import { promises as fs } from "node:fs";
import path from "node:path";
import {
  compareModuleBytecode,
  modulesToOutput,
  writeJsonArtifact,
} from "./artifact_parity_helpers.mjs";
import {
  fetchGitHubBinaryModules,
  readGithubToken,
  writeGitHubSourceSnapshot,
} from "./github_artifact_helpers.mjs";
import {
  SUI_REPO_URL,
  LocalSuiFetcher,
  assertSuiCliVersion,
  createVerificationAuditContext,
  ensureSuiSourceCheckout,
  readMovePackageFiles,
  toArtifactPackageName,
} from "./parity_helpers.mjs";
import { runSuiCliReferenceArtifact } from "./sui_cli_artifact_helpers.mjs";
import {
  compareCliReferenceWithVerificationCurrent,
  verificationStatusGate,
  verifyReferenceProvenance,
} from "./verification_audit_helpers.mjs";

const { suiVersion, mode, network, suiCli, suiBuildConfig, parityOutputDir } =
  createVerificationAuditContext(
    process.argv.slice(2),
    "parity-github-binary-artifact-output"
  );

const fixtures = [
  {
    name: "sui-package-publish-bytecode-a",
    git: SUI_REPO_URL,
    commit: suiVersion.commit,
    packagePath:
      "crates/sui-single-node-benchmark/tests/data/package_publish_from_bytecode/package_a",
    binaryArtifactPath:
      "crates/sui-single-node-benchmark/tests/data/package_publish_from_bytecode/package_a/build/a/bytecode_modules",
    intent: "publish",
    expectedStatus: "toolchain_mismatch",
    expectedVerdict: "format_drift",
  },
];

async function main() {
  console.log(
    `Running GitHub binary artifact provenance audit in [${mode.toUpperCase()}] mode`
  );
  assertSuiCliVersion(suiCli, suiVersion.version);

  const token = await readGithubToken();
  await ensureSuiSourceCheckout(suiBuildConfig);
  const fetcher = new LocalSuiFetcher({
    sourceDir: suiBuildConfig.sourceDir,
    tag: suiVersion.tag,
    commit: suiVersion.commit,
  });
  let failed = false;

  for (const fixture of fixtures) {
    const intent = fixture.intent ?? "dump";
    if (!["dump", "publish", "upgrade"].includes(intent)) {
      throw new Error(
        `${fixture.name}: unsupported binary artifact intent ${intent}`
      );
    }

    const artifactPackageName = toArtifactPackageName(fixture.name);
    const outputRoot = path.join(parityOutputDir, artifactPackageName);
    const sourceRoot = path.join(outputRoot, "source");
    const packageDir = path.join(sourceRoot, fixture.packagePath);
    const environment = fixture.network || network;
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

      const githubOutput = modulesToOutput(
        await fetchGitHubBinaryModules({
          git: fixture.git,
          commit: fixture.commit,
          binaryArtifactPath: fixture.binaryArtifactPath,
          token,
        })
      );
      await writeJsonArtifact(outputRoot, "github-binary.json", githubOutput);

      const cliReference = await runSuiCliReferenceArtifact({
        suiCli,
        packageDir,
        outputRoot,
        fixtureName: fixture.name,
        intent,
        environment,
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
      const reference = {
        modules: githubOutput.modules,
      };

      const verification = await verifyReferenceProvenance({
        files,
        intent,
        network: environment,
        fetcher,
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

      const githubVsCli = compareModuleBytecode(
        "github",
        githubOutput,
        "CLI",
        cliReference.output
      );
      const githubVsVerification = cliVsVerification.currentBuild
        ? compareModuleBytecode(
            "github",
            githubOutput,
            "verification",
            cliVsVerification.currentBuild
          )
        : {
            ok: false,
            differences: ["verification result has no currentBuild"],
          };
      const comparison = {
        ok: verificationGate.ok && cliVsVerification.ok,
        verification,
        verificationGate,
        intent,
        githubVsCli,
        githubVsVerification,
        cliVsVerification,
      };
      await writeJsonArtifact(outputRoot, "comparison.json", comparison);

      if (!comparison.ok) {
        failed = true;
        console.error(`[Mismatch] ${JSON.stringify(comparison, null, 2)}`);
      } else if (!githubVsCli.ok || !githubVsVerification.ok) {
        console.log(
          `[DIFF] committed modules differ from current build output; see ${path.join(outputRoot, "comparison.json")}`
        );
      } else {
        console.log(
          `[OK] status=${verification.status}, modules=${githubOutput.moduleCount}`
        );
      }
    } catch (error) {
      failed = true;
      console.error(error instanceof Error ? error.message : error);
    }
  }

  if (failed) {
    throw new Error(
      `GitHub binary artifact provenance audit failed. See ${parityOutputDir}`
    );
  }
  console.log("\nGitHub binary artifact provenance audit passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
