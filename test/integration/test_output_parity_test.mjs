import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  assertSuiCliVersion,
  formatSuiCliFailure,
  resolveSuiCli,
} from "./parity_helpers.mjs";
import { resolvedTestDependencies } from "./test_fixture_helpers.mjs";

const { initMovePackageBuilder, testMovePackage } = await import(
  new URL("../../dist/full/index.js", import.meta.url)
);

const require = createRequire(import.meta.url);
const suiVersion = require("../../sui-version.json");
const suiCli = resolveSuiCli(process.env.SUI_CLI || "sui");

assertSuiCliVersion(suiCli, suiVersion.version);
await initMovePackageBuilder();

async function writePackage(files) {
  const packageDir = await mkdtemp(path.join(tmpdir(), "sui-test-output-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(packageDir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return packageDir;
}

function cliArgs(packageDir) {
  return ["move", "test", "--path", packageDir, "--silence-warnings"];
}

function stripAnsi(text) {
  return stripVTControlCharacters(text);
}

function normalizeOutput(text) {
  return stripAnsi(text)
    .replace(/\r\n?/g, "\n")
    .replace(/(^|[ \t])\.\/(?=(sources|tests|examples|scripts)\/)/gm, "$1")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trimEnd();
}

function runnerOutput(stdout) {
  const normalized = normalizeOutput(stdout);
  const marker = "Running Move unit tests";
  const start = normalized.indexOf(marker);
  if (start < 0) {
    throw new Error(
      `CLI output is missing unit-test runner output:\n${stdout}`
    );
  }
  return normalized.slice(start);
}

function expectCliStatus(result, expectPassed, label, packageDir) {
  if (result.error || (expectPassed && result.status !== 0)) {
    throw new Error(
      formatSuiCliFailure({
        label: `${label}: CLI test failed`,
        command: [suiCli, ...cliArgs(packageDir)],
        packageDir,
        result,
      })
    );
  }
  if (!expectPassed && result.status === 0) {
    throw new Error(`${label}: CLI test should fail`);
  }
}

async function runWasm(files) {
  return testMovePackage({
    files,
    network: "mainnet",
    ansiColor: false,
    resolvedDependencies: resolvedTestDependencies(files),
  });
}

async function assertOutputParity({ label, files, expectPassed }) {
  const packageDir = await writePackage(files);
  const cliResult = spawnSync(suiCli, cliArgs(packageDir), {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });
  expectCliStatus(cliResult, expectPassed, label, packageDir);

  const wasmResult = await runWasm(files);
  if ("error" in wasmResult) {
    throw new Error(`${label}: WASM test failed to run: ${wasmResult.error}`);
  }
  if (wasmResult.passed !== expectPassed) {
    throw new Error(
      `${label}: expected WASM passed=${expectPassed}, got ${wasmResult.passed}\n${wasmResult.output}`
    );
  }

  const cliOutput = runnerOutput(cliResult.stdout);
  const wasmOutput = normalizeOutput(wasmResult.output);
  if (cliOutput !== wasmOutput) {
    throw new Error(
      `${label}: CLI and WASM test output differ\n--- CLI ---\n${cliOutput}\n--- WASM ---\n${wasmOutput}`
    );
  }
}

const passFiles = {
  "Move.toml": `
[package]
name = "Root"
version = "0.0.0"
edition = "2024"

[addresses]
root = "0x0"
`,
  "sources/main.move": `
module root::main {
    #[test]
    public fun pass_test() {}
}
`,
};

const failureFiles = {
  "Move.toml": passFiles["Move.toml"],
  "sources/main.move": `
module root::main {
    #[test]
    public fun fail_test() {
        assert!(false, 7);
    }
}
`,
};

await assertOutputParity({
  label: "passing test output",
  files: passFiles,
  expectPassed: true,
});

await assertOutputParity({
  label: "failing test output",
  files: failureFiles,
  expectPassed: false,
});

console.log("[OK] unit test output matches CLI unit-test runner output");
