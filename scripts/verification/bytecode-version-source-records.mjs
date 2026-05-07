import { createRequire } from "node:module";
import path from "node:path";

import { getRepoRoot } from "./bytecode-verifier-manifest.mjs";

const require = createRequire(import.meta.url);

export function getBytecodeVersionSourceRecordsPath(repoRoot = getRepoRoot()) {
  return path.join(
    repoRoot,
    "scripts",
    "verification",
    "bytecode-version-sources.json"
  );
}

export function loadBytecodeVersionSourceRecords(repoRoot = getRepoRoot()) {
  const sourceRecordsPath = getBytecodeVersionSourceRecordsPath(repoRoot);
  const sourceRecords = require(sourceRecordsPath);
  validateBytecodeVersionSourceRecords(sourceRecords, sourceRecordsPath);
  return { sourceRecords, sourceRecordsPath };
}

export function validateBytecodeVersionSourceRecords(
  sourceRecords,
  label = "bytecode-version-sources"
) {
  assertObject(sourceRecords, `${label} root`);
  assertValue(
    sourceRecords.schemaVersion === 1,
    `${label}: schemaVersion must be 1`
  );
  assertString(sourceRecords.sourceRepo, `${label}: sourceRepo`);
  assertObject(sourceRecords.inventory, `${label}: inventory`);
  assertPositiveInteger(
    sourceRecords.inventory.networkTagCount,
    `${label}: inventory.networkTagCount`
  );
  assertPositiveInteger(
    sourceRecords.inventory.releaseTagCount,
    `${label}: inventory.releaseTagCount`
  );
  assertPositiveInteger(
    sourceRecords.inventory.releasedCliVersionCount,
    `${label}: inventory.releasedCliVersionCount`
  );
  assertPositiveInteger(
    sourceRecords.inventory.allTagCount,
    `${label}: inventory.allTagCount`
  );
  assertString(
    sourceRecords.inventory.firstReleasedCliVersion,
    `${label}: inventory.firstReleasedCliVersion`
  );
  assertString(
    sourceRecords.inventory.networkSignalsPath,
    `${label}: inventory.networkSignalsPath`
  );
  assertString(
    sourceRecords.inventory.expandedNetworkSignalsPath,
    `${label}: inventory.expandedNetworkSignalsPath`
  );
  assertString(
    sourceRecords.inventory.allSignalsPath,
    `${label}: inventory.allSignalsPath`
  );
  validateIntegerArray(
    sourceRecords.inventory.observedDecodedBytecodeVersions,
    `${label}: inventory.observedDecodedBytecodeVersions`
  );
  if (
    sourceRecords.inventory.releasedCliDecodedBytecodeVersions !== undefined
  ) {
    validateIntegerArray(
      sourceRecords.inventory.releasedCliDecodedBytecodeVersions,
      `${label}: inventory.releasedCliDecodedBytecodeVersions`
    );
  }
  if (
    sourceRecords.inventory.networkOnlyDecodedBytecodeVersions !== undefined
  ) {
    validateIntegerArray(
      sourceRecords.inventory.networkOnlyDecodedBytecodeVersions,
      `${label}: inventory.networkOnlyDecodedBytecodeVersions`
    );
  }
  assertValue(
    sourceRecords.inventory.allTagCount >=
      sourceRecords.inventory.networkTagCount,
    `${label}: inventory.allTagCount must be >= networkTagCount`
  );
  assertValue(
    sourceRecords.inventory.allTagCount >=
      sourceRecords.inventory.releaseTagCount,
    `${label}: inventory.allTagCount must be >= releaseTagCount`
  );
  assertValue(
    Array.isArray(sourceRecords.records) && sourceRecords.records.length > 0,
    `${label}: records must be a non-empty array`
  );

  const seenVersions = new Set();
  let previousVersion = 0;
  for (const [index, record] of sourceRecords.records.entries()) {
    const recordLabel = `${label}: records[${index}]`;
    assertObject(record, recordLabel);
    assertPositiveInteger(
      record.decodedBytecodeVersion,
      `${recordLabel}.decodedBytecodeVersion`
    );
    assertValue(
      record.decodedBytecodeVersion > previousVersion,
      `${recordLabel}.decodedBytecodeVersion must be sorted ascending`
    );
    previousVersion = record.decodedBytecodeVersion;
    assertValue(
      !seenVersions.has(record.decodedBytecodeVersion),
      `${recordLabel}.decodedBytecodeVersion must be unique`
    );
    seenVersions.add(record.decodedBytecodeVersion);
    assertValue(
      record.bytecodeFlavor === null ||
        (Number.isInteger(record.bytecodeFlavor) && record.bytecodeFlavor >= 0),
      `${recordLabel}.bytecodeFlavor must be null or a non-negative integer`
    );
    assertString(record.verifierId, `${recordLabel}.verifierId`);
    assertValue(
      /^sui-[a-z0-9][a-z0-9._-]*$/.test(record.verifierId),
      `${recordLabel}.verifierId must be a package-compatible Sui source version handle`
    );
    validateObservedRef(record.representative, `${recordLabel}.representative`);
    validateOptionalObservedRef(
      record.firstObserved,
      `${recordLabel}.firstObserved`
    );
    validateOptionalObservedRef(
      record.firstObservedWithProtocolVersion,
      `${recordLabel}.firstObservedWithProtocolVersion`
    );
    validateOptionalObservedRef(
      record.firstReleasedCli,
      `${recordLabel}.firstReleasedCli`
    );
    validateOptionalObservedRef(
      record.latestObserved,
      `${recordLabel}.latestObserved`
    );
    validateOptionalObservedRef(
      record.lastObservedBeforeNextRecordedChange,
      `${recordLabel}.lastObservedBeforeNextRecordedChange`
    );
    validateOptionalObservedRef(
      record.nextRecordedChange,
      `${recordLabel}.nextRecordedChange`
    );
    assertValue(
      Array.isArray(record.sourceFiles) && record.sourceFiles.length > 0,
      `${recordLabel}.sourceFiles must be a non-empty array`
    );
    for (const [sourceIndex, sourceFile] of record.sourceFiles.entries()) {
      assertString(sourceFile, `${recordLabel}.sourceFiles[${sourceIndex}]`);
    }
    validateSignals(record.signals, record.decodedBytecodeVersion, recordLabel);
    validateSourceHashes(
      record.representativeSourceHashes,
      `${recordLabel}.representativeSourceHashes`
    );
    if (record.firstObservedSourceHashes !== undefined) {
      validateSourceHashes(
        record.firstObservedSourceHashes,
        `${recordLabel}.firstObservedSourceHashes`
      );
    }
    if (record.dependencySource !== undefined) {
      validateDependencySource(
        record.dependencySource,
        `${recordLabel}.dependencySource`
      );
    }
    assertString(record.notes, `${recordLabel}.notes`);
  }

  const observedVersions = new Set(
    sourceRecords.inventory.observedDecodedBytecodeVersions
  );
  const releasedVersions = new Set(
    sourceRecords.inventory.releasedCliDecodedBytecodeVersions ?? []
  );
  const networkOnlyVersions = new Set(
    sourceRecords.inventory.networkOnlyDecodedBytecodeVersions ?? []
  );
  assertValue(
    observedVersions.size === sourceRecords.records.length,
    `${label}: inventory.observedDecodedBytecodeVersions must match records`
  );
  for (const version of seenVersions) {
    assertValue(
      observedVersions.has(version),
      `${label}: inventory.observedDecodedBytecodeVersions must include ${version}`
    );
  }
  for (const version of releasedVersions) {
    assertValue(
      observedVersions.has(version),
      `${label}: inventory.releasedCliDecodedBytecodeVersions must be observed`
    );
    assertValue(
      !networkOnlyVersions.has(version),
      `${label}: inventory released and network-only bytecode versions must be disjoint`
    );
  }
  for (const version of networkOnlyVersions) {
    assertValue(
      observedVersions.has(version),
      `${label}: inventory.networkOnlyDecodedBytecodeVersions must be observed`
    );
  }
}

function validateDependencySource(value, label) {
  assertObject(value, label);
  assertString(value.repo, `${label}.repo`);
  assertString(value.rev, `${label}.rev`);
  assertGitHash(value.rev, `${label}.rev`);
  assertString(value.sourceRoot, `${label}.sourceRoot`);
}

function validateObservedRef(value, label) {
  assertObject(value, label);
  assertString(value.tag, `${label}.tag`);
  assertString(value.commit, `${label}.commit`);
  assertGitHash(value.commit, `${label}.commit`);
  if (Object.hasOwn(value, "suiVersion")) {
    assertString(value.suiVersion, `${label}.suiVersion`);
  }
}

function validateOptionalObservedRef(value, label) {
  if (value === undefined || value === null) return;
  validateObservedRef(value, label);
}

function validateSignals(signals, decodedBytecodeVersion, label) {
  assertObject(signals, `${label}.signals`);
  assertObject(signals.moveBinaryFormat, `${label}.signals.moveBinaryFormat`);
  assertPositiveInteger(
    signals.moveBinaryFormat.versionMin,
    `${label}.signals.moveBinaryFormat.versionMin`
  );
  assertPositiveInteger(
    signals.moveBinaryFormat.versionMax,
    `${label}.signals.moveBinaryFormat.versionMax`
  );
  assertValue(
    signals.moveBinaryFormat.versionMax === decodedBytecodeVersion,
    `${label}.signals.moveBinaryFormat.versionMax must match decodedBytecodeVersion`
  );
  assertValue(
    signals.moveBinaryFormat.versionMin <= signals.moveBinaryFormat.versionMax,
    `${label}.signals.moveBinaryFormat.versionMin must be <= versionMax`
  );
  assertString(
    signals.moveBinaryFormat.tableTypeHash,
    `${label}.signals.moveBinaryFormat.tableTypeHash`
  );
  assertObject(signals.serializer, `${label}.signals.serializer`);
  assertValue(
    typeof signals.serializer.encodesBinaryFlavor === "boolean",
    `${label}.signals.serializer.encodesBinaryFlavor must be a boolean`
  );
  assertValue(
    typeof signals.serializer.jumpTablesVersionGate === "boolean",
    `${label}.signals.serializer.jumpTablesVersionGate must be a boolean`
  );
  assertObject(signals.deserializer, `${label}.signals.deserializer`);
  assertValue(
    typeof signals.deserializer.jumpTablesVersionGate === "boolean",
    `${label}.signals.deserializer.jumpTablesVersionGate must be a boolean`
  );
  assertObject(signals.protocolConfig, `${label}.signals.protocolConfig`);
  validateIntegerArray(
    signals.protocolConfig.moveBinaryFormatVersions,
    `${label}.signals.protocolConfig.moveBinaryFormatVersions`
  );
  validateIntegerArray(
    signals.protocolConfig.minMoveBinaryFormatVersions,
    `${label}.signals.protocolConfig.minMoveBinaryFormatVersions`
  );
  if (signals.moveCompilerEditions !== undefined) {
    assertObject(
      signals.moveCompilerEditions,
      `${label}.signals.moveCompilerEditions`
    );
    for (const field of [
      "moduleExtensionTokenPresent",
      "moduleExtensionIn2024Alpha",
      "moduleExtensionIn2024Beta",
      "supportsPlain2024",
    ]) {
      assertValue(
        typeof signals.moveCompilerEditions[field] === "boolean",
        `${label}.signals.moveCompilerEditions.${field} must be a boolean`
      );
    }
    validateEditionArray(
      signals.moveCompilerEditions.validEditions,
      `${label}.signals.moveCompilerEditions.validEditions`
    );
    assertValue(
      signals.moveCompilerEditions.defaultEdition === null ||
        typeof signals.moveCompilerEditions.defaultEdition === "string",
      `${label}.signals.moveCompilerEditions.defaultEdition must be a string or null`
    );
    if (signals.moveCompilerEditions.defaultEdition !== null) {
      assertValue(
        signals.moveCompilerEditions.validEditions.includes(
          signals.moveCompilerEditions.defaultEdition
        ),
        `${label}.signals.moveCompilerEditions.defaultEdition must be included in validEditions`
      );
    }
    assertValue(
      signals.moveCompilerEditions.supportsPlain2024 ===
        signals.moveCompilerEditions.validEditions.includes("2024"),
      `${label}.signals.moveCompilerEditions.supportsPlain2024 must match validEditions`
    );
    validateEditionHashMap(
      signals.moveCompilerEditions.featureListHashes,
      `${label}.signals.moveCompilerEditions.featureListHashes`
    );
    validateEditionArray(
      signals.moveCompilerEditions.moduleExtensionEditions,
      `${label}.signals.moveCompilerEditions.moduleExtensionEditions`
    );
    assertValue(
      signals.moveCompilerEditions.moduleExtensionTokenPresent ||
        (!signals.moveCompilerEditions.moduleExtensionIn2024Alpha &&
          !signals.moveCompilerEditions.moduleExtensionIn2024Beta &&
          signals.moveCompilerEditions.moduleExtensionEditions.length === 0),
      `${label}.signals.moveCompilerEditions ModuleExtension edition flags require moduleExtensionTokenPresent`
    );
    assertValue(
      signals.moveCompilerEditions.moduleExtensionIn2024Alpha ===
        signals.moveCompilerEditions.moduleExtensionEditions.includes(
          "2024.alpha"
        ),
      `${label}.signals.moveCompilerEditions.moduleExtensionIn2024Alpha must match moduleExtensionEditions`
    );
    assertValue(
      signals.moveCompilerEditions.moduleExtensionIn2024Beta ===
        signals.moveCompilerEditions.moduleExtensionEditions.includes(
          "2024.beta"
        ),
      `${label}.signals.moveCompilerEditions.moduleExtensionIn2024Beta must match moduleExtensionEditions`
    );
  }
}

function validateEditionArray(value, label) {
  assertValue(Array.isArray(value), `${label} must be an array`);
  for (const [index, item] of value.entries()) {
    assertValue(
      typeof item === "string",
      `${label}[${index}] must be a string`
    );
  }
}

function validateEditionHashMap(value, label) {
  assertObject(value, label);
  for (const [edition, hash] of Object.entries(value)) {
    assertValue(
      typeof hash === "string" && /^[0-9a-f]{64}$/i.test(hash),
      `${label}.${edition} must be a SHA-256 hex digest`
    );
  }
}

function validateSourceHashes(value, label) {
  assertObject(value, label);
  for (const [sourceGroup, entry] of Object.entries(value)) {
    const entryLabel = `${label}.${sourceGroup}`;
    assertObject(entry, entryLabel);
    assertString(entry.sourceFile, `${entryLabel}.sourceFile`);
    assertString(entry.sha256, `${entryLabel}.sha256`);
    assertValue(
      /^[0-9a-f]{64}$/i.test(entry.sha256),
      `${entryLabel}.sha256 must be a SHA-256 hex digest`
    );
  }
}

function validateIntegerArray(value, label) {
  assertValue(Array.isArray(value), `${label} must be an array`);
  for (const [index, item] of value.entries()) {
    assertPositiveInteger(item, `${label}[${index}]`);
  }
}

function assertObject(value, label) {
  assertValue(
    Boolean(value) && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`
  );
}

function assertString(value, label) {
  assertValue(
    typeof value === "string" && value.length > 0,
    `${label} must be a non-empty string`
  );
}

function assertPositiveInteger(value, label) {
  assertValue(
    Number.isInteger(value) && value > 0,
    `${label} must be a positive integer`
  );
}

function assertGitHash(value, label) {
  assertValue(
    /^[0-9a-f]{40}$/i.test(value),
    `${label} must be a 40-character git hash`
  );
}

function assertValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
