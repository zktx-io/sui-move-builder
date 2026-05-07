import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  getRepoRoot,
  loadBytecodeVerifierManifest,
} from "./bytecode-verifier-manifest.mjs";
import { loadBytecodeVersionSourceRecords } from "./bytecode-version-source-records.mjs";

export function getVerificationRuntimeConfigPath(repoRoot = getRepoRoot()) {
  return path.join(
    repoRoot,
    "src",
    "generated",
    "verificationRuntimeConfig.ts"
  );
}

export function buildVerificationRuntimeConfigSource(repoRoot = getRepoRoot()) {
  const { manifest } = loadBytecodeVerifierManifest(repoRoot);
  const { sourceRecords } = loadBytecodeVersionSourceRecords(repoRoot);
  return buildVerificationRuntimeConfigSourceFromInputs(
    manifest,
    sourceRecords
  );
}

export function buildVerificationRuntimeConfigSourceFromInputs(
  manifest,
  sourceRecords
) {
  const sourceRecordByVersion = new Map(
    sourceRecords.records.map((record) => [
      Number(record.decodedBytecodeVersion),
      record,
    ])
  );
  const routes = {};
  const verifiers = {};

  for (const [versionText, route] of Object.entries(
    manifest.bytecodeVersions
  )) {
    const decodedBytecodeVersion = Number.parseInt(versionText, 10);
    const verifier = manifest.verifiers[route.verifier];
    const sourceRecord = sourceRecordByVersion.get(decodedBytecodeVersion);
    if (!verifier) {
      throw new Error(
        `Route for bytecode version ${versionText} names missing verifier ${route.verifier}`
      );
    }
    if (!sourceRecord?.signals?.moveCompilerEditions) {
      throw new Error(
        `Route for bytecode version ${versionText} needs moveCompilerEditions in bytecode-version-sources.json`
      );
    }

    routes[versionText] = {
      verifierId: route.verifier,
      decodedBytecodeVersion,
      bytecodeFlavor: route.flavor ?? null,
    };
    verifiers[route.verifier] = {
      verifierId: route.verifier,
      suiVersion: verifier.suiVersion,
      decodedBytecodeVersion,
      bytecodeFlavor: verifier.bytecodeFlavor,
      importSpecifier: importSpecifierForRoute(
        route,
        route.verifier === manifest.current
      ),
      supportedEditions:
        sourceRecord.signals.moveCompilerEditions.validEditions,
      defaultEdition: sourceRecord.signals.moveCompilerEditions.defaultEdition,
    };
  }

  const config = {
    currentVerifierId: manifest.current,
    currentBytecodeVersion:
      manifest.verifiers[manifest.current].bytecodeVersion,
    currentBytecodeFlavor: manifest.verifiers[manifest.current].bytecodeFlavor,
    routes,
    verifiers,
  };

  return `${generatedHeader()}export const VERIFICATION_RUNTIME_CONFIG = ${formatTsValue(
    sortValue(config),
    0
  )} as const;
`;
}

export function assertVerificationRuntimeConfigFresh(
  repoRoot = getRepoRoot(),
  existingSource
) {
  const runtimeConfigPath = getVerificationRuntimeConfigPath(repoRoot);
  const actual = existingSource ?? fs.readFileSync(runtimeConfigPath, "utf8");
  const expected = buildVerificationRuntimeConfigSource(repoRoot);
  if (actual !== expected) {
    throw new Error(
      `${runtimeConfigPath} is stale. Run npm run generate:verification-runtime-config.`
    );
  }
}

function importSpecifierForRoute(route, isCurrent) {
  if (isCurrent) {
    return null;
  }
  const prefix = "dist/verification/";
  if (!route.distPath.startsWith(prefix)) {
    throw new Error(
      `Bundled verifier route distPath must start with ${prefix}: ${route.distPath}`
    );
  }
  const relativeDist = route.distPath.slice(prefix.length);
  return `./${relativeDist}/sui_move_wasm.js`;
}

function generatedHeader() {
  return `// AUTO-GENERATED. Do not edit directly.
// Generated from scripts/verification/bytecode-verifiers.json and scripts/verification/bytecode-version-sources.json.
// Run npm run generate:verification-runtime-config after changing either source.

`;
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortValue(value[key]);
  }
  return sorted;
}

function formatTsValue(value, indentLevel) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatTsValue(item, indentLevel)).join(", ")}]`;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (!value || typeof value !== "object") {
    return "undefined";
  }
  const indent = "  ".repeat(indentLevel);
  const childIndent = "  ".repeat(indentLevel + 1);
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{}";
  }
  const lines = entries.map(
    ([key, item]) =>
      `${childIndent}${formatTsKey(key)}: ${formatTsValue(
        item,
        indentLevel + 1
      )},`
  );
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function formatTsKey(key) {
  return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(key) ? key : JSON.stringify(key);
}

function main() {
  const repoRoot = getRepoRoot();
  const runtimeConfigPath = getVerificationRuntimeConfigPath(repoRoot);
  const args = new Set(process.argv.slice(2));
  if (args.has("--check")) {
    assertVerificationRuntimeConfigFresh(repoRoot);
    console.log(`[OK] ${runtimeConfigPath} is fresh`);
    return;
  }
  fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
  fs.writeFileSync(
    runtimeConfigPath,
    buildVerificationRuntimeConfigSource(repoRoot)
  );
  console.log(`[OK] wrote ${runtimeConfigPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
