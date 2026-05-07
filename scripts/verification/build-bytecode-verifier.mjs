import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  defaultCompatDir,
  getBytecodeVerifierEntry,
  getBytecodeVerifierRoute,
  getRepoRoot,
  isolatedVerifierRoot,
} from "./bytecode-verifier-manifest.mjs";
import { loadBytecodeVersionSourceRecords } from "./bytecode-version-source-records.mjs";

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

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceRecordForVerifier(repoRoot, entry) {
  const { sourceRecords, sourceRecordsPath } =
    loadBytecodeVersionSourceRecords(repoRoot);
  const record = sourceRecords.records.find(
    (candidate) => candidate.verifierId === entry.verifierId
  );
  if (!record) {
    throw new Error(
      `${entry.verifierId} must have a source record in ${sourceRecordsPath}`
    );
  }
  return { record, sourceRecordsPath };
}

async function verifySourceFingerprints(repoRoot, entry, root) {
  const { record, sourceRecordsPath } = sourceRecordForVerifier(
    repoRoot,
    entry
  );
  const hashes = record.representativeSourceHashes;
  if (!hashes || Object.keys(hashes).length === 0) {
    throw new Error(
      `${entry.verifierId} source record in ${sourceRecordsPath} has no representativeSourceHashes`
    );
  }

  const sourceDir = path.join(root, "source");
  for (const [group, expected] of Object.entries(hashes)) {
    const sourceFile = expected.sourceFile;
    const expectedSha256 = expected.sha256;
    const actualPath = path.join(sourceDir, sourceFile);
    const actualSha256 = await sha256File(actualPath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        [
          `${entry.verifierId} source fingerprint mismatch for ${group}`,
          `  file: ${sourceFile}`,
          `  expected: ${expectedSha256}`,
          `  actual:   ${actualSha256}`,
          `Regenerate bytecode version inventory/source records before building this verifier.`,
        ].join("\n")
      );
    }
  }

  console.log(
    `[OK] ${entry.verifierId} source fingerprints match ${sourceRecordsPath}`
  );
}

function shouldBuildJs(options) {
  return options.build && options.profile === "verification";
}

function tsupCommand(repoRoot) {
  return path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsup.cmd" : "tsup"
  );
}

function buildVerificationJs(repoRoot, root) {
  const outDir = path.join(root, "dist", "verification");
  run(tsupCommand(repoRoot), ["--out-dir", outDir], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SUI_MOVE_BUILDER_ENTRY: "src/verification.ts",
    },
  });
}

async function syncBundledVerificationDist(repoRoot, entry, root) {
  const routeInfo = getBytecodeVerifierRoute(entry.verifierId, repoRoot);
  if (!routeInfo) {
    console.log(
      `[INFO] ${entry.verifierId} has no bundled bytecode version route; leaving artifacts under ${path.join(root, "dist")}`
    );
    return;
  }

  const sourceDir = path.join(root, "dist", "verification");
  const targetDir = path.join(repoRoot, routeInfo.route.distPath);
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  if (entry.status === "current") {
    await fs.cp(sourceDir, targetDir, { recursive: true });
  } else {
    await fs.mkdir(targetDir, { recursive: true });
    for (const fileName of [
      "sui_move_wasm.js",
      "sui_move_wasm.d.ts",
      "sui_move_wasm_bg.wasm",
      "sui_move_wasm_bg.wasm.d.ts",
    ]) {
      await fs.copyFile(
        path.join(sourceDir, fileName),
        path.join(targetDir, fileName)
      );
    }
  }
  console.log(
    `[OK] ${entry.verifierId} bundled verifier copied to ${routeInfo.route.distPath}`
  );
}

async function syncIsolatedVerificationRoute(repoRoot, entry, root) {
  const routeInfo = getBytecodeVerifierRoute(entry.verifierId, repoRoot);
  if (!routeInfo || entry.status === "current") {
    return;
  }

  const sourceDir = path.join(root, "dist", "verification");
  const routeRelative = path.relative(
    path.join(repoRoot, "dist", "verification"),
    path.join(repoRoot, routeInfo.route.distPath)
  );
  const targetDir = path.join(sourceDir, routeRelative);

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  for (const fileName of [
    "sui_move_wasm.js",
    "sui_move_wasm.d.ts",
    "sui_move_wasm_bg.wasm",
    "sui_move_wasm_bg.wasm.d.ts",
  ]) {
    await fs.copyFile(
      path.join(sourceDir, fileName),
      path.join(targetDir, fileName)
    );
  }
  console.log(
    `[OK] ${entry.verifierId} isolated verifier route copied to ${path.relative(
      repoRoot,
      targetDir
    )}`
  );
}

function ensureRustTarget(entry, repoRoot, env) {
  if (!entry.rustVersion) return;
  run(
    "rustup",
    [`+${entry.rustVersion}`, "target", "add", "wasm32-unknown-unknown"],
    {
      cwd: repoRoot,
      env,
    }
  );
}

async function chooseCompatDir(repoRoot, entry, env = process.env) {
  const verifierId = entry.verifierId;
  if (env.SUI_COMPAT_DIR) {
    const explicit = path.resolve(repoRoot, env.SUI_COMPAT_DIR);
    try {
      await fs.access(path.join(explicit, "manifest.json"));
    } catch {
      throw new Error(
        `${verifierId} SUI_COMPAT_DIR must contain manifest.json: ${explicit}`
      );
    }
    console.log(
      `[INFO] ${verifierId} using explicit compat overlay ${explicit}`
    );
    return explicit;
  }

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
  const compatDir = await chooseCompatDir(repoRoot, entry, process.env);
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
    ...(entry.rustVersion ? { SUI_WASM_RUST_VERSION: entry.rustVersion } : {}),
    ...(entry.wasmBindgenVersion
      ? { SUI_WASM_BINDGEN_VERSION: entry.wasmBindgenVersion }
      : {}),
    ...(entry.reqwestVersion
      ? { SUI_WASM_REQWEST_VERSION: entry.reqwestVersion }
      : {}),
    ...(entry.fastcryptoRev
      ? { SUI_WASM_FASTCRYPTO_REV: entry.fastcryptoRev }
      : {}),
    ...(entry.dependencyVersionPins
      ? {
          SUI_WASM_DEPENDENCY_VERSION_PINS: JSON.stringify(
            entry.dependencyVersionPins
          ),
        }
      : {}),
    ...(entry.sourceVariantPath
      ? { SUI_WASM_SOURCE_VARIANT_PATH: entry.sourceVariantPath }
      : {}),
  };

  if (options.prepare) {
    run(process.execPath, ["scripts/prepare-wasm.mjs"], {
      cwd: repoRoot,
      env,
    });
  }
  if (options.build) {
    await verifySourceFingerprints(repoRoot, entry, root);
    ensureRustTarget(entry, repoRoot, env);
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
  if (shouldBuildJs(options)) {
    buildVerificationJs(repoRoot, root);
    await syncIsolatedVerificationRoute(repoRoot, entry, root);
    await syncBundledVerificationDist(repoRoot, entry, root);
  }

  console.log(
    `[OK] ${options.verifier} ${options.profile} artifacts are under ${path.join(root, "dist")}`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
