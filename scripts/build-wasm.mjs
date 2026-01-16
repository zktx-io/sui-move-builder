import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const cloneDir = path.join(repoRoot, ".sui");
const localSourceDir = path.join(repoRoot, "sui-move-wasm");
const SUI_COMMIT = "a14d9e8ddadfcea837de46b43d0b72a289320afb"; // testnet-v1.63.1
const SUI_VERSION_TAG = "testnet-v1.63.1";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function dirExists(dir) {
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  try {
    const distDir = path.join(repoRoot, "dist");
    
    // Load templates for stubs (GLOBAL for main)
    const templatesDir = path.join(repoRoot, 'scripts', 'templates');
    const loadTemplate = async (name) => {
        try {
            return await fs.readFile(path.join(templatesDir, `${name}.rs`), 'utf-8');
        } catch(e) {
            // console.warn(`Warning: Template ${name} not found, using empty stub.`);
            return "pub fn stub() {}";
        }
    };

    const rustixLib = await loadTemplate('rustix');
    const getrandomLib = await loadTemplate('getrandom');
    const zstdLib = await loadTemplate('zstd');
    const errnoLib = await loadTemplate('errno');
    const mystenMetricsLib = await loadTemplate('mysten-metrics');
    const fs4Lib = await loadTemplate('fs4');
    const consensusConfigLib = await loadTemplate('consensus-config');
    const movePackageAltLib = await loadTemplate('move-package-alt');
    const movePackageAltCompLib = await loadTemplate('move-package-alt-compilation');
    const consensusTypesLib = await loadTemplate('consensus-types');
    
    // 0. Clean dist at the start
    console.log("Cleaning dist directory...");
    await fs.rm(distDir, { recursive: true, force: true });
    await fs.mkdir(distDir, { recursive: true });

    // 1. Ensure .sui is present and at the right version
    if (!(await dirExists(cloneDir))) {
      console.log(`Cloning Sui at ${SUI_COMMIT}...`);
      await run("git", ["init", cloneDir]);
      await run(
        "git",
        ["remote", "add", "origin", "https://github.com/MystenLabs/sui.git"],
        { cwd: cloneDir }
      );
    }

    console.log(`Fetching and checking out ${SUI_COMMIT}...`);
    await run("git", ["fetch", "--depth", "1", "origin", SUI_COMMIT], {
      cwd: cloneDir,
    });
    await run("git", ["reset", "--hard", SUI_COMMIT], { cwd: cloneDir });

    // Ensure submodules (Move sources) are present
    console.log("Updating submodules...");
    await run("git", ["submodule", "update", "--init", "--recursive"], {
      cwd: cloneDir,
    });

    // 2. Prepare our crate within Sui workspace
    const crateDir = path.join(cloneDir, "crates", "sui-move-wasm");
    console.log(`Overlaying sui-move-wasm into ${crateDir}...`);
    await fs.rm(crateDir, { recursive: true, force: true });
    await fs.mkdir(crateDir, { recursive: true });

    // Copy our source files (excluding vendor if it exists, though we plan to delete it)
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
    cargoContent = cargoContent.replace(/\[workspace\][\s\S]*?resolver = "2"/g, "");
    cargoContent = cargoContent.replace(/\[workspace\.dependencies\][\s\S]*?(?=\n\[)/g, "");
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
      path.join(cloneDir, "Cargo.toml"),
      path.join(cloneDir, "external-crates", "move", "Cargo.toml"),
    ];

    for (const workspaceToml of workspaceTomls) {
      if (!(await dirExists(workspaceToml))) continue;

      console.log(`Patching workspace at ${workspaceToml}...`);
      // Remove Cargo.lock to force re-resolution with our patches
      const lockFile = path.join(path.dirname(workspaceToml), "Cargo.lock");
      if (await dirExists(lockFile)) {
          await fs.rm(lockFile);
      }
      let workspaceContent = await fs.readFile(workspaceToml, "utf8");

      if (workspaceToml.includes(".sui/Cargo.toml")) {
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
        'zstd-sys = { version = "2.0.11", default-features = false, features = ["no_asm"] }'
      );
      // Fallback for different version formats or existing objects
      workspaceContent = workspaceContent.replace(
        /zstd-sys = { version = "(2\.[0-9.]+)"/g,
        'zstd-sys = { version = "$1", default-features = false, features = ["no_asm"] }'
      );
      // Force tokio time feature globally
      workspaceContent = workspaceContent.replace(
        /tokio = { version = "(1\.[0-9.]+)", features = \[(.*)\] }/g,
        'tokio = { version = "$1", features = [$2, "time"] }'
      );
      workspaceContent = workspaceContent.replace(
        /tokio = "(1\.[0-9.]+)"/g,
        'tokio = { version = "$1", features = ["time"] }'
      );

      if (
        workspaceToml.includes(".sui/Cargo.toml") &&
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
        'proptest = { version = "=1.6.0", default-features = false, features = ["std", "bit-set"] }'
      );
      workspaceContent = workspaceContent.replace(
        /clap = { version = "4", features = \["derive"\] }/g,
        'clap = { version = "4", default-features = false, features = ["derive", "std", "help", "usage", "error-context"] }'
      );
      workspaceContent = workspaceContent.replace(
        /rand = "0\.8\.[0-9]"/g,
        'rand = "=0.8.5"'
      );
      workspaceContent = workspaceContent.replace(
        /fastcrypto = { git = "https:\/\/github\.com\/MystenLabs\/fastcrypto", rev = "4db0e90c732bbf7420ca20de808b698883148d9c" }/g,
        'fastcrypto = { git = "https://github.com/MystenLabs/fastcrypto", rev = "4db0e90c732bbf7420ca20de808b698883148d9c", default-features = false }'
      );
      workspaceContent = workspaceContent.replace(
        /sui-crypto = { git = "https:\/\/github\.com\/MystenLabs\/sui-rust-sdk\.git", rev = "339c2272fd5b8fb4e1fa6662cfa9acdbb0d05704", features = \[ "ed25519", "secp256r1", "secp256k1", "passkey", "zklogin" \] }/g,
        'sui-crypto = { git = "https://github.com/MystenLabs/sui-rust-sdk.git", rev = "339c2272fd5b8fb4e1fa6662cfa9acdbb0d05704", features = [ "ed25519", "secp256r1", "passkey", "zklogin" ] }'
      );
      workspaceContent = workspaceContent.replace(
        /insta = { version = "1\.[0-9.]+"/g,
        (match) =>
          match.includes("1.21.1")
            ? 'insta = { version = "=1.44.0"'
            : 'insta = { version = "=1.42.0"'
      );
      workspaceContent = workspaceContent.replace(
        /tempfile = "=3\.[0-9.]+"/g,
        'tempfile = { version = "3.20.0", default-features = false }'
      );
      // Fallback for non-pinned
      workspaceContent = workspaceContent.replace(
        /tempfile = "3\.[0-9.]+"/g,
        'tempfile = { version = "3.20.0", default-features = false }'
      );

      workspaceContent = workspaceContent.replace(
        /tokio = "=1\.47\.1"/g,
        'tokio = { version = "=1.47.1", default-features = false, features = ["sync", "macros", "rt", "io-util"] }'
      );

      // 4. Patch workspace roots: Restore [patch.crates-io] and unified workspace dependencies
      workspaceContent = workspaceContent.replace(/\[patch\.crates-io\][\s\S]*?(?=\n\[|$)/g, "");

      // Define vendor paths early
      const fcCommit = "4db0e90c732bbf7420ca20de808b698883148d9c";
      const vendorDir = path.join(repoRoot, "vendor");
      const fcDir = path.join(vendorDir, "fastcrypto");
      const secpDir = path.join(vendorDir, "rust-secp256k1");

      const patchHeader = "[patch.crates-io]";
      const rootAbsPath = path.resolve(process.cwd());
      const patches = [
        `blst = { path = "${path.join(rootAbsPath, "scripts", "stubs", "blst-wasm-stub")}" }`,
        `secp256k1-sys = { path = "${path.join(rootAbsPath, "scripts", "stubs", "secp256k1-sys-stub")}" }`,
        // Dynamic Exhaustive Patches
        ...Array.from({length: 21}, (_, i) => `0.3.${i}`).map(v => `errno_v${v.replace(/\./g, '')} = { package = "errno", version = "=${v}", path = "${path.join(rootAbsPath, "scripts", "stubs", "errno" + v.replace(/\./g, '') + "-stub")}" }`),
        ...Array.from({length: 11}, (_, i) => `0.2.${i+10}`).concat(["0.1.16", "0.3.4"]).map(v => `getrandom_v${v.replace(/\./g, '')} = { package = "getrandom", version = "=${v}", path = "${path.join(rootAbsPath, "scripts", "stubs", "getrandom" + v.replace(/\./g, '') + "-stub")}" }`),
        ...Array.from({length: 31}, (_, i) => `0.38.${i+20}`).concat(Array.from({length: 16}, (_, i) => `1.0.${i}`)).concat(Array.from({length: 11}, (_, i) => `1.1.${i}`)).map(v => `rustix_v${v.replace(/\./g, '')} = { package = "rustix", version = "=${v}", path = "${path.join(rootAbsPath, "scripts", "stubs", "rustix" + v.replace(/\./g, '') + "-stub")}" }`),
        ...Array.from({length: 16}, (_, i) => `0.16.${i+10}`).concat(Array.from({length: 21}, (_, i) => `0.17.${i}`)).map(v => `ring_v${v.replace(/\./g, '')} = { package = "ring", version = "=${v}", path = "${path.join(rootAbsPath, "scripts", "stubs", "ring" + v.replace(/\./g, '') + "-stub")}" }`),
        ...["0.11.2+zstd.1.5.2", "0.12.3", "0.13.3"].map(v => `zstd_v${v.replace(/[.+]/g, '')} = { package = "zstd", version = "=${v}", path = "${path.join(rootAbsPath, "scripts", "stubs", "zstd" + v.replace(/[.+]/g, '') + "-stub")}" }`),
        `secp256k1 = { path = "${secpDir}" }`,
      ];
      
      workspaceContent += `\n${patchHeader}\n${patches.join("\n")}\n`;

      // 5. Self-heal/Create Patched Stubs (Ensures missing stubs from previous runs are fixed/recreated)
      const stubBase = path.join(repoRoot, "scripts", "stubs");
      await fs.mkdir(stubBase, { recursive: true });

      const ringVers = Array.from({length: 16}, (_, i) => `0.16.${i+10}`).concat(Array.from({length: 21}, (_, i) => `0.17.${i}`));
      const rustixVers = Array.from({length: 31}, (_, i) => `0.38.${i+20}`).concat(Array.from({length: 16}, (_, i) => `1.0.${i}`)).concat(Array.from({length: 11}, (_, i) => `1.1.${i}`));
      const errnoVers = Array.from({length: 21}, (_, i) => `0.3.${i}`);
      const getrandomVers = Array.from({length: 11}, (_, i) => `0.2.${i+10}`).concat(["0.1.16", "0.3.4"]);
      const zstdVers = ["0.11.2+zstd.1.5.2", "0.12.3", "0.13.3"];

      // Templates loaded above
      
      const allStubConfigs = [
          { name: 'ring', vers: ringVers, features: 'alloc = []\nstd = []', lib: 'pub fn stub() {}' },
          { name: 'rustix', vers: rustixVers, features: 'std = []\nstdio = []\nfs = []\nnet = []\nprocess = []\nparam = []\ntermios = []\ntime = []\nrand = []', lib: rustixLib },
          { name: 'errno', vers: errnoVers, features: 'std = []', lib: errnoLib },
          { name: 'getrandom', vers: getrandomVers, features: 'wasm_js = []\njs = []\nstd = []', lib: getrandomLib },
          { name: 'zstd', vers: zstdVers, features: 'no_asm = []\nstd = []', lib: zstdLib },
      ];

      for (const cfg of allStubConfigs) {
          for (const v of cfg.vers) {
              const vDir = v.replace(/[.+]/g, '');
              const sDir = path.join(stubBase, `${cfg.name}${vDir}-stub`);
              await fs.mkdir(sDir, { recursive: true });
              await fs.mkdir(path.join(sDir, 'src'), { recursive: true });
              
              // Overwrite Cargo.toml to ensure features are current
              const cargo = `[package]\nname = "${cfg.name}"\nversion = "${v}"\nedition = "2021"\n\n[features]\n${cfg.features}\n`;
              await fs.writeFile(path.join(sDir, 'Cargo.toml'), cargo);
              
              const libPath = path.join(sDir, 'src', 'lib.rs');
              // ALWAYS overwrite lib.rs for these core stubs to ensure fixes (like semicolons) are applied
              await fs.writeFile(libPath, cfg.lib);
          }
      }

      // 5.5 Vendor fastcrypto AND rust-secp256k1
      if (!(await dirExists(fcDir))) {
          console.log(`Vendoring fastcrypto at ${fcCommit}...`);
          await fs.mkdir(vendorDir, { recursive: true });
          await run("git", ["clone", "https://github.com/MystenLabs/fastcrypto", fcDir]);
          await run("git", ["checkout", fcCommit], { cwd: fcDir });
      }

      if (!(await dirExists(secpDir))) {
          console.log(`Vendoring rust-secp256k1 (v0.27.0)...`);
          await fs.mkdir(vendorDir, { recursive: true });
          await run("git", ["clone", "https://github.com/rust-bitcoin/rust-secp256k1", secpDir]);
          await run("git", ["checkout", "secp256k1-0.27.0"], { cwd: secpDir });
      }
      
      // Patch rust-secp256k1 to use our sys stub
      const secpCargo = path.join(secpDir, "Cargo.toml");
      if (await fs.stat(secpCargo).catch(() => false)) {
          let content = await fs.readFile(secpCargo, 'utf-8');
          const stubPath = path.join(repoRoot, "scripts", "stubs", "secp256k1-sys-stub");
          content = content.replace(/^secp256k1-sys\s*=.*$/gm, `secp256k1-sys = { path = "${stubPath}", default-features = false }`);
          await fs.writeFile(secpCargo, content);
      }

      // Apply strict patching to vendored manifests to force stubs (ALWAYS run this)
      console.log("Patching vendored manifests...");
      await patchAllCargoTomls(vendorDir);
      
      const patchGit = `
[patch.'https://github.com/MystenLabs/fastcrypto']
fastcrypto = { path = "${path.join(fcDir, "fastcrypto")}" }
fastcrypto-zkp = { path = "${path.join(rootAbsPath, "scripts", "stubs", "fastcrypto-zkp-hollow-stub")}" }
fastcrypto-tbls = { path = "${path.join(fcDir, "fastcrypto-tbls")}" }
fastcrypto-vdf = { path = "${path.join(fcDir, "fastcrypto-vdf")}" }
`;
      workspaceContent += patchGit;

      // ENSURE [workspace.dependencies] exists
      if (!workspaceContent.includes("[workspace.dependencies]")) {
        workspaceContent += "\n[workspace.dependencies]\n";
      }
      const wsDependenciesStart = workspaceContent.indexOf("[workspace.dependencies]");
      const nextSectionStart = workspaceContent.indexOf("\n[", wsDependenciesStart + 1);
      const wsDepsBlock = nextSectionStart === -1 
        ? workspaceContent.slice(wsDependenciesStart) 
        : workspaceContent.slice(wsDependenciesStart, nextSectionStart);
      
        const wsDeps = [
          'blst = "0.3.16"',
          'secp256k1-sys = "0.8.1"',
          'errno = "=0.3.14"',
          'zstd = "0.12.3"',
          'ring = "=0.17.99"',
          'stacker = "=0.1.15"',
          'getrandom = { version = "0.2.15", features = ["js"] }',
          `blstrs = { path = "${path.join(cloneDir, '../stubs/empty-stub')}" }`,
          `fastcrypto-zkp = { path = "${path.join(cloneDir, '../stubs/empty-stub')}" }`,
          `fastcrypto-tbls = { path = "${path.join(cloneDir, '../stubs/empty-stub')}" }`,
          `fastcrypto-vdf = { path = "${path.join(cloneDir, '../stubs/empty-stub')}" }`,
        ];

      let additions = "";
      for (const dep of wsDeps) {
        const name = dep.split(' = ')[0];
        if (!wsDepsBlock.includes(`${name} =`)) {
          additions += `\n${dep}`;
        }
      }
      if (additions) {
        workspaceContent = workspaceContent.slice(0, wsDependenciesStart + "[workspace.dependencies]".length) + additions + workspaceContent.slice(wsDependenciesStart + "[workspace.dependencies]".length);
      }

      // Inject release profile for Wasm optimization (Task 6)
      if (workspaceToml.includes(".sui/Cargo.toml")) {
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
               workspaceContent = workspaceContent.replace(/\[profile\.release\][\s\S]*?(?=\n\[|$)/g, profileRelease);
          } else {
               workspaceContent += "\n" + profileRelease;
          }
      }

      await fs.writeFile(workspaceToml, workspaceContent);
    }

    // 4.0.5 Create .cargo/config.toml
    const cargoConfigDir = path.join(cloneDir, ".cargo");
    const cargoConfigPath = path.join(cargoConfigDir, "config.toml");
    if (!(await dirExists(cargoConfigDir))) {
      await fs.mkdir(cargoConfigDir, { recursive: true });
    }
    await fs.writeFile(cargoConfigPath, `[env]\nZSTD_SYS_ASM_CODE = "0"\n`);

    // 4.1 Patch specific Move crates
    const problematicCrate = path.join(cloneDir, "external-crates", "move", "crates", "move-regex-borrow-graph", "Cargo.toml");
    if (await dirExists(problematicCrate)) {
      let content = await fs.readFile(problematicCrate, "utf8");
      content = content.replace('proptest = { workspace = true }', 'proptest = { version = "1.6.0", default-features = false, features = ["std", "bit-set"], optional = true }');
      await fs.writeFile(problematicCrate, content);
    }

    // Fix malformed external-crates/move/Cargo.toml where ']' might be commented out
    const moveWorkspaceToml = path.join(cloneDir, "external-crates", "move", "Cargo.toml");
    if (await fs.stat(moveWorkspaceToml).catch(() => false)) {
        let content = await fs.readFile(moveWorkspaceToml, 'utf-8');
        // If we find members = [ but the closing ] is inside a comment or missing before [workspace.dependencies]
        if (content.includes('members = [') && content.includes('[workspace.dependencies]')) {
             const parts = content.split('[workspace.dependencies]');
             const membersPart = parts[0];
             // Check if members part has a valid un-commented closing bracket
             // This is a naive check but sufficient for the known issue
             const closingIndex = membersPart.lastIndexOf(']');
             const commentIndex = membersPart.lastIndexOf('#');
             if (closingIndex < commentIndex && membersPart.trim().endsWith('# "move-execution/$CUT/crates/move-vm-types"]')) {
                 console.log("Fixing unclosed members array in external-crates/move/Cargo.toml...");
                 content = content.replace('# "move-execution/$CUT/crates/move-vm-types"]', '# "move-execution/$CUT/crates/move-vm-types"]\n]');
                 await fs.writeFile(moveWorkspaceToml, content);
             } else if (!membersPart.trim().endsWith(']')) {
                 // Fallback: just ensure it ends with ]
                  console.log("Forcing closing bracket in external-crates/move/Cargo.toml...");
                  content = content.replace('[workspace.dependencies]', ']\n\n[workspace.dependencies]');
                  await fs.writeFile(moveWorkspaceToml, content);
             }
        }
    }


    // Patch sui-types to remove nitro_attestation and RPC modules
    const suiTypesLib = path.join(cloneDir, "crates/sui-types/src/lib.rs");
    if (await fs.stat(suiTypesLib).catch(() => false)) {
        let content = await fs.readFile(suiTypesLib, 'utf-8');
        // Disable modules that break Wasm (RPC, Ring-based attestation)
        // Disable modules that break Wasm (RPC, Ring-based attestation)
        content = content.replace(/pub mod nitro_attestation;/g, "// pub mod nitro_attestation;");
        content = content.replace(/pub mod rpc_proto_conversions;/g, "// pub mod rpc_proto_conversions;");
        content = content.replace(/pub mod messages_grpc;/g, "// pub mod messages_grpc;");
        content = content.replace(/pub mod transaction_driver_types;/g, "// pub mod transaction_driver_types;");
        content = content.replace(/pub mod proto_value;/g, "// pub mod proto_value;");
        content = content.replace(/pub mod transaction_executor;/g, "// pub mod transaction_executor;");
        await fs.writeFile(suiTypesLib, content);
        
        // Remove RPC dependencies from Cargo.toml to prevent feature resolution issues
        const suiTypesCargo = path.join(cloneDir, "crates/sui-types/Cargo.toml");
        if (await fs.stat(suiTypesCargo).catch(() => false)) {
            let cargoContent = await fs.readFile(suiTypesCargo, 'utf-8');

            cargoContent = cargoContent.replace(/^tonic\.workspace = true/gm, '# tonic.workspace = true');
            cargoContent = cargoContent.replace(/^prost\.workspace = true/gm, '# prost.workspace = true');
            cargoContent = cargoContent.replace(/^sui-rpc\.workspace = true/gm, '# sui-rpc.workspace = true');
            await fs.writeFile(suiTypesCargo, cargoContent);
        }

        // Patch error.rs to remove tonic dependency
        const suiTypesError = path.join(cloneDir, "crates/sui-types/src/error.rs");
        if (await fs.stat(suiTypesError).catch(() => false)) {
             let content = await fs.readFile(suiTypesError, 'utf-8');
             content = content.replace(/use tonic::Status;/g, "// use tonic::Status;");
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
        const sVersions = ['latest', 'v0', 'v1', 'v2'];
        const nitroStub = `
use move_binary_format::errors::PartialVMResult;
use move_vm_runtime::native_functions::NativeContext;
use move_vm_types::{
    loaded_data::runtime_types::Type,
    natives::function::NativeResult,
    values::Value,
};
use move_core_types::gas_algebra::InternalGas;
use std::collections::VecDeque;

#[derive(Clone)]
pub struct NitroAttestationCostParams {
    pub parse_base_cost: Option<InternalGas>,
    pub parse_cost_per_byte: Option<InternalGas>,
    pub verify_base_cost: Option<InternalGas>,
    pub verify_cost_per_cert: Option<InternalGas>,
}

pub fn load_nitro_attestation_internal(
    context: &mut NativeContext,
    _ty_args: Vec<Type>,
    mut args: VecDeque<Value>,
) -> PartialVMResult<NativeResult> {
    // Pop args
    let _ = args.pop_back(); 
    let _ = args.pop_back();
    // Return ENotSupportedError (0)
    Ok(NativeResult::err(context.gas_used(), 0))
}
`;
        for (const v of sVersions) {
             const nativesSrc = path.join(cloneDir, `sui-execution/${v}/sui-move-natives/src`);
             if (await dirExists(nativesSrc)) {
                 console.log(`  Stubbing nitro_attestation in ${v}...`);
                 // Overwrite nitro_attestation.rs
                 await fs.writeFile(path.join(nativesSrc, "crypto/nitro_attestation.rs"), nitroStub);
                 
                 // Patch lib.rs to remove ONLY cost params, keep registration
                 const nLib = path.join(nativesSrc, "lib.rs");
                 if (await fs.stat(nLib).catch(() => false)) {
                     let c = await fs.readFile(nLib, 'utf-8');
                     // Remove field from struct
                     c = c.replace(/pub nitro_attestation_cost_params: NitroAttestationCostParams,/g, "/* pub nitro_attestation_cost_params: NitroAttestationCostParams, */");
                     // Remove initialization
                     c = c.replace(/nitro_attestation_cost_params: NitroAttestationCostParams \{[\s\S]*?\},/gm, "/* nitro_attestation_cost_params: ..., */");
                     
                     await fs.writeFile(nLib, c);
                 }
             }
        }

    }


    // 4.2 Patch move-trace-format to stub out zstd AND fix Type Mismatch
    const moveTraceFormatLib = path.join(cloneDir, "external-crates", "move", "crates", "move-trace-format", "src", "lib.rs");
    const moveTraceFormatFormat = path.join(cloneDir, "external-crates", "move", "crates", "move-trace-format", "src", "format.rs");
    
    // Fix existing stubbing (lib.rs)
    if (await fs.stat(moveTraceFormatLib).catch(() => false)) {
      let content = await fs.readFile(moveTraceFormatLib, "utf8");
      content = content.replace(/zstd::decode_all\(reader\)\?/g, "Ok(Vec::new())");
      content = content.replace(/zstd::stream::copy_encode\(.*?\)\?/g, "Ok(())");
      content = content.replace(/pub struct TraceReader<'a> \{[\s\S]*?\}/g, "pub struct TraceReader { \n    pub _p: std::marker::PhantomData<u8> \n}");
      content = content.replace(/impl<'a> TraceReader<'a> \{/g, "impl TraceReader {");
      content = content.replace(/pub fn new\(reader: impl Read \+ 'a\) -> Self \{/g, "pub fn new(_reader: impl Read) -> Self {");
      content = content.replace(/TraceReader \{ reader \}/g, "TraceReader { _p: std::marker::PhantomData }");
      await fs.writeFile(moveTraceFormatLib, content);
    }

    // Patch move-stdlib/src/lib.rs to remove build_doc and imports
    const moveStdlibLib = path.join(cloneDir, "external-crates", "move", "crates", "move-stdlib", "src", "lib.rs");
    if (await fs.stat(moveStdlibLib).catch(() => false)) {
        let content = await fs.readFile(moveStdlibLib, 'utf-8');
        content = content.replace(/use move_package_alt::flavor::Vanilla;/g, "// use move_package_alt::flavor::Vanilla;");
        content = content.replace(/use move_package_alt_compilation::build_config::BuildConfig;/g, "// use move_package_alt_compilation::build_config::BuildConfig;");
        content = content.replace(/pub async fn build_doc\(output_directory: String\) -> anyhow::Result<\(\)> \{[\s\S]*?^ ok\(\)\n^\}/gm, "pub async fn build_doc(_output_directory: String) -> anyhow::Result<()> { Ok(()) }"); 
        // Logic to remove the whole function body or stub it is hard with regex. 
        // Simpler: comment out the specific lines inside it or stub imports.
        // Actually, if I comment out the imports, the function will fail.
        // I will just replace the whole file content with a safe version since the method isn't critical for Wasm? 
        // No, move-stdlib is critical.
        // I'll replace the function `build_doc` using a simpler regex or manual stubbing if regex fails.
        // Or better: Inject stubs for move-package-alt flavor/build_config properly so I don't need to patch code.
        // Patched code is fragile. Stub imports are better.
        // I will stick to expanding stubs.
        // But patching imports for mysten-network in sui-types is still needed or stub it.
    }

    
    // Patch format.rs to wrap data in BufReader
    if (await fs.stat(moveTraceFormatFormat).catch(() => false)) {
        let content = await fs.readFile(moveTraceFormatFormat, 'utf-8');
        if (content.includes("let data = zstd::stream::Decoder::new(data)?;")) {
             console.log("Patching move-trace-format/src/format.rs to fix BufReader mismatch...");
             content = content.replace(
                 "let data = zstd::stream::Decoder::new(data)?;",
                 "let data = zstd::stream::Decoder::new(std::io::BufReader::new(data))?;"
             );
             await fs.writeFile(moveTraceFormatFormat, content);
        }
    }

    // 4.3 Patch move-unit-test to DISABLE THREADING (Wasm crash fix)
    const moveUnitTestRunner = path.join(cloneDir, "external-crates", "move", "crates", "move-unit-test", "src", "test_runner.rs");
    const patchedRunnerStub = path.join(repoRoot, "scripts", "stubs", "move_unit_test_runner_patch.rs");
    
    if ((await fs.stat(moveUnitTestRunner).catch(() => false)) && (await fs.stat(patchedRunnerStub).catch(() => false))) {
         console.log("Forcibly overwriting move-unit-test/src/test_runner.rs with patched version...");
         await fs.copyFile(patchedRunnerStub, moveUnitTestRunner);
    } else {
         console.log("WARNING: Could not patch test_runner.rs (File not found or stub missing)");
    }

    // 5. Aggressively patch ALL Cargo.toml files for compatibility
    console.log("Patching all Cargo.toml files for Wasm compatibility...");
    async function patchAllCargoTomls(dir) {
      const files = await fs.readdir(dir, { withFileTypes: true });
      for (const file of files) {
        const fullPath = path.join(dir, file.name);

        // Skip common non-source/heavy directories
        if (["target", "vendor", ".git", "tests", "fixtures", "test_sources"].includes(file.name)) continue;

        let stats;
        try {
            stats = await fs.stat(fullPath);
        } catch (e) { continue; } // Skip broken symlinks

        if (stats.isDirectory()) {
          await patchAllCargoTomls(fullPath);
        } else if (file.name === "Cargo.toml") {
          console.log(`  Patching ${fullPath}...`);
          let content = await fs.readFile(fullPath, "utf8");
          let changed = false;

          // Inject neptune into fastcrypto-zkp if missing
          if (content.includes('name = "fastcrypto-zkp"') && !content.includes('neptune =')) {
             console.log(`    Injecting neptune dependency into ${fullPath}`);
             content = content.replace('[dependencies]', '[dependencies]\nneptune = { path = "' + path.join(repoRoot, 'scripts', 'stubs', 'neptune-hollow-stub') + '", default-features = false }');
             changed = true;
          }

          // 1. RECURSIVE REMOVAL: Strip offending crates from EVERY manifest
          const offending = [
            'anemo', 'consensus-config', 'consensus-types', 'tonic', 'mysten-network', 'sui-rpc',
            'axum', 'mysten-metrics', 'sui-surfer', 'sui-faucet', 'sui-benchmark', 'tokio-stream',
            'tokio-tungstenite', 'sui-indexer-alt-graphql', 'rusty-fork', 'terminal_size',
            'anstream', 'colorchoice', 'anstyle', 'anstyle-query', 'anstyle-parse',
            'neptune', 'neptune-cash', 'neptune-triton', 'psm',
            'zstd-safe', 'zstd-sys', 'antithesis_sdk', 'antithesis-sdk', 'x509-parser', 'named-lock',
            'suins-indexer', 'sui-tls', 'tokio-postgres-rustls', 'rustls', 'webpki', 'x509-certificate',
            'move-package-alt', 'fs4', 'move-package-alt-compilation',
            'sui-indexer', 'sui-graphql-rpc', 'nitro-attestation', 'nitro-attestation-sys',
            'sui-graphql-e2e-tests', 'sui-indexer-alt', 'sui-indexer-alt-jsonrpc', 'sui-indexer-alt-metrics',
            'sui-indexer-alt-consistent-api', 'sui-indexer-alt-consistent-store', 'sui-indexer-alt-e2e-tests',
            'sui-indexer-alt-framework-store-traits', 'sui-indexer-alt-object-store', 'sui-indexer-alt-reader',
            'sui-indexer-alt-restorer', 'sui-indexer-builder', 'fs4',
          ];
          for (const item of offending) {
            // 0. GENERATE NAMED STUB (once per run)
            const namedStubDir = path.join(repoRoot, 'scripts', 'stubs', `${item}-hollow-stub`);
            if (!(await dirExists(namedStubDir))) {
                await fs.mkdir(namedStubDir, { recursive: true });
                await fs.mkdir(path.join(namedStubDir, 'src'), { recursive: true });
                // Ring needs 'alloc' and 'std' for rustls compatibility
                let extraConfig = '\n[features]\n';
                if (item === 'ring') {
                    extraConfig = '\n[features]\nalloc = []\nstd = []\n';
                } else if (item === 'antithesis-sdk' || item === 'antithesis_sdk') {
                    extraConfig = '\n[dependencies]\nrand = "0.8"\n';
                } else if (item === 'move-package-alt-compilation') {
                    extraConfig = `\n[dependencies]\nanyhow = "1.0"\nmove-model-2 = { path = "${path.join(cloneDir, 'external-crates/move/crates/move-model-2')}" }\n`;
                } else if (item === 'mysten-network') {
                    extraConfig = `\n[dependencies]\nanemo = { path = "${path.join(repoRoot, 'scripts/stubs/anemo-hollow-stub')}" }\n`;
                } else if (item === 'anemo') {
                    extraConfig = `\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\n`;
                } else if (item === 'consensus-config') {
                    extraConfig = `\n[dependencies]\nmysten-network = { path = "${path.join(repoRoot, 'scripts/stubs/mysten-network-hollow-stub')}" }\n`;
                }
                await fs.writeFile(path.join(namedStubDir, 'Cargo.toml'), `[package]\nname = "${item}"\nversion = "0.1.0"\nedition = "2021"\n${extraConfig}`);
                
                let libContent = `pub fn stub() {}`;
                if (item === 'mysten-metrics') {
                    libContent = mystenMetricsLib;
                } else if (item === 'fs4') {
                     libContent = fs4Lib;
                } else if (item === 'consensus-types') {
                    libContent = consensusTypesLib;
                } else if (item === 'consensus-config') {
                    libContent = consensusConfigLib;
                } else if (item === 'move-package-alt') {
                     libContent = movePackageAltLib;
                } else if (item === 'move-package-alt-compilation') {
                     libContent = movePackageAltCompLib;
                } else if (item === 'mysten-network') {
                    libContent = `
                        pub mod multiaddr {
                            pub use anemo::Multiaddr;
                        }
                    `;
                } else if (item === 'anemo') {
                    libContent = `
                        use serde::{Serialize, Deserialize};
                        #[derive(Clone, Debug)]
                        pub struct PeerId(pub [u8; 32]);
                        
                        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
                        pub struct Multiaddr;
                        impl std::fmt::Display for Multiaddr {
                            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "/ip4/127.0.0.1/tcp/0") }
                        }
                        impl Multiaddr {
                            pub fn to_anemo_address(&self) -> Result<Multiaddr, String> { Ok(self.clone()) }
                        }
                        impl TryFrom<String> for Multiaddr {
                           type Error = String;
                           fn try_from(_: String) -> Result<Self, Self::Error> { Ok(Multiaddr) }
                        }

                        pub mod types {
                             use super::{PeerId, Multiaddr};
                             #[derive(Clone, Debug)]
                             pub struct PeerInfo {
                                 pub peer_id: PeerId,
                                 pub affinity: PeerAffinity,
                                 pub address: Vec<Multiaddr>,
                             }
                             #[derive(Clone, Debug)]
                             pub enum PeerAffinity { High, Low }
                        }
                    `;
                } else if (item === 'tonic') {
                    libContent = `
                        pub enum Code { Internal, Ok, Unknown, InvalidArgument, NotFound, AlreadyExists, PermissionDenied, ResourceExhausted, FailedPrecondition, Aborted, OutOfRange, Unimplemented, Unavailable, DataLoss, Unauthenticated }
                        impl Code {
                            pub fn description(&self) -> &str { "stub_description" }
                        }
                        pub struct Status;
                        impl Status {
                             pub fn new(code: Code, msg: impl Into<String>) -> Self { Self }
                             pub fn with_details(code: Code, msg: impl Into<String>, details: Vec<u8>) -> Self { Self }
                             pub fn message(&self) -> &str { "stub_message" }
                             pub fn details(&self) -> &[u8] { &[] }
                             pub fn code(&self) -> Code { Code::Unknown }
                        }
                    `;

                } else if (item === 'x509-parser') {
                    libContent = `
                        pub mod certificate {
                            #[derive(Clone)]
                            pub struct X509Certificate;
                            impl X509Certificate {
                                pub fn from_der(bytes: &[u8]) -> Result<(&[u8], Self), crate::prelude::X509Error> { Ok((&[], Self)) }
                                pub fn public_key(&self) -> &[u8] { &[] }
                                pub fn key_usage(&self) -> Result<Option<crate::extensions::KeyUsage>, crate::prelude::X509Error> { Ok(Some(crate::extensions::KeyUsage::default())) }
                                pub fn basic_constraints(&self) -> Result<Option<crate::extensions::BasicConstraints>, crate::prelude::X509Error> { Ok(Some(crate::extensions::BasicConstraints::default())) }
                                pub fn validity(&self) -> crate::time::Validity { crate::time::Validity }
                                pub fn issuer(&self) -> &[u8] { &[] }
                                pub fn subject(&self) -> &[u8] { &[] }
                                pub fn verify_signature(&self, _: Option<&[u8]>) -> Result<(), crate::prelude::X509Error> { Ok(()) }
                            }
                        }
                        pub mod public_key {
                            pub struct EcKey;
                            impl EcKey { pub fn data(&self) -> &[u8] { &[] } }
                            pub enum PublicKey { EC(EcKey) }
                        }
                        pub mod time {
                            #[derive(Clone, Copy)]
                            pub struct ASN1Time;
                            impl ASN1Time {
                                pub fn from_timestamp(_: i64) -> Result<Self, crate::prelude::X509Error> { Ok(Self) }
                            }
                            pub struct Validity;
                            impl Validity {
                                pub fn is_valid_at(&self, _: ASN1Time) -> bool { true }
                            }
                        }
                        pub mod extensions {
                            #[derive(Default)]
                            pub struct KeyUsage { pub value: KeyUsageValue }
                            #[derive(Default)]
                            pub struct KeyUsageValue;
                            impl KeyUsageValue {
                                pub fn digital_signature(&self) -> bool { true }
                                pub fn key_cert_sign(&self) -> bool { true }
                            }
                            #[derive(Default)]
                            pub struct BasicConstraints { pub critical: bool, pub value: BasicConstraintsValue }
                            #[derive(Default)]
                            pub struct BasicConstraintsValue { pub ca: bool, pub path_len_constraint: Option<u64> }
                        }
                        pub mod x509 {
                            pub struct SubjectPublicKeyInfo;
                            impl SubjectPublicKeyInfo {
                                pub fn parsed(_: &[u8]) -> Result<crate::public_key::PublicKey, crate::prelude::X509Error> { Ok(crate::public_key::PublicKey::EC(crate::public_key::EcKey)) }
                            }
                        }
                        pub mod prelude {
                            pub trait FromDer {}
                            #[derive(Debug)]
                            pub struct X509Error;
                            impl std::fmt::Display for X509Error {
                                fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { write!(f, "X509Error") }
                            }
                            impl std::error::Error for X509Error {}
                        }
                    `;
                } else if (item === 'mysten-metrics') {
                    libContent = `
                        pub fn monitored_scope(name: &str) -> () { () }
                        #[macro_export]
                        macro_rules! spawn_monitored_task { ($($arg:tt)*) => { tokio::spawn($($arg)*) } }

                        #[derive(Clone)]
                        pub struct StubMetric;
                        impl StubMetric {
                            pub fn with_label_values(&self, _: &[&str]) -> Self { Self }
                            pub fn inc(&self) {}
                        }
                        #[derive(Clone)]
                        pub struct Metrics {
                            pub system_invariant_violations: StubMetric,
                        }
                        pub fn get_metrics() -> Option<Metrics> { None }
                        pub mod histogram {
                            #[derive(Clone)]
                            pub struct Histogram;
                             impl Histogram {
                                pub fn observe(&self, _: f64) {}
                            }
                        }
                    `;
                } else if (item === 'antithesis-sdk' || item === 'antithesis_sdk') {
                    libContent = `
                        #[macro_export]
                        macro_rules! assert_reachable { ($($arg:tt)*) => {} }
                        #[macro_export]
                        macro_rules! assert_sometimes { ($($arg:tt)*) => {} }
                        #[macro_export]
                        macro_rules! assert_unreachable { ($($arg:tt)*) => {} }

                        pub mod random { 
                            #[derive(Clone)]
                            pub struct AntithesisRng;
                            impl rand::RngCore for AntithesisRng {
                                fn next_u32(&mut self) -> u32 { 0 }
                                fn next_u64(&mut self) -> u64 { 0 }
                                fn fill_bytes(&mut self, dest: &mut [u8]) { for x in dest { *x = 0; } }
                                fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand::Error> { self.fill_bytes(dest); Ok(()) }
                            }
                            impl rand::CryptoRng for AntithesisRng {}
                        }
                    `;
                }
 else if (item.startsWith('neptune')) {
                    libContent = `
                        use std::marker::PhantomData;
                        pub mod poseidon {
                            pub enum HashMode { OptimizedStatic, Dynamic }
                            #[derive(Clone)]
                            pub struct PoseidonConstants<F, U>(std::marker::PhantomData<(F, U)>);
                            impl<F, U> PoseidonConstants<F, U> {
                                pub fn new_from_parameters<A, B, C, D, E, G, H>(_: A, _: B, _: C, _: D, _: E, _: G, _: H) -> Self { 
                                    Self(std::marker::PhantomData) 
                                }
                            }
                        }
                        pub mod hash_type { 
                            pub enum HashType<F, U> { Sponge, Phantom(std::marker::PhantomData<(F, U)>) }
                        }
                        #[derive(Clone)]
                        pub struct Poseidon<F> {
                            pub elements: Vec<F>,
                            _marker: PhantomData<F>,
                        }
                        impl<F> Poseidon<F> {
                            pub fn new<U>(_constants: &poseidon::PoseidonConstants<F, U>) -> Self { 
                                Self { elements: Vec::new(), _marker: PhantomData } 
                            }
                            pub fn reset(&mut self) {}
                            pub fn input(&mut self, _input: F) -> Result<(), ()> { Ok(()) }
                            pub fn hash(&mut self) -> F { panic!("Stubbed") }
                            pub fn hash_in_mode(&mut self, _mode: poseidon::HashMode) -> F { panic!("Stubbed") }
                        }
                        #[derive(Clone, Copy)]
                        pub enum Strength { Standard }
                    `;
                }
                await fs.writeFile(path.join(namedStubDir, 'src', 'lib.rs'), libContent);
            }

            // 1. REDIRECT IN ALL MANIFESTS: Point offending crates to named hollow-stub
            if (fullPath.endsWith('/Cargo.toml')) {
                 // 1a. Remove from members (if workspace root)
                 if (content.includes('[workspace]')) {
                    const memberRegex = new RegExp(`"([^"]*/)?${item.replace(/-/g, '[\\/-]')}"`, 'g');
                    if (memberRegex.test(content)) {
                        console.log(`    Removing ${item} from workspace members in ${fullPath}`);
                        content = content.replace(memberRegex, "");
                        content = content.replace(/,\s*,/g, ",");
                        content = content.replace(/\[\s*,/g, "[");
                        content = content.replace(/,\s*\]/g, "]");
                        changed = true;
                    }
                 }

                 // 1b. Rename package if this manifest defines an offending crate
                 const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
                 if (nameMatch && (nameMatch[1] === item)) {
                    console.log(`    Renaming offending package ${item} to ${item}-hollowed in ${fullPath}`);
                    content = content.replace(/^name\s*=\s*"([^"]+)"/m, `name = "${item}-hollowed"`);
                    changed = true;
                 }
            }

            const escapedItem = item.replace(/-/g, '[\\-]');
            const blockRegex = new RegExp(`^\\s*${escapedItem}\\s*=[\\s\\S]*?\\n(?=\\s*[\\w\\-\\.]+\\s*=|\\s*\\[|\\s*$)`, 'gm');
            
            if (blockRegex.test(content)) {
                console.log(`    Hollowing out ${item} block in ${fullPath}`);
                content = content.replace(blockRegex, `${item} = { path = "${namedStubDir}", default-features = false }\n`);
                changed = true;
            } else {
                const singleRegex = new RegExp(`^\\s*${escapedItem}\\s*=[[^\\n]*`, 'gm');
                if (singleRegex.test(content)) {
                    console.log(`    Hollowing out ${item} single in ${fullPath}`);
                    content = content.replace(singleRegex, `${item} = { path = "${namedStubDir}", default-features = false }`);
                    changed = true;
                }
            }

            // 2. STRIP FROM FEATURES & INLINE TABLES: 
            // 2a. Inline tables: dependency = { ..., features = [...] }
            const inlineFeatureRegex = new RegExp(`^(\\s*${item.replace(/-/g, '[\\-]')}\\s*=[^\\n]*?features\\s*=\\s*\\[)[\\s\\S]*?(\\])`, 'gm');
            if (inlineFeatureRegex.test(content)) {
                console.log(`    Stripping inline features for ${item} in ${fullPath}`);
                content = content.replace(inlineFeatureRegex, "$1$2");
                changed = true;
            }

            // 2b. Feature sections: ["item", "item/feature", ...]
            const sections = content.split('\n[');
            let featuresChanged = false;
            for (let i = 0; i < sections.length; i++) {
                const sectionHeader = (i === 0 && content.startsWith('[')) 
                    ? content.slice(1, content.indexOf(']'))
                    : sections[i].split(']')[0];
                
                if (sectionHeader.trim() === 'package') continue;

                const featureRegex = new RegExp(`"${item}(/[^"]*)?"`, 'g');
                if (featureRegex.test(sections[i])) {
                    console.log(`    Stripping ${item} from features list in ${fullPath}`);
                    sections[i] = sections[i].replace(featureRegex, "");
                    featuresChanged = true;
                }
            }
            if (featuresChanged) {
                content = sections.join('\n[');
                content = content.replace(/,\s*,/g, ",");
                content = content.replace(/\[\s*,/g, "[");
                content = content.replace(/,\s*\]/g, "]");
                changed = true;
            }
          }

          // 2. DIRECT PATH STUBBING: Force inject absolute paths
          // Use repoRoot which is global
          const stubs = {
            'blst': path.join(repoRoot, "scripts", "stubs", "blst-wasm-stub"),
            'secp256k1-sys': path.join(repoRoot, "scripts", "stubs", "secp256k1-sys-stub"),
            'errno': path.join(repoRoot, "scripts", "stubs", "errno0314-stub"),
            'zstd': path.join(repoRoot, "scripts", "stubs", "zstd0123-stub"),
            'ring': path.join(repoRoot, "scripts", "stubs", "ring01714-stub"),
            'stacker': path.join(repoRoot, "scripts", "stubs", "stacker-stub"),
            'rustix': path.join(repoRoot, "scripts", "stubs", "rustix03844-stub"),
            'getrandom': path.join(repoRoot, "scripts", "stubs", "getrandom0217-stub"),
          };
          for (const [name, stubPath] of Object.entries(stubs)) {
             // Match: key = ... (single line) OR key = { ... } (multi-line)
             const regex = new RegExp(`^\\s*${name}[\\s\\.]*=\\s*(\\{[\\s\\S]*?\\}|.*$)`, 'gm');
             if (regex.test(content)) {
               content = content.replace(regex, (match) => {
                 const isOptional = match.includes("optional = true");
                 // For direct path injection, if the original match had a version, we might want to preserve compatibility.
                 // But for simplicity, we just point to the path.
                 return `${name} = { path = "${stubPath}"${isOptional ? ", optional = true" : ""} }`;
               });
               changed = true;
             }
          }

          // 3. Standard features patching (proptest, tempfile, arbitrary, tokio)
          if (content.includes("proptest")) {
            content = content.replace(/^(\s*proptest\s*=).*$/gm, (line) => line.includes("optional = true") ? 'proptest = { version = "1.6.0", default-features = false, features = ["std", "bit-set"], optional = true }' : 'proptest = { version = "1.6.0", default-features = false, features = ["std", "bit-set"] }');
            changed = true;
          }
          if (content.includes("tempfile")) {
            content = content.replace(/^(\s*tempfile\s*=).*$/gm, (line) => line.includes("optional = true") ? 'tempfile = { version = "3.20.0", default-features = false, optional = true }' : 'tempfile = { version = "3.20.0", default-features = false }');
            changed = true;
          }
          if (content.includes("tokio")) {
            const regex = new RegExp(`^\\s*tokio(\\s*=(?:\\s*\\{[\\s\\S]*?\\}|.*$))`, 'gm');
            if (regex.test(content)) {
                content = content.replace(regex, (match) => {
                    const isOptional = match.includes("optional = true");
                    return `tokio = { version = "=1.47.1", default-features = false, features = ["sync", "macros", "rt", "io-util", "time"]${isOptional ? ", optional = true" : ""} }`; 
                });
                changed = true;
            }
          }
          if (content.includes("reqwest")) {
            // Force reqwest to use blocking matching the lockfile version pattern roughly, but disable default features (TLS)
            const regex = new RegExp(`^\\s*reqwest(\\s*=(?:\\s*\\{[\\s\\S]*?\\}|.*$))`, 'gm');
            if (regex.test(content)) {
                content = content.replace(regex, (match) => {
                    const isOptional = match.includes("optional = true");
                    // Assuming version 0.12.9 from lockfile
                    return `reqwest = { version = "0.12.9", default-features = false, features = ["json", "blocking"]${isOptional ? ", optional = true" : ""} }`; 
                });
                changed = true;
            }
          }

          if (content.includes("getrandom")) {
            // Force getrandom to 0.2.15 with js feature
            const regex = new RegExp(`^\\s*getrandom(\\s*=(?:\\s*\\{[\\s\\S]*?\\}|.*$))`, 'gm');
            if (regex.test(content)) {
                content = content.replace(regex, (match) => {
                    const isOptional = match.includes("optional = true");
                    return `getrandom = { version = "0.2.15", features = ["js"]${isOptional ? ", optional = true" : ""} }`; 
                });
                changed = true;
            }
          }
          if (changed) { await fs.writeFile(fullPath, content); }
        }
      }
    }
    await patchAllCargoTomls(cloneDir);

    // Also patch vendor directory if it exists (for fastcrypto etc.)
    const vendorDir = path.join(repoRoot, 'vendor');
    if (await dirExists(vendorDir)) {
        console.log("Patching vendor directory...");
        await patchAllCargoTomls(vendorDir);
    }
    await patchAllCargoTomls(crateDir);

    // 5. Build wasm
    // 4. Force cargo to re-evaluate patches by updating lockfile
    console.log("Running cargo update for patches...");
    
    // Helper to find versions in Cargo.lock
    // ... (keep usage of this helper)

    // ... (keep usage of targetPackages loop)

    console.log("Building wasm (cargo build)...");
    
    // Determine SUI and SUI_MOVE versions for the binary
    const suiVersion = SUI_VERSION_TAG;
    const suiMoveVersion = "2024.beta"; // approximated or extracted
    
    const releaseEnv = {
      ...process.env,
      CARGO_PROFILE_RELEASE_LTO: "false", // Faster build, better debug
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16", // Faster parallel build
      CARGO_PROFILE_RELEASE_OPT_LEVEL: "1", // Less optimized, easier to debug
      CARGO_PROFILE_RELEASE_DEBUG: "true", // Include debug info
      // CARGO_PROFILE_RELEASE_PANIC: "abort", // REMOVED to allow unwind/hook
      // CARGO_PROFILE_RELEASE_STRIP: "symbols", // REMOVED to keep legacy symbols
      ZSTD_SYS_ASM_CODE: "0",
      RUSTFLAGS: (process.env.RUSTFLAGS || "") + ' --cfg getrandom_backend="wasm_js" -C link-arg=-zstack-size=33554432', // 32MB stack
      SUI_VERSION: suiVersion,
      SUI_MOVE_VERSION: suiMoveVersion, 
    };

    await run(
      "cargo",
      ["build", "--lib", "--release", "--target", "wasm32-unknown-unknown"],
      { cwd: crateDir, env: releaseEnv }
    );

    // 5.1 Link with wasm-bindgen
    console.log("Linking with wasm-bindgen...");
    const localBin = path.join(repoRoot, "local-bin");
    const wasmBindgenCmd = path.join(localBin, "bin/wasm-bindgen");
    
    // Install if missing
    if (!(await dirExists(wasmBindgenCmd))) {
       console.log("Installing wasm-bindgen-cli v0.2.108...");
       await run("cargo", ["install", "wasm-bindgen-cli", "--version", "0.2.108", "--root", localBin, "--force"], { env: process.env });
    }

    const wasmArtifact = path.join(cloneDir, "target/wasm32-unknown-unknown/release/sui_move_wasm.wasm");
    // distDir defined at top
    
    await run(
        wasmBindgenCmd,
        [wasmArtifact, "--out-dir", distDir, "--target", "web", "--typescript"],
        { cwd: repoRoot }
    );

    // 6. Post-process JS bindings (Fix 'env' and add 'now')
    console.log("Patching generated JS bindings...");
    const jsPath = path.join(distDir, "sui_move_wasm.js");
    let jsContent = await fs.readFile(jsPath, 'utf-8');
    
    // Fix 1: Remove imports from "env" and provide polyfills
    if (jsContent.includes('from "env"')) {
        jsContent = jsContent.replace(
            /import \* as import1 from "env"/g, 
            `const import1 = {
    now: () => Date.now() / 1000,
}; // import * as import1 from "env"`
        );
        await fs.writeFile(jsPath, jsContent);
        console.log("✓ Patched 'env' import and added 'now' polyfill.");
    }

    console.log("\nBuild successful! Artifacts in dist/");
  } catch (error) {
    console.error("Build failed:", error.message);
    process.exit(1);
  }
}

main();
