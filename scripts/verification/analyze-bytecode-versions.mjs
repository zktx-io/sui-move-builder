import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SUI_REPO_URL } from "../sui-workspace.mjs";
import { getRepoRoot } from "./bytecode-verifier-manifest.mjs";

const MOVE_BINARY_FORMAT_PATHS = [
  "external-crates/move/crates/move-binary-format/src",
  "external-crates/move/move-binary-format/src",
];

const SOURCE_FILE_GROUPS = [
  {
    id: "moveBinaryFormatCommon",
    candidates: MOVE_BINARY_FORMAT_PATHS.map(
      (base) => `${base}/file_format_common.rs`
    ),
    legacyMoveCandidate:
      "language/move-binary-format/src/file_format_common.rs",
  },
  {
    id: "serializer",
    candidates: MOVE_BINARY_FORMAT_PATHS.map((base) => `${base}/serializer.rs`),
    legacyMoveCandidate: "language/move-binary-format/src/serializer.rs",
  },
  {
    id: "deserializer",
    candidates: MOVE_BINARY_FORMAT_PATHS.map(
      (base) => `${base}/deserializer.rs`
    ),
    legacyMoveCandidate: "language/move-binary-format/src/deserializer.rs",
  },
  {
    id: "protocolConfig",
    candidates: ["crates/sui-protocol-config/src/lib.rs"],
  },
  {
    id: "moveCompilerEditions",
    candidates: [
      "external-crates/move/crates/move-compiler/src/editions/mod.rs",
      "external-crates/move/move-compiler/src/editions/mod.rs",
    ],
    legacyMoveCandidate: "language/move-compiler/src/editions/mod.rs",
  },
];

function parseArgs(argv) {
  const repoRoot = getRepoRoot();
  const options = {
    repo: SUI_REPO_URL,
    inventory: path.join(
      repoRoot,
      ".sui-build",
      "bytecode-verifiers",
      "inventory",
      "sui-tags.json"
    ),
    output: path.join(
      repoRoot,
      ".sui-build",
      "bytecode-verifiers",
      "inventory",
      "sui-bytecode-version-signals.json"
    ),
    cacheDir: path.join(
      repoRoot,
      ".sui-build",
      "bytecode-verifiers",
      "inventory",
      "source-files"
    ),
    kind: "mainnet",
    limit: undefined,
    refreshCache: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      options.repo = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--repo=")) {
      options.repo = arg.slice("--repo=".length);
    } else if (arg === "--inventory") {
      options.inventory = path.resolve(readValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith("--inventory=")) {
      options.inventory = path.resolve(arg.slice("--inventory=".length));
    } else if (arg === "--output") {
      options.output = path.resolve(readValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith("--output=")) {
      options.output = path.resolve(arg.slice("--output=".length));
    } else if (arg === "--cache-dir") {
      options.cacheDir = path.resolve(readValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith("--cache-dir=")) {
      options.cacheDir = path.resolve(arg.slice("--cache-dir=".length));
    } else if (arg === "--kind") {
      options.kind = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--kind=")) {
      options.kind = arg.slice("--kind=".length);
    } else if (arg === "--limit") {
      options.limit = Number.parseInt(readValue(argv, index, arg), 10);
      index += 1;
    } else if (arg.startsWith("--limit=")) {
      options.limit = Number.parseInt(arg.slice("--limit=".length), 10);
    } else if (arg === "--refresh-cache") {
      options.refreshCache = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (
    !["mainnet", "testnet", "devnet", "release", "network", "all"].includes(
      options.kind
    )
  ) {
    throw new Error(
      "--kind must be mainnet, testnet, devnet, release, network, or all"
    );
  }
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1)
  ) {
    throw new Error("--limit must be a positive integer");
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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function selectTags(tags, kind, limit) {
  const selected = tags.filter((tag) => {
    if (kind === "all") return true;
    if (kind === "network") return Boolean(tag.network);
    return tag.kind === kind;
  });
  return limit === undefined ? selected : selected.slice(0, limit);
}

function cachePath(cacheDir, commit, sourceFile) {
  return path.join(cacheDir, commit, sourceFile);
}

async function readCached(cacheDir, commit, sourceFile) {
  try {
    return await fs.readFile(cachePath(cacheDir, commit, sourceFile), "utf8");
  } catch {
    return undefined;
  }
}

async function writeCached(cacheDir, commit, sourceFile, text) {
  const filePath = cachePath(cacheDir, commit, sourceFile);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
}

function rawBaseUrl(repo) {
  if (repo === SUI_REPO_URL || repo === "https://github.com/MystenLabs/sui") {
    return "https://raw.githubusercontent.com/MystenLabs/sui";
  }
  const match = repo.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/
  );
  if (!match) {
    throw new Error(
      `Cannot derive raw GitHub URL from ${repo}; pass the default Sui GitHub repo or extend the analyzer`
    );
  }
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}`;
}

async function fetchSourceFile(options, tag, sourceFile) {
  if (!options.refreshCache) {
    const cached = await readCached(options.cacheDir, tag.commit, sourceFile);
    if (cached !== undefined) return { ok: true, text: cached, cached: true };
  }

  const url = `${rawBaseUrl(options.repo)}/${tag.commit}/${sourceFile}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "sui-move-builder-bytecode-version-analyzer",
    },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: `${response.status} ${response.statusText}`,
      url,
    };
  }
  const text = await response.text();
  await writeCached(options.cacheDir, tag.commit, sourceFile, text);
  return { ok: true, text, cached: false };
}

async function fetchPinnedMoveDependency(options, tag) {
  for (const sourceFile of ["Cargo.lock", "sui/Cargo.toml", "Cargo.toml"]) {
    const result = await fetchSourceFile(options, tag, sourceFile);
    if (!result.ok) continue;
    const dependency = result.text.match(
      /github\.com\/([^/\s]+\/move)\?rev=([0-9a-f]{40})/i
    );
    if (dependency) {
      return {
        ownerRepo: dependency[1],
        repo: `https://github.com/${dependency[1]}`,
        rev: dependency[2],
        pinnedBy: sourceFile,
      };
    }
  }
  return undefined;
}

async function fetchPinnedMoveSourceFile(options, dependency, sourceFile) {
  if (!options.refreshCache) {
    const cached = await readCached(
      options.cacheDir,
      dependency.rev,
      sourceFile
    );
    if (cached !== undefined) return { ok: true, text: cached, cached: true };
  }

  const url = `https://raw.githubusercontent.com/${dependency.ownerRepo}/${dependency.rev}/${sourceFile}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "sui-move-builder-bytecode-version-analyzer",
    },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: `${response.status} ${response.statusText}`,
      url,
    };
  }
  const text = await response.text();
  await writeCached(options.cacheDir, dependency.rev, sourceFile, text);
  return { ok: true, text, cached: false };
}

async function fetchSourceGroup(options, tag, group) {
  const attempts = [];
  for (const sourceFile of group.candidates) {
    const result = await fetchSourceFile(options, tag, sourceFile);
    if (result.ok) return { ...result, sourceFile };
    attempts.push({ sourceFile, error: result.error, url: result.url });
  }
  return { ok: false, attempts };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function parseMoveBinaryFormat(text) {
  const constants = new Map();
  for (const match of text.matchAll(/pub const VERSION_(\d+): u32 = (\d+);/g)) {
    constants.set(`VERSION_${match[1]}`, Number.parseInt(match[2], 10));
  }
  return {
    versionMin: resolveVersionConst(text, constants, "VERSION_MIN"),
    versionMax: resolveVersionConst(text, constants, "VERSION_MAX"),
    tableTypeHash: sha256(
      (text.match(/pub enum TableType[\s\S]*?\n}/)?.[0] ?? "").trim()
    ),
  };
}

function resolveVersionConst(text, constants, name) {
  const direct = text.match(new RegExp(`pub const ${name}: u32 = (\\d+);`));
  if (direct) return Number.parseInt(direct[1], 10);
  const indirect = text.match(
    new RegExp(`pub const ${name}: u32 = (VERSION_\\d+);`)
  );
  if (indirect) return constants.get(indirect[1]) ?? null;
  return null;
}

function parseSerializer(text) {
  return {
    encodesBinaryFlavor: text.includes("BinaryFlavor::encode_version"),
    jumpTablesVersionGate:
      /jump_tables[\s\S]{0,240}VERSION_7/.test(text) ||
      /VERSION_7[\s\S]{0,240}jump_tables/.test(text),
    functionDefinitionHash: sha256(
      (
        text.match(/fn serialize_function_definition[\s\S]*?\n}\n/)?.[0] ??
        text.match(/serialize_jump_tables[\s\S]*?\n}\n/)?.[0] ??
        ""
      ).trim()
    ),
  };
}

function parseDeserializer(text) {
  return {
    jumpTablesVersionGate:
      /jump_tables[\s\S]{0,240}VERSION_7/.test(text) ||
      /VERSION_7[\s\S]{0,240}jump_tables/.test(text),
    functionDefinitionHash: sha256(
      (
        text.match(/fn load_function_def[\s\S]*?\n}\n/)?.[0] ??
        text.match(/fn load_jump_tables[\s\S]*?\n}\n/)?.[0] ??
        ""
      ).trim()
    ),
  };
}

function parseProtocolConfig(text) {
  return {
    moveBinaryFormatVersions: uniqueNumbers(
      text,
      /move_binary_format_version\s*=\s*Some\((\d+)\)/g
    ),
    minMoveBinaryFormatVersions: uniqueNumbers(
      text,
      /min_move_binary_format_version\s*=\s*Some\((\d+)\)/g
    ),
    maxProtocolVersion: numberMatch(
      text,
      /const MAX_PROTOCOL_VERSION: u64 = (\d+);/
    ),
  };
}

export function parseMoveCompilerEditions(text) {
  return {
    moduleExtensionTokenPresent: /\bModuleExtension\b/.test(text),
    moduleExtensionIn2024Alpha: editionFeatureListIncludes(
      text,
      "E2024_ALPHA_FEATURES",
      "ModuleExtension"
    ),
    moduleExtensionIn2024Beta: editionFeatureListIncludes(
      text,
      "E2024_BETA_FEATURES",
      "ModuleExtension"
    ),
  };
}

function editionFeatureListIncludes(text, constName, featureName) {
  const match = text.match(
    new RegExp(`const\\s+${constName}\\s*:[^=]*=\\s*&\\[([\\s\\S]*?)\\];`)
  );
  return Boolean(match?.[1]?.includes(`FeatureGate::${featureName}`));
}

function uniqueNumbers(text, regex) {
  return [
    ...new Set(
      [...text.matchAll(regex)].map((match) => Number.parseInt(match[1], 10))
    ),
  ].sort((left, right) => left - right);
}

function numberMatch(text, regex) {
  const match = text.match(regex);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function analyzeTag(options, tag) {
  const files = {};
  const errors = [];
  let pinnedMoveDependency;
  for (const group of SOURCE_FILE_GROUPS) {
    const result = await fetchSourceGroup(options, tag, group);
    if (result.ok) {
      files[group.id] = {
        sourceRepo: options.repo,
        sourceFile: result.sourceFile,
        sha256: sha256(result.text),
        cached: result.cached,
        text: result.text,
      };
      continue;
    }

    if (group.legacyMoveCandidate) {
      pinnedMoveDependency ??= await fetchPinnedMoveDependency(options, tag);
      if (pinnedMoveDependency) {
        const legacyResult = await fetchPinnedMoveSourceFile(
          options,
          pinnedMoveDependency,
          group.legacyMoveCandidate
        );
        if (legacyResult.ok) {
          files[group.id] = {
            sourceRepo: pinnedMoveDependency.repo,
            sourceFile: group.legacyMoveCandidate,
            sourceRev: pinnedMoveDependency.rev,
            pinnedBy: pinnedMoveDependency.pinnedBy,
            sha256: sha256(legacyResult.text),
            cached: legacyResult.cached,
            text: legacyResult.text,
          };
          continue;
        }
        result.attempts.push({
          sourceFile: group.legacyMoveCandidate,
          error: legacyResult.error,
          url: legacyResult.url,
        });
      }
    }

    errors.push({ sourceGroup: group.id, attempts: result.attempts });
  }

  const fileFormat = files.moveBinaryFormatCommon?.text;
  const serializer = files.serializer?.text;
  const deserializer = files.deserializer?.text;
  const protocol = files.protocolConfig?.text;
  const moveCompilerEditions = files.moveCompilerEditions?.text;
  const signals = {
    moveBinaryFormat: fileFormat ? parseMoveBinaryFormat(fileFormat) : null,
    serializer: serializer ? parseSerializer(serializer) : null,
    deserializer: deserializer ? parseDeserializer(deserializer) : null,
    protocolConfig: protocol ? parseProtocolConfig(protocol) : null,
    moveCompilerEditions: moveCompilerEditions
      ? parseMoveCompilerEditions(moveCompilerEditions)
      : null,
  };
  const bytecodeSignals = extractBytecodeSignals(signals);

  const fileHashes = Object.fromEntries(
    Object.entries(files).map(([sourceGroup, value]) => [
      sourceGroup,
      {
        sourceRepo: value.sourceRepo,
        sourceFile: value.sourceFile,
        sourceRev: value.sourceRev,
        pinnedBy: value.pinnedBy,
        sha256: value.sha256,
      },
    ])
  );
  return {
    tag: tag.tag,
    kind: tag.kind,
    network: tag.network,
    version: tag.version,
    commit: tag.commit,
    errors,
    fileHashes,
    signals,
    bytecodeSignals,
    bytecodeSignature: sha256(JSON.stringify(bytecodeSignals)),
    semanticSignature: sha256(JSON.stringify(signals)),
    sourceSignature: sha256(JSON.stringify(fileHashes)),
  };
}

function extractBytecodeSignals(signals) {
  return {
    moveBinaryFormat: signals.moveBinaryFormat,
    serializer: signals.serializer
      ? {
          encodesBinaryFlavor: signals.serializer.encodesBinaryFlavor,
          jumpTablesVersionGate: signals.serializer.jumpTablesVersionGate,
        }
      : null,
    deserializer: signals.deserializer
      ? {
          jumpTablesVersionGate: signals.deserializer.jumpTablesVersionGate,
        }
      : null,
    protocolConfig: signals.protocolConfig
      ? {
          moveBinaryFormatVersions:
            signals.protocolConfig.moveBinaryFormatVersions,
          minMoveBinaryFormatVersions:
            signals.protocolConfig.minMoveBinaryFormatVersions,
        }
      : null,
  };
}

function summarizeBoundaries(records, signatureKey, signalsKey = "signals") {
  const boundaries = [];
  let previous;
  for (const record of records) {
    if (!previous || previous[signatureKey] !== record[signatureKey]) {
      boundaries.push({
        tag: record.tag,
        version: record.version,
        kind: record.kind,
        commit: record.commit,
        previousTag: previous?.tag,
        signature: record[signatureKey],
        signals: record[signalsKey],
      });
    }
    previous = record;
  }
  return boundaries;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inventory = await readJson(options.inventory);
  const tags = selectTags(inventory.tags ?? [], options.kind, options.limit);
  if (tags.length === 0) {
    throw new Error(`No tags matched --kind ${options.kind}`);
  }

  const records = [];
  for (const tag of tags) {
    const record = await analyzeTag(options, tag);
    records.push(record);
    if (
      records.length === 1 ||
      records.length % 10 === 0 ||
      records.length === tags.length
    ) {
      console.error(
        `[bytecode-version-analysis] analyzed ${records.length}/${tags.length}: ${tag.tag}`
      );
    }
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: options.repo,
    inventory: options.inventory,
    kind: options.kind,
    tagCount: tags.length,
    sourceFileGroups: SOURCE_FILE_GROUPS,
    bytecodeBoundaries: summarizeBoundaries(
      records,
      "bytecodeSignature",
      "bytecodeSignals"
    ),
    semanticBoundaries: summarizeBoundaries(records, "semanticSignature"),
    sourceBoundaries: summarizeBoundaries(records, "sourceSignature"),
    records,
  };

  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, JSON.stringify(output, null, 2) + "\n");
  console.log(
    `[OK] wrote Sui bytecode version signals for ${tags.length} tag(s) to ${options.output}`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
