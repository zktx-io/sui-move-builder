import { buildMovePackage, initMoveCompiler } from "../../dist/lite/index.js";
import { promises as fs } from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

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
  // Note: deeptrade might be too heavy for lite or we can include it if desired.
  // Sticking to existing scope of lite test which was just nautilus + apps usually.
  // But for consistency I'll include it if it was there (it wasn't in the original view).
  // Actually, checking previous view, REPOS only had nautilus and apps. I will keep it that way for lite.
};

async function setupRepo(name, config) {
  const repoDir = path.join(FIXTURES_DIR, name);
  if (await fs.stat(repoDir).catch(() => false)) {
    return path.join(repoDir, config.packagePath);
  }
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
  execSync(`git clone ${config.url} ${repoDir}`, { stdio: "inherit" });
  execSync(`git checkout ${config.commit}`, { cwd: repoDir, stdio: "inherit" });
  return path.join(repoDir, config.packagePath);
}

function areDigestsEqual(digestA, digestB) {
  const normalize = (d) => {
    if (Array.isArray(d)) return Buffer.from(d).toString("hex");
    if (d instanceof Uint8Array) return Buffer.from(d).toString("hex");
    return d;
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
    const rootFiles = {};

    async function readDirRecursive(dir, baseDir = dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);
        if (entry.isDirectory()) {
          if (entry.name === "build" || entry.name === ".git") continue;
          await readDirRecursive(fullPath, baseDir);
        } else {
          if (
            entry.name.endsWith(".move") ||
            entry.name.endsWith(".toml") ||
            entry.name.endsWith(".lock")
          ) {
            rootFiles[relativePath] = await fs.readFile(fullPath, "utf-8");
          }
        }
      }
    }

    await readDirRecursive(packageDir);
    console.log(`[Build] Compiling ${Object.keys(rootFiles).length} files...`);

    try {
      const result = await buildMovePackage({
        files: rootFiles,
        network: config.network,
      });

      if ("error" in result) {
        console.error(`[Error] Build failed:`, result.error);
        allPass = false;
        continue;
      }

      const golden = JSON.parse(
        await fs.readFile(path.join(JSON_DIR, config.goldenFile), "utf-8")
      );

      // Compare Digest
      if (golden.digest) {
        const digestMatch = areDigestsEqual(result.digest, golden.digest);
        console.log(`Digest Match: ${digestMatch ? "✅" : "❌"}`);
        if (!digestMatch) {
          console.log(
            `  Expected: ${golden.digest}\n  Actual:   ${result.digest}`
          );
          allPass = false;
        }
      }

      // Compare Modules
      if (result.modules.length !== golden.modules.length) {
        console.log(
          `Module Count: ❌ (Got ${result.modules.length}, Expected ${golden.modules.length})`
        );
        allPass = false;
      } else {
        console.log(`Module Count: ✅`);
        // Lite build might not produce bit-for-bit identical modules (stripped),
        // so we might relax strict content check if intended.
        // But for now, we follow the pattern: check and report.
        let modulesMatch = true;
        for (let i = 0; i < golden.modules.length; i++) {
          if (result.modules[i] !== golden.modules[i]) {
            // In Lite build, we might expect differences if golden is from full build?
            // Actually, if we want strict parity, they should match.
            // If mismatch is expected due to stripping, we might need different goldens for lite.
            // For now, let's report it.
            console.log(`  Module ${i} content mismatch!`);
            modulesMatch = false;
          }
        }
        console.log(`Modules Content: ${modulesMatch ? "✅" : "❌"}`);
        if (!modulesMatch) allPass = false;
      }
    } catch (e) {
      console.error(`[Error] Execution failed:`, e);
      allPass = false;
    }
  }

  if (!allPass) {
    console.error("\n❌ Fidelity tests failed.");
    process.exit(1);
  } else {
    console.log("\n✅ Fidelity tests passed!");
  }
}

runTest();
