import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const cloneDir = path.join(repoRoot, ".sui");
const localWasmCrate = path.join(repoRoot, "sui-move-wasm");

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

async function main() {
  // Fresh clone into .sui so crate path is .sui/crates/sui-move-wasm.
  await fs.rm(cloneDir, { recursive: true, force: true });

  try {
    console.log("Cloning Sui...");
    await run("git", [
      "clone",
      "--depth",
      "1",
      "https://github.com/MystenLabs/sui.git",
      cloneDir,
    ]);
    // Bring in Move sources required for build.
    await run("git", ["submodule", "update", "--init", "--recursive"], {
      cwd: cloneDir,
    });

    // Copy our local crate into the cloned workspace.
    const cratePath = path.join(cloneDir, "crates", "sui-move-wasm");
    await fs.rm(cratePath, { recursive: true, force: true });
    await fs.cp(localWasmCrate, cratePath, { recursive: true });

    // Ensure the workspace knows about it.
    const workspaceToml = path.join(cloneDir, "Cargo.toml");
    let cargoToml = await fs.readFile(workspaceToml, "utf8");
    const membersHeader = "members = [";
    const idx = cargoToml.indexOf(membersHeader);
    if (idx !== -1 && !cargoToml.includes('"crates/sui-move-wasm"')) {
      const insertAt = idx + membersHeader.length;
      cargoToml =
        cargoToml.slice(0, insertAt) +
        '\n  "crates/sui-move-wasm",' +
        cargoToml.slice(insertAt);
      await fs.writeFile(workspaceToml, cargoToml);
    }

    try {
      await fs.access(path.join(cratePath, "Cargo.toml"));
    } catch {
      throw new Error(
        `Expected crate at ${cratePath} but Cargo.toml is missing. Check the Sui branch/ref.`
      );
    }

    // Step 1: generate lockfile (run from crate dir so workspace root is .sui)
    console.log("Generating Cargo.lock...");
    await run("cargo", ["generate-lockfile"], { cwd: cratePath });

    // Step 2: wasm-pack build (from crate dir)
    console.log("Building wasm with wasm-pack...");
    await run(
      "wasm-pack",
      ["build", ".", "--target", "web", "--out-dir", "pkg"],
      { cwd: cratePath }
    );

    // Step 3: copy artifacts to dist
    const pkgDir = path.join(cratePath, "pkg");
    const distDir = path.join(repoRoot, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const requiredFiles = ["sui_move_wasm.js", "sui_move_wasm_bg.wasm"];
    const optionalFiles = ["sui_move_wasm_bg.wasm.d.ts", "sui_move_wasm.d.ts"];

    for (const file of [...requiredFiles, ...optionalFiles]) {
      const from = path.join(pkgDir, file);
      const to = path.join(distDir, file);
      await fs.rm(to, { force: true });
      try {
        await fs.copyFile(from, to);
      } catch {
        if (optionalFiles.includes(file)) continue;
        throw new Error(
          `Expected ${from} but it was not produced by wasm-pack`
        );
      }
    }
    console.log(`Copied wasm artifacts to ${distDir}`);
  } finally {
    if (!process.env.SUI_KEEP_TEMP) {
      await fs.rm(cloneDir, { recursive: true, force: true });
    } else {
      console.log(`Temp kept at ${cloneDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
