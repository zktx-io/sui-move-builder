import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  defaultCompatDir,
  getBytecodeVerifierEntry,
  getRepoRoot,
  isolatedVerifierRoot,
} from "./bytecode-verifier-manifest.mjs";

function parseArgs(argv) {
  const options = {
    profile: "verification",
    prepare: true,
    build: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verifier") {
      options.verifier = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--verifier=")) {
      options.verifier = arg.slice("--verifier=".length);
    } else if (arg === "--profile") {
      options.profile = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--profile=")) {
      options.profile = arg.slice("--profile=".length);
    } else if (arg === "--prepare-only") {
      options.prepare = true;
      options.build = false;
    } else if (arg === "--build-only") {
      options.prepare = false;
      options.build = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.verifier) {
    throw new Error("--verifier is required");
  }
  if (!["lite", "full", "verification"].includes(options.profile)) {
    throw new Error("--profile must be lite, full, or verification");
  }
  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`
    );
  }
}

async function chooseCompatDir(repoRoot, entry) {
  const verifierId = entry.verifierId;
  const versioned = defaultCompatDir(repoRoot, verifierId);
  try {
    await fs.access(path.join(versioned, "manifest.json"));
    return versioned;
  } catch {
    const fallback = path.join(repoRoot, "scripts", "compat");
    if (entry.status === "legacy") {
      console.warn(
        `[WARN] ${verifierId} does not have scripts/compat/bytecode-verifiers/${verifierId}/manifest.json; using the current compat overlay at ${fallback}. ` +
          "Legacy bytecode verifiers usually need a verifier-specific compat manifest before prepare/build errors are actionable."
      );
    }
    return fallback;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = getRepoRoot();
  const entry = getBytecodeVerifierEntry(options.verifier, repoRoot);
  const root = isolatedVerifierRoot(repoRoot, options.verifier);
  const compatDir = await chooseCompatDir(repoRoot, entry);
  const env = {
    ...process.env,
    SUI_VERSION: entry.suiVersion,
    SUI_TAG: entry.tag,
    SUI_COMMIT: entry.commit,
    SUI_BUILD_WORKSPACE_DIR: root,
    SUI_SOURCE_DIR: path.join(root, "source"),
    SUI_WORK_DIR: path.join(root, "work"),
    SUI_DIST_DIR: path.join(root, "dist"),
    SUI_COMPAT_DIR: compatDir,
  };

  if (options.prepare) {
    run(process.execPath, ["scripts/prepare-wasm.mjs"], {
      cwd: repoRoot,
      env,
    });
  }
  if (options.build) {
    run(
      process.execPath,
      ["scripts/build-prepared-wasm.mjs", "--profile", options.profile],
      {
        cwd: repoRoot,
        env,
      }
    );
  }

  console.log(
    `[OK] ${options.verifier} ${options.profile} artifacts are under ${path.join(root, "dist")}`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
