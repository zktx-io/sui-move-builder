import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertSuiCliVersion, resolveSuiCli } from "./parity_helpers.mjs";
import { loadWasmBindings } from "./wasm_helpers.mjs";

const require = createRequire(import.meta.url);
const suiVersion = require("../../sui-version.json");
const suiCli = resolveSuiCli(process.env.SUI_CLI || "sui");
assertSuiCliVersion(suiCli, suiVersion.version);

const wasm = await loadWasmBindings("full");
const workDir = await mkdtemp(path.join(tmpdir(), "sui-move-digest-"));

function moveTomlDigest(moveToml, packageName, environment = "mainnet") {
  return wasm.compute_manifest_digest_from_move_toml(
    moveToml,
    packageName,
    environment
  );
}

function rootManifestDigest(moveLock) {
  const sectionPattern = /\[pinned\.mainnet\.([^\]]+)\]\n([\s\S]*?)(?=\n\[|$)/g;
  for (const match of moveLock.matchAll(sectionPattern)) {
    const body = match[2];
    if (!body.includes("source = { root = true }")) {
      continue;
    }
    const digest = body.match(/manifest_digest = "([A-Fa-f0-9]+)"/)?.[1];
    if (!digest) {
      throw new Error("CLI root Move.lock pin has no manifest_digest");
    }
    return digest.toUpperCase();
  }
  throw new Error("CLI Move.lock has no root pin for mainnet");
}

async function writePackage(packageDir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(packageDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

async function cliRootDigest(packageDir) {
  const result = spawnSync(
    suiCli,
    [
      "move",
      "build",
      "--path",
      packageDir,
      "--build-env",
      "mainnet",
      "--silence-warnings",
    ],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
    }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `sui move build failed for digest fixture\n${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`.trim()
    );
  }
  return rootManifestDigest(
    await readFile(path.join(packageDir, "Move.lock"), "utf8")
  );
}

async function assertCliDigest({ label, packageName, rootDir, rootMoveToml }) {
  const cliDigest = await cliRootDigest(rootDir);
  const wasmDigest = moveTomlDigest(rootMoveToml, packageName);
  if (cliDigest !== wasmDigest) {
    throw new Error(
      `${label}: expected WASM manifest_digest ${wasmDigest} to match CLI ${cliDigest}`
    );
  }
}

const modernDir = path.join(workDir, "modern");
const modernRoot = path.join(modernDir, "root");
const modernRootMoveToml = `
[package]
name = "Root"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[dependencies]
Dep = { local = "../dep-old" }

[dep-replacements.mainnet]
Dep = { local = "../dep-new", rename-from = "ActualDep", override = true, modes = ["custom"], use-environment = "mainnet", published-at = "0x22", original-id = "0x11" }
`;
await writePackage(modernRoot, {
  "Move.toml": modernRootMoveToml,
  "sources/root.move": "module 0x0::root {}",
});
await writePackage(path.join(modernDir, "dep-old"), {
  "Move.toml": `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false
`,
  "sources/dep.move": "module 0x0::dep {}",
});
await writePackage(path.join(modernDir, "dep-new"), {
  "Move.toml": `
[package]
name = "ActualDep"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false
`,
  "sources/actual_dep.move": "module 0x0::actual_dep {}",
});
await assertCliDigest({
  label: "modern dep-replacements digest",
  packageName: "Root",
  rootDir: modernRoot,
  rootMoveToml: modernRootMoveToml,
});

const legacyDir = path.join(workDir, "legacy");
const legacyRoot = path.join(legacyDir, "root");
const legacyRootMoveToml = `
[package]
name = "LegacyRoot"
version = "0.0.0"
implicit-dependencies = false

[addresses]
legacy_root = "0x0"

[dependencies]
regular_dep = { local = "../regular-dep", modes = ["custom"] }

[dev-dependencies]
dev_dep = { local = "../dev-dep" }
`;
await writePackage(legacyRoot, {
  "Move.toml": legacyRootMoveToml,
  "sources/root.move": "module legacy_root::root {}",
});
await writePackage(path.join(legacyDir, "regular-dep"), {
  "Move.toml": `
[package]
name = "RegularDep"
version = "0.0.0"
implicit-dependencies = false

[addresses]
regular_dep = "0x0"
`,
  "sources/regular_dep.move": "module regular_dep::fixture {}",
});
await writePackage(path.join(legacyDir, "dev-dep"), {
  "Move.toml": `
[package]
name = "DevDep"
version = "0.0.0"
implicit-dependencies = false

[addresses]
dev_dep = "0x0"
`,
  "sources/dev_dep.move": "module dev_dep::fixture {}",
});
await assertCliDigest({
  label: "legacy dev-dependencies digest",
  packageName: "LegacyRoot",
  rootDir: legacyRoot,
  rootMoveToml: legacyRootMoveToml,
});

const legacyRegularSystemRoot = path.join(legacyDir, "regular-system-root");
const legacyRegularSystemMoveToml = `
[package]
name = "LegacyRegularSystemRoot"
version = "0.0.0"

[addresses]
legacy_regular_system_root = "0x0"

[dependencies]
Sui = { local = "../sui-framework" }
`;
await writePackage(legacyRegularSystemRoot, {
  "Move.toml": legacyRegularSystemMoveToml,
  "sources/root.move": "module legacy_regular_system_root::root {}",
});
await writePackage(path.join(legacyDir, "sui-framework"), {
  "Move.toml": `
[package]
name = "Sui"
version = "0.0.0"
implicit-dependencies = false

[addresses]
sui = "0x0"
`,
  "sources/sui.move": "module sui::fixture {}",
});
await assertCliDigest({
  label: "legacy regular system dependency digest",
  packageName: "LegacyRegularSystemRoot",
  rootDir: legacyRegularSystemRoot,
  rootMoveToml: legacyRegularSystemMoveToml,
});

const legacyDevSystemRoot = path.join(legacyDir, "dev-system-root");
const legacyDevSystemMoveToml = `
[package]
name = "LegacyDevSystemRoot"
version = "0.0.0"

[addresses]
legacy_dev_system_root = "0x0"

[dev-dependencies]
Sui = { local = "../sui-framework" }
`;
await writePackage(legacyDevSystemRoot, {
  "Move.toml": legacyDevSystemMoveToml,
  "sources/root.move": "module legacy_dev_system_root::root {}",
});
await assertCliDigest({
  label: "legacy dev system dependency digest",
  packageName: "LegacyDevSystemRoot",
  rootDir: legacyDevSystemRoot,
  rootMoveToml: legacyDevSystemMoveToml,
});

console.log("[OK] WASM manifest_digest matches CLI-generated Move.lock digest");
