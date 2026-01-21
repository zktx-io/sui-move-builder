import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// usage: node fidelity_test.mjs [full|lite]
const MODE = process.argv[2] === "lite" ? "lite" : "full";
const DIST_DIR = path.resolve(__dirname, `../../dist/${MODE}`);

console.log(`Running Fidelity Tests in [${MODE.toUpperCase()}] mode`);

// Dynamic import from the correct distribution
const { initMoveCompiler, buildMovePackage, fetchPackageFromGitHub } =
  await import(path.join(DIST_DIR, "index.js"));

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
  deepbook: {
    url: "https://github.com/MystenLabs/deepbookv3",
    commit: "d3206b717c6f63593fae14d1ff9e1ec055f051bd",
    packagePath: "packages/deepbook",
    goldenFile: "deepbook.core.json",
    network: "mainnet",
  },
  deeptrade: {
    url: "https://github.com/DeeptradeProtocol/deeptrade-core",
    commit: "7838028ef9edf72f7dc82dc788ba06cd94ebdd9c",
    packagePath: "packages/deeptrade-core",
    goldenFile: "deeptrade.core.json",
    network: "mainnet",
  },
};

function areDigestsEqual(digestA, digestB) {
  const normalize = (d) => {
    if (Array.isArray(d)) return Buffer.from(d).toString("hex");
    if (d instanceof Uint8Array) return Buffer.from(d).toString("hex");
    return d;
  };
  return normalize(digestA) === normalize(digestB);
}

// Read GitHub token from file if exists
async function getGithubToken() {
  try {
    const tokenPath = path.join(__dirname, "../../test/.github_token");
    if (await fs.stat(tokenPath).catch(() => false)) {
      return (await fs.readFile(tokenPath, "utf-8")).trim();
    }
  } catch (e) {
    // Ignore if token file doesn't exist
  }
  return process.env.GITHUB_TOKEN;
}

// Setup repo: check if cached in fixtures, if not fetch via packageFetcher and save
async function setupRepo(name, config, githubToken) {
  const packageDir = path.join(FIXTURES_DIR, name, config.packagePath);
  const moveTomlPath = path.join(packageDir, "Move.toml");

  // Check if already cached
  if (await fs.stat(moveTomlPath).catch(() => false)) {
    console.log(`[Cache] Using cached fixtures for ${name}`);
    return await readLocalFiles(packageDir);
  }

  // Fetch via packageFetcher
  console.log(`[Fetch] Downloading ${name} via GitHub API...`);
  const githubUrl = `${config.url}/tree/${config.commit}/${config.packagePath}`;
  const files = await fetchPackageFromGitHub(githubUrl, {
    githubToken,
    includeLock: true,
  });

  // Save to fixtures for future runs
  await fs.mkdir(packageDir, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(packageDir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }
  console.log(`[Cache] Saved ${Object.keys(files).length} files to fixtures`);

  return files;
}

// Read local files from directory
async function readLocalFiles(dir) {
  const files = {};

  async function readDirRecursive(currentDir, baseDir = currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
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
          files[relativePath] = await fs.readFile(fullPath, "utf-8");
        }
      }
    }
  }

  await readDirRecursive(dir);
  return files;
}

async function runTest() {
  console.log("Initializing compiler...");
  const start = performance.now();
  const wasmPath = path.resolve(DIST_DIR, "sui_move_wasm_bg.wasm");
  const wasmBuffer = await fs.readFile(wasmPath);

  const githubToken = await getGithubToken();
  await initMoveCompiler({ wasm: wasmBuffer, token: githubToken });
  console.log(
    `Compiler initialized in ${(performance.now() - start).toFixed(2)}ms`
  );

  let allPass = true;

  for (const [name, config] of Object.entries(REPOS)) {
    console.log(`\n=== Testing ${name} ===`);

    const rootFiles = await setupRepo(name, config, githubToken);
    console.log(`[Build] Compiling ${Object.keys(rootFiles).length} files...`);

    try {
      const result = await buildMovePackage({
        files: rootFiles,
        network: config.network,
        githubToken,
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
      // Compare Digest
      // if (golden.digest) {
      //   if (!areDigestsEqual(result.digest, golden.digest)) {
      //     console.log(
      //       `Digest Match: ❌\n  Expected: ${golden.digest}\n  Actual:   ${result.digest}`
      //     );
      //     allPass = false;
      //   } else {
      //     console.log("Digest Match: ✅");
      //   }
      // }

      // Compare Dependencies
      if (golden.dependencies) {
        const expectedCount = golden.dependencies.length;
        const actualCount = result.dependencies.length;

        if (expectedCount === actualCount) {
          // Strict Order Check: Do NOT sort
          const expected = golden.dependencies;
          const actual = result.dependencies;
          let match = true;
          for (let i = 0; i < expected.length; i++) {
            if (expected[i] !== actual[i]) {
              match = false;
              // console.log(
              //   `  Dependency [${i}] mismatch: Expected ${expected[i]}, Got ${actual[i]}`
              // );
            }
          }

          if (match) {
            console.log(`Dependencies Count & Content: ✅`);
          } else {
            console.log(`Dependencies Content: ❌ (Order/Value mismatch)`);
            allPass = false;
          }
        } else {
          console.log(
            `Dependencies Count: ❌ (Got ${actualCount}, Expected ${expectedCount})`
          );
          allPass = false;
          // Log arrays for debugging
          // console.log("  Expected:", golden.dependencies);
          // console.log("  Actual:", result.dependencies);
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

        // Log all module names to check if Pyth is bundled
        // Since we don't have a full move disassembler, we rely on the fact that
        // parity_test result.modules contains compiled bytecode.
        // We can't easily parse it here without a tool.
        // But we can check the length.
        // Golden modules length: 17. Result: 17?
        // If result has > 17, then Pyth is bundled.
        if (result.modules.length > golden.modules.length) {
          console.log(
            `  WARNING: Result has more modules (${result.modules.length}) than Golden (${golden.modules.length}). Dependencies might be bundled!`
          );
        }

        let modulesMatch = true;
        for (let i = 0; i < golden.modules.length; i++) {
          if (result.modules[i] !== golden.modules[i]) {
            modulesMatch = false;
            const actualBuf = Buffer.from(result.modules[i], "base64");
            const expectedBuf = Buffer.from(golden.modules[i], "base64");

            if (actualBuf.length !== expectedBuf.length) {
              console.log(
                `  Module ${i} mismatch: Content differs (Length mismatch: Got ${actualBuf.length}, Expected ${expectedBuf.length})`
              );
            } else {
              let diffCount = 0;
              let diffRanges = [];
              let currentRange = null;

              for (let j = 0; j < actualBuf.length; j++) {
                if (actualBuf[j] !== expectedBuf[j]) {
                  diffCount++;
                  if (!currentRange) {
                    currentRange = { start: j, length: 1 };
                  } else if (j === currentRange.start + currentRange.length) {
                    currentRange.length++;
                  } else {
                    diffRanges.push(currentRange);
                    currentRange = { start: j, length: 1 };
                  }
                } else {
                  if (currentRange) {
                    diffRanges.push(currentRange);
                    currentRange = null;
                  }
                }
              }
              if (currentRange) diffRanges.push(currentRange);

              // console.log(`  Module ${i} mismatch: Content differs (Length matches: ${actualBuf.length})`);
              // console.log(`    Total differing bytes: ${diffCount}`);
              // console.log(`    Diff ranges (Start - Length):`);
              // diffRanges.forEach(r => console.log(`      Offset ${r.start}: ${r.length} bytes`));
            }
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
