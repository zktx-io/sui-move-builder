import { promises as fs } from "node:fs";
import path from "node:path";

import { dirExists, run, runCapture } from "./sui-workspace.mjs";
import {
  assertPreparedWorkspace,
  createWasmBuildContext,
} from "./wasm/context.mjs";

const VALID_PROFILES = new Set(["lite", "full", "all"]);

async function readCargoLockPackageVersion(lockPath, packageName) {
  const content = await fs.readFile(lockPath, "utf8");
  const sections = content.split("[[package]]");

  for (const section of sections) {
    const nameMatch = section.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameMatch?.[1] !== packageName) continue;

    const versionMatch = section.match(/^\s*version\s*=\s*"([^"]+)"/m);
    if (versionMatch?.[1]) {
      return versionMatch[1];
    }
  }

  throw new Error(`Could not find ${packageName} in ${lockPath}`);
}

async function getInstalledWasmBindgenVersion(wasmBindgenCmd) {
  if (!(await dirExists(wasmBindgenCmd))) {
    return undefined;
  }

  try {
    const { stdout } = await runCapture(wasmBindgenCmd, ["--version"]);
    const match = stdout.match(/wasm-bindgen\s+([^\s]+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function parseProfileArgs(args) {
  let profile = "all";
  const unknownArgs = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--profile") {
      profile = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else {
      unknownArgs.push(arg);
    }
  }

  if (unknownArgs.length > 0) {
    throw new Error(`Unknown build arguments: ${unknownArgs.join(" ")}`);
  }
  if (!VALID_PROFILES.has(profile)) {
    throw new Error(`Invalid profile '${profile}'. Use lite, full, or all.`);
  }

  return profile;
}

async function requirePreparedWasmBindgen(context) {
  const requiredVersion = await readCargoLockPackageVersion(
    path.join(context.suiWorkDir, "Cargo.lock"),
    "wasm-bindgen"
  );
  const wasmBindgenCmd = path.join(context.localBinDir, "bin", "wasm-bindgen");
  const installedVersion = await getInstalledWasmBindgenVersion(wasmBindgenCmd);

  if (installedVersion !== requiredVersion) {
    throw new Error(
      installedVersion
        ? `Prepared wasm-bindgen is v${installedVersion}, expected v${requiredVersion}. Run npm run prepare:wasm.`
        : `Missing prepared wasm-bindgen v${requiredVersion} at ${wasmBindgenCmd}. Run npm run prepare:wasm.`
    );
  }

  return wasmBindgenCmd;
}

function selectProfiles(profileName, distDir) {
  const profiles = [
    { name: "lite", features: [], outDir: path.join(distDir, "lite") },
    {
      name: "full",
      features: ["testing"],
      outDir: path.join(distDir, "full"),
    },
  ];

  if (profileName === "all") return profiles;
  return profiles.filter((profile) => profile.name === profileName);
}

async function cleanProfileOutputs(context, profileName, profiles) {
  if (profileName === "all") {
    await fs.rm(context.distDir, { recursive: true, force: true });
    await fs.mkdir(context.distDir, { recursive: true });
    return;
  }

  await fs.mkdir(context.distDir, { recursive: true });
  for (const profile of profiles) {
    await fs.rm(profile.outDir, { recursive: true, force: true });
    await fs.mkdir(profile.outDir, { recursive: true });
  }
}

async function optimizeFullWasm(profile) {
  if (profile.name !== "full") return;

  if (process.env.SUI_WASM_SKIP_WASM_OPT === "1") {
    console.log(
      "Skipping full WASM post-processing because SUI_WASM_SKIP_WASM_OPT=1."
    );
    return;
  }

  const wasmOptCmd = process.env.WASM_OPT || "wasm-opt";
  try {
    await runCapture(wasmOptCmd, ["--version"]);
  } catch {
    throw new Error(
      `Full WASM post-processing requires '${wasmOptCmd}' from Binaryen. Install wasm-opt, set WASM_OPT to its path, or set SUI_WASM_SKIP_WASM_OPT=1 to build without size post-processing.`
    );
  }

  const wasmPath = path.join(profile.outDir, "sui_move_wasm_bg.wasm");
  const optimizedPath = `${wasmPath}.opt`;
  const before = (await fs.stat(wasmPath)).size;

  console.log("Post-processing full WASM with wasm-opt strip passes...");
  try {
    await run(
      wasmOptCmd,
      [
        "--strip-debug",
        "--strip-producers",
        "--enable-bulk-memory",
        wasmPath,
        "-o",
        optimizedPath,
      ],
      { cwd: profile.outDir }
    );
    await fs.rename(optimizedPath, wasmPath);
  } finally {
    await fs.rm(optimizedPath, { force: true });
  }

  const after = (await fs.stat(wasmPath)).size;
  const saved = before - after;
  console.log(
    `Full WASM post-processing reduced raw size by ${saved} bytes (${before} -> ${after}).`
  );
}

async function main() {
  try {
    const context = createWasmBuildContext();
    const profileName = parseProfileArgs(context.restArgs);
    await assertPreparedWorkspace(context);

    const crateDir = path.join(context.suiWorkDir, "crates", "sui-move-wasm");
    const profiles = selectProfiles(profileName, context.distDir);
    await cleanProfileOutputs(context, profileName, profiles);

    console.log("Building prepared wasm (cargo build)...");

    const suiVersion = context.suiVersion.version;
    const suiMoveVersion = "2024.beta";
    const baseRustflags =
      (process.env.RUSTFLAGS || "") +
      ' --cfg getrandom_backend="wasm_js" -C link-arg=-zstack-size=33554432';

    const releaseEnv = {
      ...process.env,
      CARGO_PROFILE_RELEASE_LTO: "false",
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
      CARGO_PROFILE_RELEASE_OPT_LEVEL: "1",
      CARGO_PROFILE_RELEASE_DEBUG: "true",
      ZSTD_SYS_ASM_CODE: "0",
      RUSTFLAGS: baseRustflags,
      SUI_VERSION: suiVersion,
      SUI_MOVE_VERSION: suiMoveVersion,
    };

    const liteEnv = {
      ...releaseEnv,
      CARGO_PROFILE_RELEASE_OPT_LEVEL: "z",
      CARGO_PROFILE_RELEASE_LTO: "true",
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
      CARGO_PROFILE_RELEASE_PANIC: "abort",
      CARGO_PROFILE_RELEASE_STRIP: "true",
    };

    const fullEnv = {
      ...releaseEnv,
      CARGO_PROFILE_RELEASE_OPT_LEVEL: "z",
      CARGO_PROFILE_RELEASE_LTO: "true",
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
      CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
    };

    const wasmBindgenCmd = await requirePreparedWasmBindgen(context);

    for (const profile of profiles) {
      console.log(
        `\nBuilding '${profile.name}' WASM (Features: ${
          profile.features.join(", ") || "none"
        })...`
      );

      const buildArgs = [
        "build",
        "--lib",
        "--release",
        "--target",
        "wasm32-unknown-unknown",
      ];
      if (process.env.SUI_WASM_STRICT_OFFLINE === "1") {
        buildArgs.push("--offline");
      }
      if (profile.features.length > 0) {
        buildArgs.push("--features", profile.features.join(","));
      } else {
        buildArgs.push("--no-default-features");
      }

      const env = profile.name === "lite" ? liteEnv : fullEnv;
      await run("cargo", buildArgs, { cwd: crateDir, env });

      console.log(`Linking '${profile.name}' with wasm-bindgen...`);
      const wasmArtifact = path.join(
        context.suiWorkDir,
        "target",
        "wasm32-unknown-unknown",
        "release",
        "sui_move_wasm.wasm"
      );

      await run(
        wasmBindgenCmd,
        [
          wasmArtifact,
          "--out-dir",
          profile.outDir,
          "--target",
          "web",
          "--typescript",
        ],
        { cwd: context.repoRoot }
      );

      console.log(`Patching generated JS bindings for '${profile.name}'...`);
      const jsPath = path.join(profile.outDir, "sui_move_wasm.js");
      let jsContent = await fs.readFile(jsPath, "utf-8");

      const envImportMatch = jsContent.match(
        /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]env['"];?/
      );
      if (envImportMatch) {
        const envBindingName = envImportMatch[1];
        jsContent = jsContent.replace(
          envImportMatch[0],
          `const ${envBindingName} = {
      now: () => Date.now() / 1000,
  }; // patched wasm-bindgen env import`
        );
        await fs.writeFile(jsPath, jsContent);
        console.log(
          `Patched 'env' import and added 'now' polyfill for ${profile.name}.`
        );
      }

      await optimizeFullWasm(profile);
    }

    console.log("\nBuild successful! Artifacts in dist/");
  } catch (error) {
    console.error("Build failed:", error.message);
    process.exit(1);
  }
}

main();
