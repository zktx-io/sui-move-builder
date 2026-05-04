import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  compareModuleBytecode,
  modulesToOutput,
  normalizeOutput,
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
  formatSuiCliFailure,
  readMovePackageFiles,
  repoRoot,
  toArtifactPackageName,
} from "./parity_helpers.mjs";
import {
  compareCliWithVerificationCurrent,
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
  },
];

function runSuiCliDumpArtifact(packageDir, label, environment) {
  const command = [
    "move",
    "build",
    "--path",
    packageDir,
    "--dump-bytecode-as-base64",
    "--build-env",
    environment,
  ];
  const result = spawnSync(suiCli, command, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: Number(process.env.SUI_PARITY_CLI_TIMEOUT_MS || 180000),
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      formatSuiCliFailure({
        label,
        command: [suiCli, ...command],
        packageDir,
        result,
      })
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
    if (!fixture.intent) {
      throw new Error(`${fixture.name}: fixture must declare an intent`);
    }
    if (fixture.intent !== "publish") {
      throw new Error(
        `${fixture.name}: unsupported binary artifact intent ${fixture.intent}`
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

      const cliOutput = normalizeOutput(
        runSuiCliDumpArtifact(
          packageDir,
          `Sui CLI current source build failed for ${fixture.name}`,
          environment
        )
      );
      await writeJsonArtifact(outputRoot, "cli.json", cliOutput);

      const files = await readMovePackageFiles(packageDir);
      const reference = {
        modules: githubOutput.modules,
      };

      const verification = await verifyReferenceProvenance({
        files,
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
      const cliVsVerification = compareCliWithVerificationCurrent(
        cliOutput,
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
        cliOutput
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
