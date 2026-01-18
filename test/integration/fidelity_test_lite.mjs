import { buildMovePackage, initMoveCompiler } from "../../dist/lite/index.js";
import { promises as fs } from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const JSON_DIR = path.join(__dirname, "json");

const REPOS = {
  nautilus: {
    url: "https://github.com/MystenLabs/nautilus",
    commit: "d919402aadf15e21b3cf31515b3a46d1ca6965e4",
    packagePath: "move/enclave",
    goldenFile: "nautilus.enclave.json",
    network: "mainnet",
  },
  apps: {
    url: "https://github.com/MystenLabs/apps",
    commit: "e159ab3fc45a6f1ca46025c46c915988023af8b6",
    packagePath: "kiosk",
    goldenFile: "app.kiosk.json",
    network: "mainnet",
  },
};

async function setupRepo(name, config) {
  const repoDir = path.join(FIXTURES_DIR, name);
  if (await fs.stat(repoDir).catch(() => false)) {
    console.log(`[Setup] ${name} exists.`);
    // Hack for Nautilus: user wants 0x0 address, so hide Move.lock if present
    if (name === "nautilus") {
      const moveLockInfo = path.join(repoDir, config.packagePath, "Move.lock");
      const moveLockBackup = path.join(
        repoDir,
        config.packagePath,
        "Move.lock.bak"
      );
      try {
        await fs.rename(moveLockInfo, moveLockBackup);
      } catch (e) {}
    }
    return path.join(repoDir, config.packagePath);
  }

  console.log(`[Setup] Cloning ${name}...`);
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
  execSync(`git clone ${config.url} ${repoDir}`, { stdio: "inherit" });
  execSync(`git checkout ${config.commit}`, { cwd: repoDir, stdio: "inherit" });

  return path.join(repoDir, config.packagePath);
}

// Compare byte arrays or hex strings
function areDigestsEqual(digestA, digestB) {
  // Convert both to array of numbers if possible, or hex strings
  const normalize = (d) => {
    if (Array.isArray(d)) return Buffer.from(d).toString("hex");
    if (d instanceof Uint8Array) return Buffer.from(d).toString("hex");
    return d; // assume hex string
  };
  return normalize(digestA) === normalize(digestB);
}

async function runTest() {
  const wasmPath = path.resolve(
    __dirname,
    "../../dist/lite/sui_move_wasm_bg.wasm"
  );
  const wasmBuffer = await fs.readFile(wasmPath);
  await initMoveCompiler({ wasm: wasmBuffer });

  let allPass = true;

  for (const [name, config] of Object.entries(REPOS)) {
    console.log(`\n=== Testing ${name} ===`);
    const packageDir = await setupRepo(name, config);

    // Read Move.toml and files
    const projectFiles = {};
    async function readDirRecursive(dir, base) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(base, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "build" || entry.name === ".git") continue;
          await readDirRecursive(fullPath, relPath);
        } else if (entry.isFile()) {
          if (
            entry.name.endsWith(".move") ||
            entry.name === "Move.toml" ||
            entry.name === "Move.lock"
          ) {
            projectFiles[relPath] = await fs.readFile(fullPath, "utf-8");
          }
        }
      }
    }

    await readDirRecursive(packageDir, ".");

    console.log(
      `[Build] Compiling ${Object.keys(projectFiles).length} files from ${config.packagePath}...`
    );

    try {
      // Logic handled by builder now

      const result = await buildMovePackage({
        files: projectFiles,
        network: config.network,
      });

      if ("error" in result) {
        console.error(`[Error] Build failed with error:`, result.error);
        allPass = false;
        continue;
      }

      // Load Golden
      const goldenPath = path.join(JSON_DIR, config.goldenFile);
      const golden = JSON.parse(await fs.readFile(goldenPath, "utf-8"));

      // Compare Digest
      const digestMatch = areDigestsEqual(result.digest, golden.digest);
      console.log(`Digest Match: ${digestMatch ? "✅" : "❌"}`);
      if (!digestMatch) {
        console.log(`  Expected: ${golden.digest}`);
        console.log(`  Actual:   ${result.digest}`);
        allPass = false;
      }

      // Compare Modules Count
      if (result.modules.length !== golden.modules.length) {
        console.log(
          `Module Count Match: ❌ (Got ${result.modules.length}, Expected ${golden.modules.length})`
        );
        allPass = false;
      } else {
        console.log(`Module Count Match: ✅`);
      }

      // Deep Compare Modules (Base64)
      let modulesMatch = true;
      for (let i = 0; i < golden.modules.length; i++) {
        if (result.modules[i] !== golden.modules[i]) {
          console.log(`  Module ${i} mismatch!`);

          const actualBuf = Buffer.from(result.modules[i], "base64");
          const expectedBuf = Buffer.from(golden.modules[i], "base64");

          console.log(
            `    Size: Expected ${expectedBuf.length} bytes, Actual ${actualBuf.length} bytes`
          );

          // Find first difference
          const mismatchIdx = expectedBuf.findIndex(
            (b, i) => b !== actualBuf[i]
          );
          if (mismatchIdx !== -1) {
            console.log(`    First mismatch at byte offset: ${mismatchIdx}`);
            const start = Math.max(0, mismatchIdx - 10);
            const end = Math.min(expectedBuf.length, mismatchIdx + 10);
            console.log(
              `      Expected: 0x${expectedBuf.subarray(start, end).toString("hex")}`
            );
            console.log(
              `      Actual:   0x${actualBuf.subarray(start, end).toString("hex")}`
            );
            modulesMatch = false;
          }
        }
      }
      console.log(`Modules Content Match: ${modulesMatch ? "✅" : "❌"}`);
      if (!modulesMatch) allPass = false;
    } catch (e) {
      console.error(`[Error] Build failed:`, e);
      allPass = false;
    }
  }

  if (!allPass) {
    console.error("\n❌ Some fidelity tests failed.");
    process.exit(1);
  } else {
    console.log("\n✅ All fidelity tests passed!");
  }
}

runTest();
