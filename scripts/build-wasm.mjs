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
const SUI_COMMIT = "1073a8fbf6cfa0d4a4d2bf34b2494a212116089c"; // mainnet-v1.62.1

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
    // 1. Ensure .sui is present and at the right version
    if (!(await dirExists(cloneDir))) {
      console.log(`Cloning Sui at ${SUI_COMMIT}...`);
      await run("git", ["init", cloneDir]);
      await run("git", ["remote", "add", "origin", "https://github.com/MystenLabs/sui.git"], { cwd: cloneDir });
    }

    console.log(`Fetching and checking out ${SUI_COMMIT}...`);
    await run("git", ["fetch", "--depth", "1", "origin", SUI_COMMIT], { cwd: cloneDir });
    await run("git", ["reset", "--hard", SUI_COMMIT], { cwd: cloneDir });
    
    // Ensure submodules (Move sources) are present
    console.log("Updating submodules...");
    await run("git", ["submodule", "update", "--init", "--recursive"], { cwd: cloneDir });

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
    cargoContent = cargoContent.replace(/path = "vendor\/move\//g, 'path = "../../external-crates/move/');
    
    // Note: overrides/ folder is copied into the crate, so we keep its relative paths as is.

    await fs.writeFile(cargoTomlPath, cargoContent);

    // 4. Register in Sui workspace and pin problematic dependencies
    const workspaceTomls = [
      path.join(cloneDir, "Cargo.toml"),
      path.join(cloneDir, "external-crates", "move", "Cargo.toml")
    ];

    for (const workspaceToml of workspaceTomls) {
      if (!(await dirExists(workspaceToml))) continue;
      
      console.log(`Patching workspace at ${workspaceToml}...`);
      let workspaceContent = await fs.readFile(workspaceToml, "utf8");
      
      if (workspaceToml.includes('.sui/Cargo.toml') && !workspaceContent.includes('"crates/sui-move-wasm"')) {
        console.log("Registering crate in Sui root workspace...");
        workspaceContent = workspaceContent.replace(
          'members = [',
          'members = [\n    "crates/sui-move-wasm",'
        );
      }
      
      // Pin dependencies to avoid pulling incompatible versions (like getrandom 0.3.4)
      workspaceContent = workspaceContent.replace(/proptest = "1\.6\.0"/g, 'proptest = "=1.6.0"');
      workspaceContent = workspaceContent.replace(/rand = "0\.8\.[0-9]"/g, 'rand = "=0.8.5"');
      workspaceContent = workspaceContent.replace(/insta = { version = "1\.[0-9.]+"/g, (match) => match.includes('1.21.1') ? 'insta = { version = "=1.21.1"' : 'insta = { version = "=1.42.0"');
      workspaceContent = workspaceContent.replace(/tempfile = "3\.[0-9.]+"/g, 'tempfile = "=3.2.0"');
      
      // Add patch for getrandom to force 0.3.3 if 0.3 is required
      const patchHeader = '[patch.crates-io]';
      const getrandomPatch = 'getrandom = { git = "https://github.com/rust-random/getrandom", rev = "e51381c" }';
      
      if (workspaceContent.includes(patchHeader)) {
        if (!workspaceContent.includes('getrandom = { git =')) {
          workspaceContent = workspaceContent.replace(patchHeader, `${patchHeader}\n${getrandomPatch}`);
        }
      } else {
        workspaceContent += `\n${patchHeader}\n${getrandomPatch}\n`;
      }
      
      await fs.writeFile(workspaceToml, workspaceContent);
    }

    // 4.1 Patch specific Move crates that pull incompatible dependencies for WASM
    const problematicCrate = path.join(cloneDir, "external-crates", "move", "crates", "move-regex-borrow-graph", "Cargo.toml");
    if (await dirExists(problematicCrate)) {
      console.log("Patching move-regex-borrow-graph to remove proptest from main dependencies...");
      let content = await fs.readFile(problematicCrate, "utf8");
      // Move proptest to dev-dependencies if not already there
      if (content.includes('proptest.workspace = true') && !content.includes('[dev-dependencies]')) {
        content = content.replace('proptest.workspace = true', '');
        content += '\n[dev-dependencies]\nproptest.workspace = true\n';
        await fs.writeFile(problematicCrate, content);
      } else if (content.includes('proptest.workspace = true')) {
        // If it's in dependencies but [dev-dependencies] exists elsewhere, just remove it from main
        // (Simple regex to remove it from [dependencies] block)
        content = content.replace(/proptest\.workspace = true\n/g, '');
        if (!content.includes('proptest.workspace = true')) {
          content += '\n[dev-dependencies]\nproptest.workspace = true\n';
        }
        await fs.writeFile(problematicCrate, content);
      }
    }

    // 5. Build wasm
    console.log("Building wasm with wasm-pack...");
    const releaseEnv = {
      ...process.env,
      CARGO_PROFILE_RELEASE_LTO: "true",
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
      CARGO_PROFILE_RELEASE_OPT_LEVEL: "z",
      CARGO_PROFILE_RELEASE_PANIC: "abort",
      CARGO_PROFILE_RELEASE_STRIP: "symbols",
    };
    
    await run(
      "wasm-pack",
      ["build", ".", "--target", "web", "--out-dir", "pkg", "--release"],
      { cwd: crateDir, env: releaseEnv }
    );

    // 6. Copy artifacts back
    const pkgDir = path.join(crateDir, "pkg");
    const distDir = path.join(repoRoot, "dist");
    await fs.mkdir(distDir, { recursive: true });
    
    const filesToCopy = [
      "sui_move_wasm.js",
      "sui_move_wasm_bg.wasm",
      "sui_move_wasm_bg.wasm.d.ts",
      "sui_move_wasm.d.ts"
    ];

    for (const file of filesToCopy) {
      const src = path.join(pkgDir, file);
      const dest = path.join(distDir, file);
      try {
        await fs.copyFile(src, dest);
        console.log(`Copied ${file} to dist/`);
      } catch (err) {
        if (file.endsWith(".d.ts")) continue; // Optional
        throw err;
      }
    }

    console.log("\nBuild successful!");
  } catch (error) {
    console.error("Build failed:", error.message);
    process.exit(1);
  }
}

main();
