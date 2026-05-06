import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getSuiBuildConfig } from "../../scripts/sui-workspace.mjs";
import {
  legacyPackageName,
  loadBytecodeVerifierManifest,
  validateBytecodeVerifierManifest,
} from "../../scripts/verification/bytecode-verifier-manifest.mjs";
import {
  loadBytecodeVersionSourceRecords,
  validateBytecodeVersionSourceRecords,
} from "../../scripts/verification/bytecode-version-source-records.mjs";
import { createWasmBuildContext } from "../../scripts/wasm/context.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const suiVersion = require("../../sui-version.json");

const { manifest } = loadBytecodeVerifierManifest(repoRoot);
const { sourceRecords } = loadBytecodeVersionSourceRecords(repoRoot);
const current = manifest.verifiers[manifest.current];

if (manifest.selectionModel !== "bytecode-version-first") {
  throw new Error(
    "Verifier manifest must use bytecode-version-first selection"
  );
}
if (current.status !== "current") {
  throw new Error(
    `Current bytecode verifier ${manifest.current} must have status=current`
  );
}

const expectedCurrent = {
  suiVersion: suiVersion.version,
  tag: suiVersion.tag,
  commit: suiVersion.commit,
};

for (const [key, expected] of Object.entries(expectedCurrent)) {
  if (current[key] !== expected) {
    throw new Error(
      `Current bytecode verifier ${key} must match sui-version.json: expected ${expected}, got ${current[key]}`
    );
  }
}

for (const [bytecodeVersion, route] of Object.entries(
  manifest.bytecodeVersions
)) {
  const verifier = manifest.verifiers[route.verifier];
  if (!verifier) {
    throw new Error(
      `Bytecode version ${bytecodeVersion} route names missing verifier ${route.verifier}`
    );
  }
  if (verifier.bytecodeVersion !== Number.parseInt(bytecodeVersion, 10)) {
    throw new Error(
      `Bytecode version ${bytecodeVersion} route points at verifier ${route.verifier} with bytecodeVersion ${verifier.bytecodeVersion}`
    );
  }
}

for (const [verifierId, entry] of Object.entries(manifest.verifiers)) {
  if (entry.status === "legacy") {
    const expectedPackage = legacyPackageName(verifierId);
    if (entry.packageName !== expectedPackage) {
      throw new Error(
        `Legacy bytecode verifier ${verifierId} must use package ${expectedPackage}`
      );
    }
  }
}

const sourceRecordVersions = new Set(
  sourceRecords.records.map((record) => String(record.decodedBytecodeVersion))
);
for (const bytecodeVersion of Object.keys(manifest.bytecodeVersions)) {
  if (!sourceRecordVersions.has(bytecodeVersion)) {
    throw new Error(
      `Bytecode version ${bytecodeVersion} route must have a source record`
    );
  }
}

const invalidCaseVerifierId = "Sui-1.70.2";
const invalidCaseManifest = {
  ...manifest,
  current: invalidCaseVerifierId,
  bytecodeVersions: {
    7: {
      verifier: invalidCaseVerifierId,
      flavor: 5,
    },
  },
  verifiers: {
    [invalidCaseVerifierId]: {
      ...current,
      verifierId: invalidCaseVerifierId,
    },
  },
};
try {
  validateBytecodeVerifierManifest(
    invalidCaseManifest,
    "invalid verifier ID test"
  );
  throw new Error("Verifier manifest should reject mixed-case verifier IDs");
} catch (error) {
  if (
    !String(error?.message ?? error).includes(
      "package-compatible Sui source version handle"
    )
  ) {
    throw error;
  }
}

const invalidSourceRecords = {
  ...sourceRecords,
  records: sourceRecords.records.map((record) => ({ ...record })),
};
invalidSourceRecords.records[0].signals = {
  ...invalidSourceRecords.records[0].signals,
  moveBinaryFormat: {
    ...invalidSourceRecords.records[0].signals.moveBinaryFormat,
    versionMax: invalidSourceRecords.records[0].decodedBytecodeVersion + 1,
  },
};
try {
  validateBytecodeVersionSourceRecords(
    invalidSourceRecords,
    "invalid source record test"
  );
  throw new Error("Source records should reject mismatched versionMax");
} catch (error) {
  if (
    !String(error?.message ?? error).includes(
      "versionMax must match decodedBytecodeVersion"
    )
  ) {
    throw error;
  }
}

const isolatedConfig = getSuiBuildConfig(repoRoot, suiVersion, {
  SUI_BUILD_WORKSPACE_DIR: "/tmp/sui-move-builder-verifier-test",
});
if (
  isolatedConfig.buildWorkspaceDir !== "/tmp/sui-move-builder-verifier-test" ||
  isolatedConfig.sourceDir !== "/tmp/sui-move-builder-verifier-test/source" ||
  isolatedConfig.workDir !== "/tmp/sui-move-builder-verifier-test/work"
) {
  throw new Error(
    `SUI_BUILD_WORKSPACE_DIR should isolate source/work paths: ${JSON.stringify(
      isolatedConfig
    )}`
  );
}

const isolatedContext = createWasmBuildContext([], {
  SUI_BUILD_WORKSPACE_DIR: "/tmp/sui-move-builder-context-test",
  SUI_COMPAT_DIR: "/tmp/sui-move-builder-context-test/compat",
  SUI_DIST_DIR: "/tmp/sui-move-builder-context-test/dist",
});
if (
  isolatedContext.suiBuildConfig.buildWorkspaceDir !==
    "/tmp/sui-move-builder-context-test" ||
  isolatedContext.compatDir !== "/tmp/sui-move-builder-context-test/compat" ||
  isolatedContext.distDir !== "/tmp/sui-move-builder-context-test/dist" ||
  isolatedContext.generatedDir !==
    "/tmp/sui-move-builder-context-test/generated"
) {
  throw new Error(
    `createWasmBuildContext should route workspace, compat, and dist through env: ${JSON.stringify(
      {
        workspace: isolatedContext.suiBuildConfig.buildWorkspaceDir,
        compat: isolatedContext.compatDir,
        dist: isolatedContext.distDir,
        generated: isolatedContext.generatedDir,
      }
    )}`
  );
}

console.log(
  `[OK] bytecode verifier manifest includes ${Object.keys(manifest.verifiers).length} verifier(s) and ${sourceRecords.records.length} source record(s)`
);
