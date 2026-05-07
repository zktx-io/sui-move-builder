#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const MOVE_BYTECODE_MAGIC_HEX = "a11ceb0b";

function parseArgs(argv) {
  const options = {
    out: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact") {
      options.artifact = path.resolve(readValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith("--artifact=")) {
      options.artifact = path.resolve(arg.slice("--artifact=".length));
    } else if (arg === "--out") {
      options.out = path.resolve(readValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith("--out=")) {
      options.out = path.resolve(arg.slice("--out=".length));
    } else if (arg === "--fail-on-warning") {
      options.failOnWarning = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.artifact) {
    throw new Error("--artifact is required");
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

function artifactReference(value) {
  if (value?.reference && typeof value.reference === "object") {
    return value.reference;
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredString(value, label);
}

function requiredStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function optionalStringArray(value, label) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided`);
  }
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function optionalIntent(value, label) {
  const intent = optionalString(value, label);
  if (intent !== undefined && intent !== "publish" && intent !== "upgrade") {
    throw new Error(`${label} must be publish or upgrade when provided`);
  }
  return intent;
}

function optionalRootGit(reference, raw) {
  const rootGit = reference.rootGit ?? raw.rootGit;
  const git = rootGit?.git ?? reference.sourceGit ?? raw.sourceGit;
  const rev =
    rootGit?.rev ??
    reference.sourceRev ??
    raw.sourceRev ??
    reference.commit ??
    raw.commit ??
    reference.rev ??
    raw.rev;
  const subdir =
    rootGit?.subdir ??
    reference.sourceSubdir ??
    raw.sourceSubdir ??
    reference.packagePath ??
    raw.packagePath;

  if (git === undefined && rev === undefined && subdir === undefined) {
    return undefined;
  }

  return {
    git: requiredString(git, "rootGit.git"),
    rev: requiredString(rev, "rootGit.rev"),
    subdir: optionalString(subdir, "rootGit.subdir"),
  };
}

function optionalTxDigest(reference, raw) {
  return optionalString(
    reference.txDigest ??
      raw.txDigest ??
      (looksLikeTransactionArtifact(raw) ? raw.digest : undefined),
    "txDigest"
  );
}

function looksLikeTransactionArtifact(raw) {
  return (
    typeof raw.digest === "string" &&
    (typeof raw.kind === "string" ||
      typeof raw.status === "string" ||
      raw.source === "grpc" ||
      raw.source === "graphql")
  );
}

function normalizeArtifact(raw) {
  const reference = artifactReference(raw);
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error("Reference artifact must be an object");
  }
  const rootGit = optionalRootGit(reference, raw);

  return {
    modules: requiredStringArray(reference.modules, "modules"),
    dependencies: optionalStringArray(reference.dependencies, "dependencies"),
    packageId: optionalString(reference.packageId, "packageId"),
    rootAddress: optionalString(reference.rootAddress, "rootAddress"),
    txDigest: optionalTxDigest(reference, raw),
    network: optionalString(reference.network ?? raw.network, "network"),
    intent: optionalIntent(
      reference.intent ?? raw.intent ?? reference.kind ?? raw.kind,
      "intent"
    ),
    rootGit,
  };
}

function decodeModuleHeader(moduleBase64, index) {
  const bytes = Buffer.from(moduleBase64, "base64");
  if (bytes.length < 8) {
    throw new Error(`modules[${index}] must decode to at least 8 bytes`);
  }
  const magic = bytes.subarray(0, 4).toString("hex");
  if (magic !== MOVE_BYTECODE_MAGIC_HEX) {
    throw new Error(
      `modules[${index}] must start with Move bytecode magic ${MOVE_BYTECODE_MAGIC_HEX}, got ${magic}`
    );
  }
  const rawVersionWord = bytes.readUInt32LE(4);
  return {
    index,
    length: bytes.length,
    magic,
    rawVersionWord,
    decodedVersion: rawVersionWord & 0x00ff_ffff,
    flavor: rawVersionWord >>> 24,
  };
}

export function inspectReferenceArtifact(raw) {
  const artifact = normalizeArtifact(raw);
  const modules = artifact.modules.map((moduleBase64, index) =>
    decodeModuleHeader(moduleBase64, index)
  );
  const versions = [...new Set(modules.map((module) => module.decodedVersion))];
  const flavors = [...new Set(modules.map((module) => module.flavor))];
  const flavor = flavors.length === 1 && flavors[0] !== 0 ? flavors[0] : null;

  if (versions.length !== 1) {
    throw new Error(
      `Reference artifact modules must use one decoded bytecode version, got ${versions.join(", ")}`
    );
  }
  if (flavors.length > 1) {
    throw new Error(
      `Reference artifact modules must use one bytecode flavor, got ${flavors.join(", ")}`
    );
  }
  const warnings = [];
  if (versions[0] <= 6 && flavors.some((item) => item !== 0)) {
    warnings.push(
      "decoded bytecode version <= 6 normally does not encode Sui flavor in the high byte; older verifiers may reject this raw version word"
    );
  }

  return {
    schemaVersion: 1,
    artifact: {
      txDigest: artifact.txDigest,
      network: artifact.network,
      intent: artifact.intent,
      packageId: artifact.packageId,
      rootAddress: artifact.rootAddress,
      rootGit: artifact.rootGit,
      moduleCount: artifact.modules.length,
      dependencyCount: artifact.dependencies.length,
    },
    bytecode: {
      decodedVersion: versions[0],
      flavor,
      modules,
    },
    warnings,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = await readJson(options.artifact);
  const inspection = inspectReferenceArtifact(raw);
  if (options.failOnWarning && inspection.warnings.length > 0) {
    throw new Error(
      `Reference artifact inspection failed (warnings as errors): ${inspection.warnings.join("; ")}`
    );
  }
  const json = `${JSON.stringify(inspection, null, 2)}\n`;
  if (options.out) {
    const relative = path.relative(repoRoot, options.out);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("--out must resolve inside the repository");
    }
    await fs.mkdir(path.dirname(options.out), { recursive: true });
    await fs.writeFile(options.out, json);
  } else {
    process.stdout.write(json);
  }
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
