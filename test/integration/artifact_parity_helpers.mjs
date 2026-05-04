import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const tableTypeNames = new Map([
  [0x1, "module_handles"],
  [0x2, "datatype_handles"],
  [0x3, "function_handles"],
  [0x4, "function_instantiations"],
  [0x5, "signatures"],
  [0x6, "constant_pool"],
  [0x7, "identifiers"],
  [0x8, "address_identifiers"],
  [0xa, "struct_defs"],
  [0xb, "struct_def_instantiations"],
  [0xc, "function_defs"],
  [0xd, "field_handles"],
  [0xe, "field_instantiations"],
  [0xf, "friend_decls"],
  [0x10, "metadata"],
  [0x11, "enum_defs"],
  [0x12, "enum_def_instantiations"],
  [0x13, "variant_handles"],
  [0x14, "variant_instantiation_handles"],
]);

export function normalizeDigest(digest) {
  if (Array.isArray(digest)) {
    return Buffer.from(digest).toString("hex");
  }
  if (typeof digest === "string") {
    return digest.replace(/^0x/, "").toLowerCase();
  }
  throw new Error(`Unsupported digest shape: ${typeof digest}`);
}

export function normalizeDependencies(dependencies) {
  if (!Array.isArray(dependencies)) {
    throw new Error("Build output dependencies must be an array");
  }
  return dependencies.map((dep) => String(dep).toLowerCase());
}

export function normalizeOutput(output) {
  if (!Array.isArray(output.modules)) {
    throw new Error("Build output modules must be an array");
  }
  return {
    modules: output.modules,
    dependencies: normalizeDependencies(output.dependencies || []),
    digest: normalizeDigest(output.digest),
  };
}

export function compareArrays(label, left, right, differences) {
  if (left.length !== right.length) {
    differences.push(
      `${label} count differs: left=${left.length}, right=${right.length}`
    );
    return;
  }

  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      differences.push(`${label}[${i}] differs`);
      return;
    }
  }
}

export function compareBuildOutputs(leftName, left, rightName, right) {
  const differences = [];
  compareArrays("modules", left.modules, right.modules, differences);
  compareArrays(
    "dependencies",
    left.dependencies,
    right.dependencies,
    differences
  );
  if (left.digest !== undefined && right.digest !== undefined) {
    if (left.digest !== right.digest) {
      differences.push(
        `digest differs: ${leftName}=${left.digest}, ${rightName}=${right.digest}`
      );
    }
  }
  return differences.map((difference) =>
    difference
      .replace("left=", `${leftName}=`)
      .replace("right=", `${rightName}=`)
  );
}

export function moduleHash(base64) {
  return createHash("sha256")
    .update(Buffer.from(base64, "base64"))
    .digest("hex");
}

export function compareModuleBytecode(leftName, left, rightName, right) {
  const leftModules = [...left.modules].sort();
  const rightModules = [...right.modules].sort();
  const differences = [];
  const bytecodeDiffs = [];

  if (leftModules.length !== rightModules.length) {
    differences.push(
      `module count differs: ${leftName}=${leftModules.length}, ${rightName}=${rightModules.length}`
    );
  }

  const max = Math.max(leftModules.length, rightModules.length);
  for (let i = 0; i < max; i += 1) {
    const leftModule = leftModules[i];
    const rightModule = rightModules[i];
    if (leftModule !== rightModule) {
      differences.push(`module bytecode differs at sorted index ${i}`);
      if (leftModule && rightModule) {
        bytecodeDiffs.push(
          summarizeBytecodeDifference(
            leftName,
            leftModule,
            rightName,
            rightModule
          )
        );
      }
      break;
    }
  }

  if (differences.length === 0) {
    return { ok: true, differences: [] };
  }

  return {
    ok: false,
    differences,
    [`${leftName}Hashes`]: leftModules.map(moduleHash),
    [`${rightName}Hashes`]: rightModules.map(moduleHash),
    bytecodeDiffs,
  };
}

export function compareNamedModuleBytecode(leftName, left, rightName, right) {
  const differences = [];
  const bytecodeDiffs = [];
  const leftByName = new Map(
    left.namedModules.map((module) => [module.name, module])
  );
  const rightByName = new Map(
    right.namedModules.map((module) => [module.name, module])
  );
  const moduleNames = new Set([...leftByName.keys(), ...rightByName.keys()]);

  for (const moduleName of [...moduleNames].sort()) {
    const leftModule = leftByName.get(moduleName);
    const rightModule = rightByName.get(moduleName);
    if (!leftModule || !rightModule) {
      differences.push(
        `${moduleName}: missing in ${leftModule ? rightName : leftName}`
      );
      continue;
    }
    if (leftModule.base64 !== rightModule.base64) {
      differences.push(`${moduleName}: bytecode differs`);
      bytecodeDiffs.push(
        summarizeBytecodeDifference(
          leftName,
          leftModule.base64,
          rightName,
          rightModule.base64
        )
      );
    }
  }

  return {
    ok: differences.length === 0,
    differences,
    bytecodeDiffs,
  };
}

export async function writeJsonArtifact(outputRoot, name, data) {
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(
    path.join(outputRoot, name),
    JSON.stringify(data, null, 2)
  );
}

export async function readNamedMoveModules(modulesDir) {
  const entries = await fs.readdir(modulesDir, { withFileTypes: true });
  const moduleFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mv"))
    .map((entry) => entry.name)
    .sort();

  if (moduleFiles.length === 0) {
    throw new Error(`No .mv modules generated under ${modulesDir}`);
  }

  const namedModules = [];
  for (const fileName of moduleFiles) {
    const bytes = await fs.readFile(path.join(modulesDir, fileName));
    const base64 = bytes.toString("base64");
    if (!base64) {
      throw new Error(`Empty base64 output for ${fileName}`);
    }
    namedModules.push({
      name: fileName.replace(/\.mv$/, ""),
      base64,
    });
  }
  return namedModules;
}

export function modulesToOutput(namedModules) {
  return {
    moduleCount: namedModules.length,
    modules: namedModules.map((module) => module.base64),
    namedModules,
  };
}

function summarizeBytecodeDifference(
  leftName,
  leftBase64,
  rightName,
  rightBase64
) {
  const left = Buffer.from(leftBase64, "base64");
  const right = Buffer.from(rightBase64, "base64");
  const firstDiffOffset = firstDifferentOffset(left, right);
  const leftHeader = parseMoveBytecodeHeader(left);
  const rightHeader = parseMoveBytecodeHeader(right);

  return {
    firstDiffOffset,
    [leftName]: {
      length: left.length,
      sha256: createHash("sha256").update(left).digest("hex"),
      section: sectionForOffset(leftHeader, firstDiffOffset),
      header: leftHeader,
    },
    [rightName]: {
      length: right.length,
      sha256: createHash("sha256").update(right).digest("hex"),
      section: sectionForOffset(rightHeader, firstDiffOffset),
      header: rightHeader,
    },
  };
}

function firstDifferentOffset(left, right) {
  const min = Math.min(left.length, right.length);
  for (let i = 0; i < min; i += 1) {
    if (left[i] !== right[i]) {
      return i;
    }
  }
  return left.length === right.length ? null : min;
}

function parseMoveBytecodeHeader(buffer) {
  if (buffer.length < 9) {
    return { valid: false, reason: "too_short" };
  }
  const magic = buffer.subarray(0, 4).toString("hex");
  const rawVersion = buffer.readUInt32LE(4);
  const tableCountResult = readUleb128(buffer, 8);
  if (!tableCountResult) {
    return { valid: false, reason: "truncated_table_count", magic, rawVersion };
  }
  const tableCount = tableCountResult.value;
  let cursor = tableCountResult.nextOffset;
  const tables = [];
  for (let i = 0; i < tableCount; i += 1) {
    const kind = readUleb128(buffer, cursor);
    const start = kind && readUleb128(buffer, kind.nextOffset);
    const byteCount = start && readUleb128(buffer, start.nextOffset);
    if (!kind || !start || !byteCount) {
      return {
        valid: false,
        reason: "truncated_table_header",
        magic,
        rawVersion,
        tableCount,
      };
    }
    cursor = byteCount.nextOffset;
    tables.push({
      kind: kind.value,
      name: tableTypeNames.get(kind.value) || `unknown_${kind.value}`,
      relativeStart: start.value,
      relativeEnd: start.value + byteCount.value,
      byteCount: byteCount.value,
    });
  }
  const headerLength = cursor;
  for (const table of tables) {
    table.start = headerLength + table.relativeStart;
    table.end = headerLength + table.relativeEnd;
  }
  return {
    valid: magic === "a11ceb0b" || magic === "deadc0de",
    magic,
    rawVersion,
    version: rawVersion <= 6 ? rawVersion : rawVersion & 0x00ffffff,
    flavor: rawVersion <= 6 ? null : rawVersion >>> 24,
    tableCount,
    headerLength,
    tables,
  };
}

function readUleb128(buffer, offset) {
  let value = 0;
  let shift = 0;
  for (let i = offset; i < buffer.length; i += 1) {
    const byte = buffer[i];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: i + 1 };
    }
    shift += 7;
    if (shift > 28) {
      return null;
    }
  }
  return null;
}

function sectionForOffset(header, offset) {
  if (offset === null) {
    return "equal";
  }
  if (!header?.valid) {
    return "unknown";
  }
  if (offset < header.headerLength) {
    return "header";
  }
  const table = header.tables.find(
    (candidate) => offset >= candidate.start && offset < candidate.end
  );
  return table ? table.name : "body_or_trailing";
}
