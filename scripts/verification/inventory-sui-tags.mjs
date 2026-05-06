import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { SUI_REPO_URL } from "../sui-workspace.mjs";
import { getRepoRoot } from "./bytecode-verifier-manifest.mjs";

function parseArgs(argv) {
  const options = {
    repo: SUI_REPO_URL,
    stdout: false,
    output: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stdout") {
      options.stdout = true;
    } else if (arg === "--repo") {
      options.repo = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--repo=")) {
      options.repo = arg.slice("--repo=".length);
    } else if (arg === "--output") {
      options.output = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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

function lsRemoteTags(repo) {
  const result = spawnSync("git", ["ls-remote", "--tags", repo], {
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `git ls-remote failed for ${repo}: ${(result.stderr || "").trim()}`
    );
  }
  return result.stdout;
}

function classifyTag(tag) {
  const network = tag.match(
    /^(mainnet|testnet|devnet)-v(\d+\.\d+\.\d+(?:[-.\w]*)?)$/
  );
  if (network) {
    return { kind: network[1], network: network[1], version: network[2] };
  }
  const release = tag.match(/^sui_v(\d+\.\d+\.\d+)_.*_release$/);
  if (release) {
    return { kind: "release", version: release[1] };
  }
  return undefined;
}

function versionParts(version) {
  const [core, suffix = ""] = version.split("-", 2);
  const parts = core.split(".").map((item) => Number.parseInt(item, 10));
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    suffix,
  };
}

function compareTags(left, right) {
  const a = versionParts(left.version);
  const b = versionParts(right.version);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (left.kind !== right.kind) {
    const kindOrder = new Map([
      ["mainnet", 0],
      ["testnet", 1],
      ["devnet", 2],
      ["release", 3],
    ]);
    return (
      (kindOrder.get(left.kind) ?? Number.MAX_SAFE_INTEGER) -
      (kindOrder.get(right.kind) ?? Number.MAX_SAFE_INTEGER)
    );
  }
  return left.tag.localeCompare(right.tag);
}

function parseTagInventory(output) {
  const tagMap = new Map();
  for (const line of output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    const [commit, ref] = line.split(/\s+/, 2);
    const peeled = ref?.endsWith("^{}") ?? false;
    const tag = ref?.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    if (!commit || !tag) continue;
    const classified = classifyTag(tag);
    if (!classified) continue;
    const previous = tagMap.get(tag);
    if (!previous || peeled) {
      tagMap.set(tag, {
        tag,
        commit,
        annotatedTagObject: peeled ? previous?.commit : undefined,
        ...classified,
      });
    }
  }

  return [...tagMap.values()].sort(compareTags);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = getRepoRoot();
  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(
        repoRoot,
        ".sui-build",
        "bytecode-verifiers",
        "inventory",
        "sui-tags.json"
      );

  const tags = parseTagInventory(lsRemoteTags(options.repo));
  const inventory = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: options.repo,
    tagCount: tags.length,
    tags,
  };
  const json = JSON.stringify(inventory, null, 2) + "\n";

  if (options.stdout) {
    process.stdout.write(json);
  } else {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, json);
    console.log(`Wrote ${tags.length} Sui release tags to ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
