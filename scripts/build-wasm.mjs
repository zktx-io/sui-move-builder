import path from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./sui-workspace.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const args = process.argv.slice(2);

async function main() {
  try {
    await run(
      process.execPath,
      [path.join(scriptDir, "prepare-wasm.mjs"), ...args],
      {
        cwd: repoRoot,
        env: process.env,
      }
    );
    await run(
      process.execPath,
      [
        path.join(scriptDir, "build-prepared-wasm.mjs"),
        "--profile",
        "all",
        ...args,
      ],
      { cwd: repoRoot, env: process.env }
    );
  } catch (error) {
    console.error("Build failed:", error.message);
    process.exit(1);
  }
}

main();
