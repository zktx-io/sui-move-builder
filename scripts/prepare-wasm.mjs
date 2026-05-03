import { promises as fs } from "node:fs";
import path from "node:path";

import {
  dirExists,
  ensureSuiSourceCheckout,
  prepareSuiWorktree,
  resolveSuiSourceCommit,
  run,
  runCapture,
} from "./sui-workspace.mjs";
import { loadCompatManifest } from "./wasm/compat-manifest.mjs";
import {
  createWasmBuildContext,
  deletePatchState,
  writePatchState,
} from "./wasm/context.mjs";

const context = createWasmBuildContext();
const {
  buildConfig,
  restArgs,
  suiBuildConfig,
  suiWorkDir,
  localSourceDir,
  compatDir,
  generatedStubsDir,
  generatedVendorDir,
  localBinDir,
} = context;

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

async function ensureWasmBindgenCli(localBin, requiredVersion) {
  const wasmBindgenCmd = path.join(localBin, "bin/wasm-bindgen");
  const installedVersion = await getInstalledWasmBindgenVersion(wasmBindgenCmd);

  if (installedVersion === requiredVersion) {
    return wasmBindgenCmd;
  }

  console.log(
    installedVersion
      ? `Installing wasm-bindgen-cli v${requiredVersion} (replacing v${installedVersion})...`
      : `Installing wasm-bindgen-cli v${requiredVersion}...`
  );
  await run(
    "cargo",
    [
      "install",
      "wasm-bindgen-cli",
      "--version",
      requiredVersion,
      "--root",
      localBin,
      "--force",
      "--locked",
    ],
    { env: process.env }
  );

  return wasmBindgenCmd;
}

async function main() {
  try {
    await deletePatchState(context);

    if (restArgs.length > 0) {
      throw new Error(`Unknown build arguments: ${restArgs.join(" ")}`);
    }

    if (!(await dirExists(compatDir))) {
      throw new Error(
        `Missing WASM compatibility overlay: ${compatDir}. ` +
          `Refresh scripts/compat for ${suiBuildConfig.displayRef} before running prepare.`
      );
    }

    const compatManifest = await loadCompatManifest(compatDir);
    const stubTemplates = compatManifest.stubTemplates;
    const offendingCrates = compatManifest.offendingCrates;
    const emptyStubCrates = new Set(compatManifest.emptyStubCrates || []);
    const filePatches = compatManifest.filePatches;

    // 1. Keep a pristine Sui checkout, then create a disposable patched worktree.
    await ensureSuiSourceCheckout(suiBuildConfig);
    await prepareSuiWorktree(suiBuildConfig);

    // 2. Prepare our crate within Sui workspace
    const crateDir = path.join(suiWorkDir, "crates", "sui-move-wasm");
    console.log(`Overlaying sui-move-wasm into ${crateDir}...`);
    await fs.rm(crateDir, { recursive: true, force: true });
    await fs.mkdir(crateDir, { recursive: true });

    // Copy only tracked crate sources; generated/vendor build state is recreated separately.
    const entries = await fs.readdir(localSourceDir);
    for (const entry of entries) {
      if (entry === "vendor" || entry === "target" || entry === "pkg") continue;
      const src = path.join(localSourceDir, entry);
      const dest = path.join(crateDir, entry);
      await fs.cp(src, dest, { recursive: true });
    }

    // 3. Patch Cargo.toml for paths
    console.log("Patching Cargo.toml paths...");
    const cargoTomlPath = path.join(crateDir, "Cargo.toml");
    let cargoContent = await fs.readFile(cargoTomlPath, "utf8");

    // Replace vendor paths with relative paths to .sui root's external-crates
    // From: path = "vendor/move/crates/..."
    // To:   path = "../../external-crates/move/crates/..."
    cargoContent = cargoContent.replace(
      /path = "vendor\/move\//g,
      'path = "../../external-crates/move/'
    );

    // Remove [workspace] sections as it's now part of the Sui workspace
    cargoContent = cargoContent.replace(
      /\[workspace\][\s\S]*?resolver = "2"/g,
      ""
    );
    cargoContent = cargoContent.replace(
      /\[workspace\.dependencies\][\s\S]*?(?=\n\[)/g,
      ""
    );
    cargoContent = cargoContent.replace(
      /path = "crates\//g,
      'path = "../../crates/'
    );
    cargoContent = cargoContent.replace(
      /path = "sui-execution\//g,
      'path = "../../sui-execution/'
    );

    // Note: overrides/ folder is copied into the crate, so we keep its relative paths as is.

    await fs.writeFile(cargoTomlPath, cargoContent);

    // 4. Register in Sui workspace and pin problematic dependencies
    const workspaceTomls = [
      path.join(suiWorkDir, "Cargo.toml"),
      path.join(suiWorkDir, "external-crates", "move", "Cargo.toml"),
    ];

    for (const workspaceToml of workspaceTomls) {
      if (!(await dirExists(workspaceToml))) continue;

      console.log(`Patching workspace at ${workspaceToml}...`);
      let workspaceContent = await fs.readFile(workspaceToml, "utf8");

      if (workspaceToml === path.join(suiWorkDir, "Cargo.toml")) {
        workspaceContent = workspaceContent.replace(
          /"crates\/sui-e2e-tests",/g,
          ""
        );
        workspaceContent = workspaceContent.replace(
          /"crates\/sui-json-rpc-tests",/g,
          ""
        );
      }

      // Patch zstd and zstd-sys to remove default features (ASM)
      workspaceContent = workspaceContent.replace(
        /zstd = "(0\.[0-9.]+)"/g,
        'zstd = { version = "$1", default-features = false, features = ["no_asm"] }'
      );
      workspaceContent = workspaceContent.replace(
        /zstd-safe = "(0\.[0-9.]+)"/g,
        'zstd-safe = { version = "$1", default-features = false, features = ["no_asm"] }'
      );
      workspaceContent = workspaceContent.replace(
        /zstd-sys = "(2\.[0-9.]+)"/g,
        `zstd-sys = { version = "${buildConfig.versions.zstd_sys}", default-features = false, features = ["no_asm"] }`
      );
      // Handle version strings and existing dependency object forms.
      workspaceContent = workspaceContent.replace(
        /zstd-sys = { version = "(2\.[0-9.]+)"/g,
        'zstd-sys = { version = "$1", default-features = false, features = ["no_asm"] }'
      );
      // Ensure tokio time support is available across patched manifests.
      workspaceContent = workspaceContent.replace(
        /tokio = { version = "(1\.[0-9.]+)", features = \[(.*)\] }/g,
        'tokio = { version = "$1", features = [$2, "time"] }'
      );
      workspaceContent = workspaceContent.replace(
        /tokio = "(1\.[0-9.]+)"/g,
        'tokio = { version = "$1", features = ["time"] }'
      );

      if (
        workspaceToml === path.join(suiWorkDir, "Cargo.toml") &&
        !workspaceContent.includes('"crates/sui-move-wasm"')
      ) {
        console.log("Registering crate in Sui root workspace...");
        workspaceContent = workspaceContent.replace(
          "members = [",
          'members = [\n    "crates/sui-move-wasm",'
        );
      }

      // Pin dependencies to avoid pulling incompatible versions (like getrandom 0.3.4)
      workspaceContent = workspaceContent.replace(
        /proptest = "1\.6\.0"/g,
        `proptest = { version = "=${buildConfig.versions.proptest}", default-features = false, features = ["std", "bit-set"] }`
      );
      workspaceContent = workspaceContent.replace(
        /clap = { version = "4", features = \["derive"\] }/g,
        `clap = { version = "${buildConfig.versions.clap}", default-features = false, features = ["derive", "std", "help", "usage", "error-context"] }`
      );
      workspaceContent = workspaceContent.replace(
        /rand = "0\.8\.[0-9]"/g,
        `rand = "=${buildConfig.versions.rand}"`
      );
      workspaceContent = workspaceContent.replace(
        /fastcrypto = { git = "https:\/\/github\.com\/MystenLabs\/fastcrypto", rev = "4db0e90c732bbf7420ca20de808b698883148d9c" }/g,
        `fastcrypto = { git = "https://github.com/MystenLabs/fastcrypto", rev = "${buildConfig.versions.fastcrypto.rev}", default-features = false }`
      );
      workspaceContent = workspaceContent.replace(
        /sui-crypto = { git = "https:\/\/github\.com\/MystenLabs\/sui-rust-sdk\.git", rev = "339c2272fd5b8fb4e1fa6662cfa9acdbb0d05704", features = \[ "ed25519", "secp256r1", "secp256k1", "passkey", "zklogin" \] }/g,
        `sui-crypto = { git = "https://github.com/MystenLabs/sui-rust-sdk.git", rev = "${buildConfig.versions.sui_crypto.rev}", features = [ "ed25519", "secp256r1", "passkey", "zklogin" ] }`
      );
      workspaceContent = workspaceContent.replace(
        /insta = { version = "1\.[0-9.]+"/g,
        (match) =>
          match.includes("1.21.1")
            ? `insta = { version = "=${buildConfig.versions.insta.version_1_21}"`
            : `insta = { version = "=${buildConfig.versions.insta.default}"`
      );
      workspaceContent = workspaceContent.replace(
        /tempfile = "=3\.[0-9.]+"/g,
        `tempfile = { version = "${buildConfig.versions.tempfile}", default-features = false }`
      );
      // Handle non-pinned tempfile version strings.
      workspaceContent = workspaceContent.replace(
        /tempfile = "3\.[0-9.]+"/g,
        `tempfile = { version = "${buildConfig.versions.tempfile}", default-features = false }`
      );

      workspaceContent = workspaceContent.replace(
        /tokio = "=1\.47\.1"/g,
        `tokio = { version = "=${buildConfig.versions.tokio}", default-features = false, features = ["sync", "macros", "rt", "io-util"] }`
      );

      // 4. Patch workspace roots: Restore [patch.crates-io] and unified workspace dependencies
      workspaceContent = workspaceContent.replace(
        /\[patch\.crates-io\][\s\S]*?(?=\n\[|$)/g,
        ""
      );

      // Define vendor paths early
      const fcCommit = buildConfig.versions.fastcrypto.rev;
      const vendorDir = generatedVendorDir;
      const fcDir = path.join(vendorDir, "fastcrypto");
      const secpDir = path.join(vendorDir, "rust-secp256k1");

      const patchHeader = "[patch.crates-io]";
      const patches = [
        `blst = { path = "${path.join(generatedStubsDir, "blst-wasm-stub")}" }`,
        `rayon = { path = "${path.join(generatedStubsDir, "rayon-stub")}" }`,

        // Dynamic Exhaustive Patches
        ...Array.from({ length: 21 }, (_, i) => `0.3.${i}`).map(
          (v) =>
            `errno_v${v.replace(/\./g, "")} = { package = "errno", version = "=${v}", path = "${path.join(generatedStubsDir, "errno" + v.replace(/\./g, "") + "-stub")}" }`
        ),
        ...Array.from({ length: 11 }, (_, i) => `0.2.${i + 10}`)
          .concat(["0.1.16", "0.3.4"])
          .map(
            (v) =>
              `getrandom_v${v.replace(/\./g, "")} = { package = "getrandom", version = "=${v}", path = "${path.join(generatedStubsDir, "getrandom" + v.replace(/\./g, "") + "-stub")}" }`
          ),
        ...Array.from({ length: 31 }, (_, i) => `0.38.${i + 20}`)
          .concat(Array.from({ length: 16 }, (_, i) => `1.0.${i}`))
          .concat(Array.from({ length: 11 }, (_, i) => `1.1.${i}`))
          .map(
            (v) =>
              `rustix_v${v.replace(/\./g, "")} = { package = "rustix", version = "=${v}", path = "${path.join(generatedStubsDir, "rustix" + v.replace(/\./g, "") + "-stub")}" }`
          ),
        ...Array.from({ length: 16 }, (_, i) => `0.16.${i + 10}`)
          .concat(Array.from({ length: 21 }, (_, i) => `0.17.${i}`))
          .map(
            (v) =>
              `ring_v${v.replace(/\./g, "")} = { package = "ring", version = "=${v}", path = "${path.join(generatedStubsDir, "ring" + v.replace(/\./g, "") + "-stub")}" }`
          ),
        ...["0.11.2+zstd.1.5.2", "0.12.3", "0.13.3"].map(
          (v) =>
            `zstd_v${v.replace(/[.+]/g, "")} = { package = "zstd", version = "=${v}", path = "${path.join(generatedStubsDir, "zstd" + v.replace(/[.+]/g, "") + "-stub")}" }`
        ),
        `secp256k1 = { path = "${path.join(generatedStubsDir, "secp256k1-hollow-stub")}" }`,
      ];

      workspaceContent += `\n${patchHeader}\n${patches.join("\n")}\n`;

      // 5. Create required patched stubs.
      const stubBase = path.join(generatedStubsDir);
      await fs.mkdir(stubBase, { recursive: true });

      const ringVers = Array.from(
        { length: 16 },
        (_, i) => `0.16.${i + 10}`
      ).concat(Array.from({ length: 21 }, (_, i) => `0.17.${i}`));
      const rustixVers = Array.from({ length: 31 }, (_, i) => `0.38.${i + 20}`)
        .concat(Array.from({ length: 16 }, (_, i) => `1.0.${i}`))
        .concat(Array.from({ length: 11 }, (_, i) => `1.1.${i}`));
      const errnoVers = Array.from({ length: 21 }, (_, i) => `0.3.${i}`);
      const getrandomVers = Array.from(
        { length: 11 },
        (_, i) => `0.2.${i + 10}`
      ).concat(["0.1.16", "0.3.4"]);
      const zstdVers = ["0.11.2+zstd.1.5.2", "0.12.3", "0.13.3"];

      // Compat sources loaded above.

      const allStubConfigs = [
        {
          name: "ring",
          vers: ringVers,
          features: "alloc = []\nstd = []",
          lib: "pub fn stub() {}",
        },
        {
          name: "rustix",
          vers: rustixVers,
          features:
            "std = []\nstdio = []\nfs = []\nnet = []\nprocess = []\nparam = []\ntermios = []\ntime = []\nrand = []",
          compatSource: "rustix",
        },
        {
          name: "errno",
          vers: errnoVers,
          features: "std = []",
          compatSource: "errno",
        },
        {
          name: "getrandom",
          vers: getrandomVers,
          features: "wasm_js = []\njs = []\nstd = []",
          compatSource: "getrandom",
        },
        {
          name: "zstd",
          vers: zstdVers,
          features: "no_asm = []\nstd = []",
          compatSource: "zstd",
        },
      ];

      for (const cfg of allStubConfigs) {
        for (const v of cfg.vers) {
          const vDir = v.replace(/[.+]/g, "");
          const sDir = path.join(stubBase, `${cfg.name}${vDir}-stub`);
          await fs.mkdir(sDir, { recursive: true });
          await fs.mkdir(path.join(sDir, "src"), { recursive: true });

          // Overwrite Cargo.toml to ensure features are current
          const cargo = `[package]\nname = "${cfg.name}"\nversion = "${v}"\nedition = "2021"\n\n[features]\n${cfg.features}\n`;
          await fs.writeFile(path.join(sDir, "Cargo.toml"), cargo);

          const libPath = path.join(sDir, "src", "lib.rs");
          // Always refresh core stub sources from the compat overlay.
          if (cfg.compatSource) {
            await fs.copyFile(
              path.join(compatDir, `${cfg.compatSource}.rs`),
              libPath
            );
          } else {
            await fs.writeFile(libPath, cfg.lib || "pub fn stub() {}");
          }
        }
      }

      // 5.2 Explicitly generate hollow stubs for non-vendor workspace dependencies
      const workspaceStubs = [{ name: "stacker", compatSource: "stacker" }];
      // Generate blst, secp256k1, and rayon stubs from compat overlay.
      const cryptoStubs = [
        {
          name: "blst-wasm-stub",
          pkgName: "blst",
          version: buildConfig.versions.blst,
          compatSource: "blst_lib",
          features: "std = []\nalloc = []",
        },
        {
          name: "secp256k1-hollow-stub",
          pkgName: "secp256k1",
          version: buildConfig.versions.secp256k1_hollow,
          compatSource: "secp256k1_lib",
          features:
            'rand = ["dep:rand"]\nstd = []\nalloc = []\nrecovery = []\nglobal-context = []\nserde = ["dep:serde", "k256/serde"]\nbitcoin_hashes = []\nrand-std = ["rand", "rand/std"]\n\n[dependencies]\nserde = { version = "1.0", optional = true, features = ["derive"] }\nrand = { version = "0.8", optional = true, default-features = false }\nk256 = { version = "0.13", default-features = false, features = ["ecdsa", "arithmetic", "schnorr", "sha256", "serde", "pkcs8"] }',
        },
        {
          name: "rayon-stub",
          pkgName: "rayon",
          version: buildConfig.versions.rayon,
          compatSource: "rayon_lib",
          features: "",
        },
      ];
      for (const st of cryptoStubs) {
        const sDir = path.join(stubBase, st.name);
        if (!(await dirExists(sDir))) {
          console.log(`Generating explicit stub for ${st.name}...`);
          await fs.mkdir(sDir, { recursive: true });
          await fs.mkdir(path.join(sDir, "src"), { recursive: true });
        }
        const feats = st.features || "";
        await fs.writeFile(
          path.join(sDir, "Cargo.toml"),
          `[package]\nname = "${st.pkgName}"\nversion = "${st.version}"\nedition = "2021"\n[lib]\npath = "src/lib.rs"\n[features]\n${feats}`
        );
        await fs.copyFile(
          path.join(compatDir, `${st.compatSource}.rs`),
          path.join(sDir, "src", "lib.rs")
        );
      }
      for (const st of workspaceStubs) {
        const sDir = path.join(stubBase, `${st.name}-hollow-stub`);
        if (!(await dirExists(sDir))) {
          console.log(`Generating explicit hollow stub for ${st.name}...`);
          await fs.mkdir(sDir, { recursive: true });
          await fs.mkdir(path.join(sDir, "src"), { recursive: true });
          await fs.writeFile(
            path.join(sDir, "Cargo.toml"),
            `[package]\nname = "${st.name}"\nversion = "0.0.0"\nedition = "2021"\n[lib]\npath = "src/lib.rs"`
          );
          await fs.copyFile(
            path.join(compatDir, `${st.compatSource}.rs`),
            path.join(sDir, "src", "lib.rs")
          );
        }
      }

      // 5.5 Vendor fastcrypto AND rust-secp256k1
      if (!(await dirExists(fcDir))) {
        console.log(`Vendoring fastcrypto at ${fcCommit}...`);
        await fs.mkdir(vendorDir, { recursive: true });
        await run("git", [
          "clone",
          "https://github.com/MystenLabs/fastcrypto",
          fcDir,
        ]);
        await run("git", ["checkout", fcCommit], { cwd: fcDir });
      }

      if (!(await dirExists(secpDir))) {
        console.log(
          `Vendoring rust-secp256k1 (v${buildConfig.versions.secp256k1_hollow})...`
        );
        await fs.mkdir(vendorDir, { recursive: true });
        await run("git", [
          "clone",
          "https://github.com/rust-bitcoin/rust-secp256k1",
          secpDir,
        ]);
        await run(
          "git",
          ["checkout", `secp256k1-${buildConfig.versions.secp256k1_hollow}`],
          { cwd: secpDir }
        );
      }

      // Patch rust-secp256k1 to use our sys stub
      const secpCargo = path.join(secpDir, "Cargo.toml");
      if (await fs.stat(secpCargo).catch(() => false)) {
        let content = await fs.readFile(secpCargo, "utf-8");
        const stubPath = path.join(generatedStubsDir, "secp256k1-sys-stub");
        content = content.replace(
          /^secp256k1-sys\s*=.*$/gm,
          `secp256k1-sys = { path = "${stubPath}", default-features = false }`
        );
        await fs.writeFile(secpCargo, content);
      }

      // Patch fastcrypto secp256r1 for the WASM-compatible dependency set.
      const fcSecp256r1 = path.join(
        fcDir,
        "fastcrypto",
        "src",
        "secp256r1",
        "mod.rs"
      );
      if (await fs.stat(fcSecp256r1).catch(() => false)) {
        console.log(
          "Patching fastcrypto secp256r1/mod.rs with compat source..."
        );
        const compatPath = path.join(
          compatDir,
          filePatches.fastcryptoSecp256r1Mod
        );
        await fs.copyFile(compatPath, fcSecp256r1);
      }
      const fcRistretto255 = path.join(
        fcDir,
        "fastcrypto",
        "src",
        "groups",
        "ristretto255.rs"
      );
      if (await fs.stat(fcRistretto255).catch(() => false)) {
        console.log(
          "Patching fastcrypto groups/ristretto255.rs with compat source..."
        );
        const compatPath = path.join(
          compatDir,
          filePatches.fastcryptoRistretto255Mod
        );
        await fs.copyFile(compatPath, fcRistretto255);
      }

      // Apply vendored manifest redirects on each prepare run.
      console.log("Patching vendored manifests...");
      await patchAllCargoTomls(vendorDir);

      const patchGit = `
[patch.'https://github.com/MystenLabs/fastcrypto']
fastcrypto = { path = "${path.join(fcDir, "fastcrypto")}" }
fastcrypto-zkp = { path = "${path.join(generatedStubsDir, "fastcrypto-zkp-hollow-stub")}" }
fastcrypto-tbls = { path = "${path.join(fcDir, "fastcrypto-tbls")}" }
fastcrypto-vdf = { path = "${path.join(fcDir, "fastcrypto-vdf")}" }
`;
      workspaceContent += patchGit;

      // ENSURE [workspace.dependencies] exists
      if (!workspaceContent.includes("[workspace.dependencies]")) {
        workspaceContent += "\n[workspace.dependencies]\n";
      }
      const wsDependenciesStart = workspaceContent.indexOf(
        "[workspace.dependencies]"
      );
      const nextSectionStart = workspaceContent.indexOf(
        "\n[",
        wsDependenciesStart + 1
      );
      const wsDepsBlock =
        nextSectionStart === -1
          ? workspaceContent.slice(wsDependenciesStart)
          : workspaceContent.slice(wsDependenciesStart, nextSectionStart);

      const wsDeps = [
        `blst = "${buildConfig.versions.blst}"`,
        `secp256k1-sys = "${buildConfig.versions.secp256k1_sys}"`,
        `errno = "=${buildConfig.versions.errno}"`,
        `zstd = "${buildConfig.versions.zstd}"`,
        `ring = "=${buildConfig.versions.ring}"`,
        `stacker = "=${buildConfig.versions.stacker}"`,
        `getrandom = { version = "${buildConfig.versions.getrandom}", features = ["js"] }`,
        `blstrs = { path = "${path.join(generatedStubsDir, "blstrs-hollow-stub")}" }`,
        `fastcrypto-zkp = { path = "${path.join(generatedStubsDir, "fastcrypto-zkp-hollow-stub")}" }`,
        `fastcrypto-tbls = { path = "${path.join(generatedStubsDir, "fastcrypto-tbls-hollow-stub")}" }`,
        `fastcrypto-vdf = { path = "${path.join(generatedStubsDir, "fastcrypto-vdf-hollow-stub")}" }`,
      ];

      let additions = "";
      for (const dep of wsDeps) {
        const name = dep.split(" = ")[0];
        if (!wsDepsBlock.includes(`${name} =`)) {
          additions += `\n${dep}`;
        }
      }
      if (additions) {
        workspaceContent =
          workspaceContent.slice(
            0,
            wsDependenciesStart + "[workspace.dependencies]".length
          ) +
          additions +
          workspaceContent.slice(
            wsDependenciesStart + "[workspace.dependencies]".length
          );
      }

      // Inject the release profile used for WASM optimization.
      if (workspaceToml === path.join(suiWorkDir, "Cargo.toml")) {
        const profileRelease = `
[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
strip = true
panic = "abort"
`;
        if (workspaceContent.includes("[profile.release]")) {
          // Replace existing Block
          workspaceContent = workspaceContent.replace(
            /\[profile\.release\][\s\S]*?(?=\n\[|$)/g,
            profileRelease
          );
        } else {
          workspaceContent += "\n" + profileRelease;
        }
      }

      await fs.writeFile(workspaceToml, workspaceContent);
    }

    // 4.0.5 Create .cargo/config.toml
    const cargoConfigDir = path.join(suiWorkDir, ".cargo");
    const cargoConfigPath = path.join(cargoConfigDir, "config.toml");
    if (!(await dirExists(cargoConfigDir))) {
      await fs.mkdir(cargoConfigDir, { recursive: true });
    }
    await fs.writeFile(cargoConfigPath, `[env]\nZSTD_SYS_ASM_CODE = "0"\n`);

    // 4.1 Patch specific Move crates
    const problematicCrate = path.join(
      suiWorkDir,
      "external-crates",
      "move",
      "crates",
      "move-regex-borrow-graph",
      "Cargo.toml"
    );
    if (await dirExists(problematicCrate)) {
      let content = await fs.readFile(problematicCrate, "utf8");
      content = content.replace(
        "proptest = { workspace = true }",
        `proptest = { version = "${buildConfig.versions.proptest}", default-features = false, features = ["std", "bit-set"], optional = true }`
      );
      await fs.writeFile(problematicCrate, content);
    }

    // Add wasm-bindgen when the patched move-unit-test code requires it.
    const moveUnitTestCargo = path.join(
      suiWorkDir,
      "external-crates",
      "move",
      "crates",
      "move-unit-test",
      "Cargo.toml"
    );
    if (await dirExists(moveUnitTestCargo)) {
      console.log("Injecting wasm-bindgen into move-unit-test/Cargo.toml...");
      let content = await fs.readFile(moveUnitTestCargo, "utf-8");
      if (!content.includes("wasm-bindgen")) {
        content += '\n[dependencies.wasm-bindgen]\nversion = "0.2"\n';
        await fs.writeFile(moveUnitTestCargo, content);
      }
    }

    // Keep external-crates/move/Cargo.toml parseable after manifest rewrites.
    const moveWorkspaceToml = path.join(
      suiWorkDir,
      "external-crates",
      "move",
      "Cargo.toml"
    );
    if (await fs.stat(moveWorkspaceToml).catch(() => false)) {
      let content = await fs.readFile(moveWorkspaceToml, "utf-8");
      // If we find members = [ but the closing ] is inside a comment or missing before [workspace.dependencies]
      if (
        content.includes("members = [") &&
        content.includes("[workspace.dependencies]")
      ) {
        const parts = content.split("[workspace.dependencies]");
        const membersPart = parts[0];
        // Check if members part has a valid un-commented closing bracket
        // This is a naive check but sufficient for the known issue
        const closingIndex = membersPart.lastIndexOf("]");
        const commentIndex = membersPart.lastIndexOf("#");
        if (
          closingIndex < commentIndex &&
          membersPart
            .trim()
            .endsWith('# "move-execution/$CUT/crates/move-vm-types"]')
        ) {
          console.log(
            "Adding missing closing bracket in external-crates/move/Cargo.toml..."
          );
          content = content.replace(
            '# "move-execution/$CUT/crates/move-vm-types"]',
            '# "move-execution/$CUT/crates/move-vm-types"]\n]'
          );
          await fs.writeFile(moveWorkspaceToml, content);
        } else if (!membersPart.trim().endsWith("]")) {
          // Ensure the members array has a closing bracket.
          console.log(
            "Adding closing bracket in external-crates/move/Cargo.toml..."
          );
          content = content.replace(
            "[workspace.dependencies]",
            "]\n\n[workspace.dependencies]"
          );
          await fs.writeFile(moveWorkspaceToml, content);
        }
      }
    }

    // Patch sui-types to remove nitro_attestation and RPC modules
    const suiTypesLib = path.join(suiWorkDir, "crates/sui-types/src/lib.rs");
    if (await fs.stat(suiTypesLib).catch(() => false)) {
      let content = await fs.readFile(suiTypesLib, "utf-8");
      // Disable modules that break Wasm (RPC, Ring-based attestation)
      // Disable modules that break Wasm (RPC, Ring-based attestation)
      content = content.replace(
        /pub mod nitro_attestation;/g,
        "// pub mod nitro_attestation;"
      );
      content = content.replace(
        /pub mod rpc_proto_conversions;/g,
        "// pub mod rpc_proto_conversions;"
      );
      content = content.replace(
        /pub mod messages_grpc;/g,
        "// pub mod messages_grpc;"
      );
      content = content.replace(
        /pub mod transaction_driver_types;/g,
        "// pub mod transaction_driver_types;"
      );
      content = content.replace(
        /pub mod proto_value;/g,
        "// pub mod proto_value;"
      );
      content = content.replace(
        /pub mod transaction_executor;/g,
        "// pub mod transaction_executor;"
      );
      await fs.writeFile(suiTypesLib, content);

      // Remove native RPC transport dependencies from Cargo.toml.
      const suiTypesCargo = path.join(
        suiWorkDir,
        "crates/sui-types/Cargo.toml"
      );
      if (await fs.stat(suiTypesCargo).catch(() => false)) {
        let cargoContent = await fs.readFile(suiTypesCargo, "utf-8");

        cargoContent = cargoContent.replace(
          /^tonic\.workspace = true/gm,
          "# tonic.workspace = true"
        );
        cargoContent = cargoContent.replace(
          /^prost\.workspace = true/gm,
          "# prost.workspace = true"
        );
        await fs.writeFile(suiTypesCargo, cargoContent);
      }

      // Patch error.rs to remove tonic dependency
      const suiTypesError = path.join(
        suiWorkDir,
        "crates/sui-types/src/error.rs"
      );
      if (await fs.stat(suiTypesError).catch(() => false)) {
        let content = await fs.readFile(suiTypesError, "utf-8");
        content = content.replace(
          /use tonic::Status;/g,
          "// use tonic::Status;"
        );
        // Comment out the impl blocks for Status
        content = content.replace(
          /impl From<SuiErrorKind> for Status \{[\s\S]*?^\}/gm,
          "/* impl From<SuiErrorKind> for Status { ... } */"
        );
        content = content.replace(
          /impl From<SuiError> for Status \{[\s\S]*?^\}/gm,
          "/* impl From<SuiError> for Status { ... } */"
        );
        content = content.replace(
          /impl From<Status> for SuiError \{[\s\S]*?^\}/gm,
          "/* impl From<Status> for SuiError { ... } */"
        );
        await fs.writeFile(suiTypesError, content);
        await fs.writeFile(suiTypesError, content);
      }

      // Patch sui-move-natives to stub nitro_attestation (ALL VERSIONS)
      const sVersions = ["latest", "v0", "v1", "v2"];

      for (const v of sVersions) {
        const nativesSrc = path.join(
          suiWorkDir,
          `sui-execution/${v}/sui-move-natives/src`
        );
        if (await dirExists(nativesSrc)) {
          console.log(`  Stubbing nitro_attestation in ${v}...`);
          // Apply the nitro_attestation compatibility overlay.
          await fs.copyFile(
            path.join(compatDir, filePatches.nitroAttestation),
            path.join(nativesSrc, "crypto/nitro_attestation.rs")
          );

          // Patch lib.rs to remove ONLY cost params, keep registration
          const nLib = path.join(nativesSrc, "lib.rs");
          if (await fs.stat(nLib).catch(() => false)) {
            let c = await fs.readFile(nLib, "utf-8");
            // Remove field from struct
            c = c.replace(
              /pub nitro_attestation_cost_params: NitroAttestationCostParams,/g,
              "/* pub nitro_attestation_cost_params: NitroAttestationCostParams, */"
            );
            // Remove initialization
            c = c.replace(
              /nitro_attestation_cost_params: NitroAttestationCostParams \{[\s\S]*?\},/gm,
              "/* nitro_attestation_cost_params: ..., */"
            );

            await fs.writeFile(nLib, c);
          }
        }
      }
    }

    // Patch move-trace-format for WASM-compatible zstd and reader types.
    const moveTraceFormatLib = path.join(
      suiWorkDir,
      "external-crates",
      "move",
      "crates",
      "move-trace-format",
      "src",
      "lib.rs"
    );
    const moveTraceFormatFormat = path.join(
      suiWorkDir,
      "external-crates",
      "move",
      "crates",
      "move-trace-format",
      "src",
      "format.rs"
    );

    // Apply the move-trace-format lib compatibility patch.
    if (await fs.stat(moveTraceFormatLib).catch(() => false)) {
      let content = await fs.readFile(moveTraceFormatLib, "utf8");
      content = content.replace(
        /zstd::decode_all\(reader\)\?/g,
        "Ok(Vec::new())"
      );
      content = content.replace(
        /zstd::stream::copy_encode\(.*?\)\?/g,
        "Ok(())"
      );
      content = content.replace(
        /pub struct TraceReader<'a> \{[\s\S]*?\}/g,
        "pub struct TraceReader { \n    pub _p: std::marker::PhantomData<u8> \n}"
      );
      content = content.replace(
        /impl<'a> TraceReader<'a> \{/g,
        "impl TraceReader {"
      );
      content = content.replace(
        /pub fn new\(reader: impl Read \+ 'a\) -> Self \{/g,
        "pub fn new(_reader: impl Read) -> Self {"
      );
      content = content.replace(
        /TraceReader \{ reader \}/g,
        "TraceReader { _p: std::marker::PhantomData }"
      );
      await fs.writeFile(moveTraceFormatLib, content);
    }

    // Patch format.rs to wrap data in BufReader
    if (await fs.stat(moveTraceFormatFormat).catch(() => false)) {
      let content = await fs.readFile(moveTraceFormatFormat, "utf-8");
      if (content.includes("let data = zstd::stream::Decoder::new(data)?;")) {
        console.log(
          "Patching move-trace-format/src/format.rs for BufReader compatibility..."
        );
        content = content.replace(
          "let data = zstd::stream::Decoder::new(data)?;",
          "let data = zstd::stream::Decoder::new(std::io::BufReader::new(data))?;"
        );
        await fs.writeFile(moveTraceFormatFormat, content);
      }
    }

    // Apply the move-unit-test runner replacement declared in the compat manifest.
    const moveUnitTestRunner = path.join(
      suiWorkDir,
      "external-crates",
      "move",
      "crates",
      "move-unit-test",
      "src",
      "test_runner.rs"
    );
    const patchedRunnerStub = path.join(
      compatDir,
      filePatches.moveUnitTestRunner
    );

    console.log("Checking for test runner patch...");
    console.log("  Target: " + moveUnitTestRunner);
    console.log("  Source: " + patchedRunnerStub);
    const targetExists = await fs.stat(moveUnitTestRunner).catch(() => false);
    const sourceExists = await fs.stat(patchedRunnerStub).catch(() => false);
    console.log(
      `  Target exists: ${!!targetExists}, Source exists: ${!!sourceExists}`
    );

    if (!targetExists) {
      throw new Error(
        `Missing expected move-unit-test runner target: ${moveUnitTestRunner}`
      );
    }
    if (!sourceExists) {
      throw new Error(
        `Missing move-unit-test runner patch compatSource: ${patchedRunnerStub}`
      );
    }
    console.log("Applying move-unit-test/src/test_runner.rs compat source...");
    await fs.copyFile(patchedRunnerStub, moveUnitTestRunner);

    const moveVmRuntimeSrc = path.join(
      suiWorkDir,
      "external-crates",
      "move",
      "crates",
      "move-vm-runtime",
      "src"
    );
    const moveVmRuntimeLib = path.join(moveVmRuntimeSrc, "lib.rs");
    if (await fs.stat(moveVmRuntimeLib).catch(() => false)) {
      let content = await fs.readFile(moveVmRuntimeLib, "utf8");
      content = content.replace(
        '#[cfg(not(target_pointer_width = "64"))]\ncompile_error!("This code requires a 64-bit target");',
        '#[cfg(all(not(target_arch = "wasm32"), not(target_pointer_width = "64")))]\ncompile_error!("This code requires a 64-bit target");'
      );
      await fs.writeFile(moveVmRuntimeLib, content);
    }
    const moveVmRuntimeConstants = path.join(
      moveVmRuntimeSrc,
      "shared",
      "constants.rs"
    );
    if (await fs.stat(moveVmRuntimeConstants).catch(() => false)) {
      let content = await fs.readFile(moveVmRuntimeConstants, "utf8");
      content = content.replace(
        "pub const IDENTIFIER_INTERNER_SIZE_LIMIT: usize = 10_000_000_000;",
        [
          '#[cfg(target_pointer_width = "64")]',
          "pub const IDENTIFIER_INTERNER_SIZE_LIMIT: usize = 10_000_000_000;",
          '#[cfg(not(target_pointer_width = "64"))]',
          "pub const IDENTIFIER_INTERNER_SIZE_LIMIT: usize = usize::MAX;",
        ].join("\n")
      );
      await fs.writeFile(moveVmRuntimeConstants, content);
    }
    const moveVmRuntimeTelemetry = path.join(
      moveVmRuntimeSrc,
      "runtime",
      "telemetry.rs"
    );
    if (await fs.stat(moveVmRuntimeTelemetry).catch(() => false)) {
      let content = await fs.readFile(moveVmRuntimeTelemetry, "utf8");
      content = content
        .replace(
          "use crate::cache::move_cache::MoveCache;\n",
          [
            "use crate::cache::move_cache::MoveCache;",
            "",
            '#[cfg(target_arch = "wasm32")]',
            "#[derive(Clone, Copy)]",
            "struct RuntimeInstant;",
            "",
            '#[cfg(target_arch = "wasm32")]',
            "impl RuntimeInstant {",
            "    fn now() -> Self {",
            "        Self",
            "    }",
            "",
            "    fn elapsed(&self) -> Duration {",
            "        Duration::new(0, 0)",
            "    }",
            "}",
            "",
            '#[cfg(not(target_arch = "wasm32"))]',
            "type RuntimeInstant = std::time::Instant;",
            "",
          ].join("\n")
        )
        .replace(
          "start_time: std::time::Instant,",
          "start_time: RuntimeInstant,"
        )
        .replaceAll("std::time::Instant::now()", "RuntimeInstant::now()");
      await fs.writeFile(moveVmRuntimeTelemetry, content);
    }

    // Patch Cargo.toml files for WASM compatibility.
    console.log("Patching all Cargo.toml files for Wasm compatibility...");
    async function patchAllCargoTomls(dir) {
      const files = await fs.readdir(dir, { withFileTypes: true });
      for (const file of files) {
        const fullPath = path.join(dir, file.name);

        // Skip common non-source/heavy directories
        if (
          [
            "target",
            "vendor",
            ".git",
            "tests",
            "fixtures",
            "test_sources",
          ].includes(file.name)
        )
          continue;

        let stats;
        try {
          stats = await fs.stat(fullPath);
        } catch {
          continue;
        } // Skip broken symlinks

        if (stats.isDirectory()) {
          await patchAllCargoTomls(fullPath);
        } else if (file.name === "Cargo.toml") {
          console.log(`  Patching ${fullPath}...`);
          let content = await fs.readFile(fullPath, "utf8");
          let changed = false;

          // Inject neptune into fastcrypto-zkp if missing
          if (
            content.includes('name = "fastcrypto-zkp"') &&
            !content.includes("neptune =")
          ) {
            console.log(`    Injecting neptune dependency into ${fullPath}`);
            content = content.replace(
              "[dependencies]",
              '[dependencies]\nneptune = { path = "' +
                path.join(generatedStubsDir, "neptune-hollow-stub") +
                '", default-features = false }'
            );
            changed = true;
          }

          // 1. RECURSIVE REMOVAL: Strip offending crates from EVERY manifest
          for (const item of offendingCrates) {
            // 0. GENERATE NAMED STUB (once per run)
            const namedStubDir = path.join(
              generatedStubsDir,
              `${item}-hollow-stub`
            );
            // Generate named stub from the compat source.
            await fs.mkdir(namedStubDir, { recursive: true });
            await fs.mkdir(path.join(namedStubDir, "src"), { recursive: true });

            {
              // Scoping block to avoid variable collision if any

              // Ring needs 'alloc' and 'std' for rustls compatibility
              let extraConfig = "\n[features]\n";
              if (item === "ring") {
                extraConfig = "\n[features]\nalloc = []\nstd = []\n";
              } else if (
                item === "antithesis-sdk" ||
                item === "antithesis_sdk"
              ) {
                extraConfig = '\n[dependencies]\nrand = "0.8"\n';
              } else if (item === "move-package-alt-compilation") {
                extraConfig = `\n[dependencies]\nanyhow = "1.0"\nmove-model-2 = { path = "${path.join(suiWorkDir, "external-crates/move/crates/move-model-2")}" }\n`;
              } else if (item === "mysten-network") {
                extraConfig = `\n[dependencies]\nanemo = { path = "${path.join(generatedStubsDir, "anemo-hollow-stub")}" }\n`;
              } else if (item === "anemo") {
                extraConfig = `\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\n`;
              } else if (item === "consensus-config") {
                extraConfig = `\n[dependencies]\nmysten-network = { path = "${path.join(generatedStubsDir, "mysten-network-hollow-stub")}" }\n`;
              } else if (item === "fastcrypto-zkp") {
                extraConfig = `\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\nschemars = "0.8"\nim = "15"\nfastcrypto = { path = "${path.join(generatedVendorDir, "fastcrypto", "fastcrypto")}" }\nark-bn254 = { version = "0.4.0", default-features = false, features = ["curve"] }\nark-groth16 = { version = "0.4.0", default-features = false }\nark-serialize = { version = "0.4.0", default-features = false, features = ["derive"] }\nark-ff = { version = "0.4.0", default-features = false }\nark-ec = { version = "0.4.0", default-features = false }\n`;
              } else if (item === "fastcrypto-tbls") {
                extraConfig = `\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\nfastcrypto = { path = "${path.join(generatedVendorDir, "fastcrypto", "fastcrypto")}" }\n`;
              } else if (item === "fastcrypto-vdf") {
                extraConfig = `\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\nfastcrypto = { path = "${path.join(generatedVendorDir, "fastcrypto", "fastcrypto")}" }\n`;
              }
              await fs.writeFile(
                path.join(namedStubDir, "Cargo.toml"),
                `[package]\nname = "${item}"\nversion = "0.1.0"\nedition = "2021"\n${extraConfig}`
              );

              // Copy declared compat sources or explicit empty stubs only.
              const compatName = stubTemplates[item];
              const destPath = path.join(namedStubDir, "src", "lib.rs");
              if (compatName) {
                const srcPath = path.join(compatDir, `${compatName}.rs`);
                try {
                  await fs.copyFile(srcPath, destPath);
                } catch (error) {
                  throw new Error(
                    `Failed to copy declared compat source ${compatName} for ${item} from ${srcPath}: ${error.message}`
                  );
                }
              } else if (emptyStubCrates.has(item)) {
                await fs.writeFile(destPath, `pub fn stub() {}`);
              } else {
                throw new Error(
                  `No compat source or explicit empty stub declaration for ${item} in ${compatManifest.manifestPath}`
                );
              }
            }

            // 1. REDIRECT IN ALL MANIFESTS: Point offending crates to named hollow-stub
            if (fullPath.endsWith("/Cargo.toml")) {
              // 1a. Remove from members (if workspace root)
              if (content.includes("[workspace]")) {
                const memberRegex = new RegExp(
                  `"([^"]*/)?${item.replace(/-/g, "[\\/-]")}"`,
                  "g"
                );
                if (memberRegex.test(content)) {
                  console.log(
                    `    Removing ${item} from workspace members in ${fullPath}`
                  );
                  content = content.replace(memberRegex, "");
                  content = content.replace(/,\s*,/g, ",");
                  content = content.replace(/\[\s*,/g, "[");
                  content = content.replace(/,\s*\]/g, "]");
                  changed = true;
                }
              }

              // 1b. Rename package if this manifest defines an offending crate
              const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
              if (nameMatch && nameMatch[1] === item) {
                console.log(
                  `    Renaming offending package ${item} to ${item}-hollowed in ${fullPath}`
                );
                content = content.replace(
                  /^name\s*=\s*"([^"]+)"/m,
                  `name = "${item}-hollowed"`
                );
                changed = true;
              }
            }

            const escapedItem = item.replace(/-/g, "[\\-]");
            const blockRegex = new RegExp(
              `^\\s*${escapedItem}\\s*=[\\s\\S]*?\\n(?=\\s*[\\w\\-\\.]+\\s*=|\\s*\\[|\\s*$)`,
              "gm"
            );

            if (blockRegex.test(content)) {
              console.log(`    Hollowing out ${item} block in ${fullPath}`);
              content = content.replace(
                blockRegex,
                `${item} = { path = "${namedStubDir}", default-features = false }\n`
              );
              changed = true;
            } else {
              const singleRegex = new RegExp(
                `^\\s*${escapedItem}\\s*=[[^\\n]*`,
                "gm"
              );
              if (singleRegex.test(content)) {
                console.log(`    Hollowing out ${item} single in ${fullPath}`);
                content = content.replace(
                  singleRegex,
                  `${item} = { path = "${namedStubDir}", default-features = false }`
                );
                changed = true;
              }
            }

            // 2. STRIP FROM FEATURES & INLINE TABLES:
            // 2a. Inline tables: dependency = { ..., features = [...] }
            const inlineFeatureRegex = new RegExp(
              `^(\\s*${item.replace(/-/g, "[\\-]")}\\s*=[^\\n]*?features\\s*=\\s*\\[)[\\s\\S]*?(\\])`,
              "gm"
            );
            if (inlineFeatureRegex.test(content)) {
              console.log(
                `    Stripping inline features for ${item} in ${fullPath}`
              );
              content = content.replace(inlineFeatureRegex, "$1$2");
              changed = true;
            }

            // 2b. Feature sections: ["item", "item/feature", ...]
            const sections = content.split("\n[");
            let featuresChanged = false;
            for (let i = 0; i < sections.length; i++) {
              const sectionHeader =
                i === 0 && content.startsWith("[")
                  ? content.slice(1, content.indexOf("]"))
                  : sections[i].split("]")[0];

              if (sectionHeader.trim() === "package") continue;

              const featureRegex = new RegExp(`"${item}(/[^"]*)?"`, "g");
              if (featureRegex.test(sections[i])) {
                console.log(
                  `    Stripping ${item} from features list in ${fullPath}`
                );
                sections[i] = sections[i].replace(featureRegex, "");
                featuresChanged = true;
              }
            }
            if (featuresChanged) {
              content = sections.join("\n[");
              content = content.replace(/,\s*,/g, ",");
              content = content.replace(/\[\s*,/g, "[");
              content = content.replace(/,\s*\]/g, "]");
              changed = true;
            }
          }

          // Redirect native dependencies to generated stub crates.
          const stubs = {
            blst: path.join(generatedStubsDir, "blst-wasm-stub"),
            "secp256k1-sys": path.join(generatedStubsDir, "secp256k1-sys-stub"),
            errno: path.join(generatedStubsDir, "errno0314-stub"),
            zstd: path.join(generatedStubsDir, "zstd0123-stub"),
            ring: path.join(generatedStubsDir, "ring01714-stub"),
            stacker: path.join(generatedStubsDir, "stacker-hollow-stub"),
            rustix: path.join(generatedStubsDir, "rustix03844-stub"),
            getrandom: path.join(generatedStubsDir, "getrandom0217-stub"),
          };
          for (const [name, stubPath] of Object.entries(stubs)) {
            // Match: key = ... (single line) OR key = { ... } (multi-line)
            const regex = new RegExp(
              `^\\s*${name}[\\s\\.]*=\\s*(\\{[\\s\\S]*?\\}|.*$)`,
              "gm"
            );
            if (regex.test(content)) {
              content = content.replace(regex, (match) => {
                const isOptional = match.includes("optional = true");
                // Preserve optional dependency metadata while redirecting to the generated stub.
                return `${name} = { path = "${stubPath}"${isOptional ? ", optional = true" : ""} }`;
              });
              changed = true;
            }
          }

          // 3. Standard features patching (proptest, tempfile, arbitrary, tokio)
          if (content.includes("proptest")) {
            content = content.replace(/^(\s*proptest\s*=).*$/gm, (line) =>
              line.includes("optional = true")
                ? `proptest = { version = "${buildConfig.versions.proptest}", default-features = false, features = ["std", "bit-set"], optional = true }`
                : 'proptest = { version = "1.6.0", default-features = false, features = ["std", "bit-set"] }'
            );
            changed = true;
          }
          if (content.includes("tempfile")) {
            content = content.replace(/^(\s*tempfile\s*=).*$/gm, (line) =>
              line.includes("optional = true")
                ? 'tempfile = { version = "3.20.0", default-features = false, optional = true }'
                : `tempfile = { version = "${buildConfig.versions.tempfile}", default-features = false }`
            );
            changed = true;
          }
          if (content.includes("tokio")) {
            const regex = new RegExp(
              `^\\s*tokio(\\s*=(?:\\s*\\{[\\s\\S]*?\\}|.*$))`,
              "gm"
            );
            if (regex.test(content)) {
              content = content.replace(regex, (match) => {
                const isOptional = match.includes("optional = true");
                return `tokio = { version = "=1.47.1", default-features = false, features = ["sync", "macros", "rt", "io-util", "time"]${isOptional ? ", optional = true" : ""} }`;
              });
              changed = true;
            }
          }
          if (content.includes("reqwest")) {
            // Keep reqwest on a blocking-compatible version without default TLS features.
            const regex = new RegExp(
              `^\\s*reqwest(\\s*=(?:\\s*\\{[\\s\\S]*?\\}|.*$))`,
              "gm"
            );
            if (regex.test(content)) {
              content = content.replace(regex, (match) => {
                const isOptional = match.includes("optional = true");
                return `reqwest = { version = "=0.12.9", default-features = false, features = ["json", "blocking"]${isOptional ? ", optional = true" : ""} }`;
              });
              changed = true;
            }
          }

          if (content.includes("getrandom")) {
            // Use getrandom 0.2 with the js feature for WASM.
            const regex = new RegExp(
              `^\\s*getrandom(\\s*=(?:\\s*\\{[\\s\\S]*?\\}|.*$))`,
              "gm"
            );
            if (regex.test(content)) {
              content = content.replace(regex, (match) => {
                const isOptional = match.includes("optional = true");
                return `getrandom = { version = "${buildConfig.versions.getrandom}", features = ["js"]${isOptional ? ", optional = true" : ""} }`;
              });
              changed = true;
            }
          }
          if (changed) {
            await fs.writeFile(fullPath, content);
          }
        }
      }
    }
    await patchAllCargoTomls(suiWorkDir);

    // Also patch vendor directory if it exists (for fastcrypto etc.)
    const vendorDir = generatedVendorDir;
    if (await dirExists(vendorDir)) {
      console.log("Patching vendor directory...");
      await patchAllCargoTomls(vendorDir);
    }
    await patchAllCargoTomls(crateDir);

    const wasmBindgenVersion = await readCargoLockPackageVersion(
      path.join(suiWorkDir, "Cargo.lock"),
      "wasm-bindgen"
    );
    await ensureWasmBindgenCli(localBinDir, wasmBindgenVersion);

    const resolvedCommit = await resolveSuiSourceCommit(suiBuildConfig);
    await writePatchState(context, {
      resolvedCommit,
      appliedPatchGroups: [
        "sui-move-wasm overlay",
        "workspace cargo patches",
        "wasm compatibility stubs",
        "native dependency vendor patches",
        "wasm-bindgen local tool",
      ],
    });

    console.log("\nPrepare successful. Prepared workspace: " + suiWorkDir);
  } catch (error) {
    console.error("Prepare failed:", error.message);
    process.exit(1);
  }
}

main();
