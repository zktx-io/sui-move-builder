import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getSuiBuildConfig } from "../../scripts/sui-workspace.mjs";
import { parseMoveCompilerEditions } from "../../scripts/verification/analyze-bytecode-versions.mjs";
import {
  loadBytecodeVerifierManifest,
  validateBytecodeVerifierManifest,
} from "../../scripts/verification/bytecode-verifier-manifest.mjs";
import {
  loadBytecodeVersionSourceRecords,
  validateBytecodeVersionSourceRecords,
} from "../../scripts/verification/bytecode-version-source-records.mjs";
import { inspectReferenceArtifact } from "../../scripts/verification/inspect-reference-artifact.mjs";
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
  const expectedDistPath =
    route.verifier === manifest.current
      ? "dist/verification"
      : `dist/verification/v${bytecodeVersion}`;
  if (route.distPath !== expectedDistPath) {
    throw new Error(
      `Bytecode version ${bytecodeVersion} route should use ${expectedDistPath}, got ${route.distPath}`
    );
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
      distPath: "dist/verification",
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

const invalidCompilerEditionSignals = {
  ...sourceRecords,
  records: sourceRecords.records.map((record) => ({ ...record })),
};
invalidCompilerEditionSignals.records[0].signals = {
  ...invalidCompilerEditionSignals.records[0].signals,
  moveCompilerEditions: {
    validEditions: ["legacy", "2024.alpha", "2024.beta"],
    defaultEdition: "legacy",
    supportsPlain2024: false,
    featureListHashes: {
      "2024.alpha":
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "2024.beta":
        "1712b61c46ff9b7510bb087cc8972e5da576663ea7fcbf58ef67e0b80ff052cb",
      2024: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    moduleExtensionEditions: ["2024.alpha"],
    moduleExtensionTokenPresent: false,
    moduleExtensionIn2024Alpha: true,
    moduleExtensionIn2024Beta: false,
  },
};
try {
  validateBytecodeVersionSourceRecords(
    invalidCompilerEditionSignals,
    "invalid compiler edition signal test"
  );
  throw new Error(
    "Source records should reject ModuleExtension edition flags without token presence"
  );
} catch (error) {
  if (!String(error?.message ?? error).includes("require")) {
    throw error;
  }
}

const compilerEditionSignals = parseMoveCompilerEditions(`
impl Edition {
    pub const VALID: &'static [Self] = &[Self::LEGACY, Self::E2024_ALPHA, Self::E2024_BETA];
}
impl Default for Edition {
    fn default() -> Self {
        Self::LEGACY
    }
}
const E2024_ALPHA_FEATURES: &[FeatureGate] = &[
    FeatureGate::ModuleExtension,
];
const E2024_BETA_FEATURES: &[FeatureGate] = &[
    FeatureGate::SomeOtherFeature,
];
`);
if (
  compilerEditionSignals.defaultEdition !== "legacy" ||
  compilerEditionSignals.supportsPlain2024 ||
  compilerEditionSignals.validEditions.join(",") !==
    "legacy,2024.alpha,2024.beta" ||
  !compilerEditionSignals.moduleExtensionTokenPresent ||
  !compilerEditionSignals.moduleExtensionIn2024Alpha ||
  compilerEditionSignals.moduleExtensionIn2024Beta ||
  compilerEditionSignals.moduleExtensionEditions.join(",") !== "2024.alpha"
) {
  throw new Error(
    `Compiler edition parser should detect edition defaults and ModuleExtension alpha membership only: ${JSON.stringify(
      compilerEditionSignals
    )}`
  );
}

const invalidFixtureManifest = {
  ...manifest,
  verifiers: {
    ...manifest.verifiers,
    [manifest.current]: {
      ...current,
      knownFixtures: [
        {
          name: "invalid-fixture",
          network: "testnet",
          txDigest: "digest",
          intent: "publish",
          rootGit: {
            git: "https://github.com/MystenLabs/example.git",
            rev: "abc123",
          },
          expectedStatus: "verified",
          expectedVerdict: "exact_bytecode_match",
          referenceManifest: {
            edition: null,
            defaulted: true,
          },
        },
      ],
    },
  },
};
try {
  validateBytecodeVerifierManifest(
    invalidFixtureManifest,
    "invalid known fixture test"
  );
  throw new Error("Verifier manifest should reject non-mainnet proof fixtures");
} catch (error) {
  if (!String(error?.message ?? error).includes("network must be mainnet")) {
    throw error;
  }
}

const invalidFixtureWarningManifest = {
  ...manifest,
  verifiers: {
    ...manifest.verifiers,
    [manifest.current]: {
      ...current,
      knownFixtures: [
        {
          name: "warning-fixture",
          network: "mainnet",
          txDigest: "digest",
          intent: "publish",
          rootGit: {
            git: "https://github.com/MystenLabs/example.git",
            rev: "abc123",
          },
          expectedStatus: "verified",
          expectedVerdict: "exact_bytecode_match",
          referenceInspection: {
            decodedVersion: current.bytecodeVersion,
            flavor: current.bytecodeFlavor,
            moduleCount: 1,
            dependencyCount: 0,
            warnings: ["warning"],
          },
          referenceManifest: {
            edition: null,
            defaulted: true,
          },
        },
      ],
    },
  },
};
try {
  validateBytecodeVerifierManifest(
    invalidFixtureWarningManifest,
    "invalid known fixture warning test"
  );
  throw new Error("Verifier manifest should reject fixture warning records");
} catch (error) {
  if (!String(error?.message ?? error).includes("warnings must be empty")) {
    throw error;
  }
}

for (const verifier of Object.values(manifest.verifiers)) {
  for (const fixture of verifier.knownFixtures) {
    const transactionPath = path.join(
      repoRoot,
      ".sui-build",
      "parity-transaction-artifact-output",
      "verification",
      fixture.name,
      "transaction.json"
    );
    if (!fs.existsSync(transactionPath)) {
      continue;
    }
    const inspection = inspectReferenceArtifact(
      JSON.parse(fs.readFileSync(transactionPath, "utf8"))
    );
    if (inspection.warnings.length > 0) {
      throw new Error(
        `${fixture.name} cached transaction inspection must have no warnings: ${inspection.warnings.join(
          "; "
        )}`
      );
    }
    const expectedInspection = fixture.referenceInspection;
    const actualInspection = {
      decodedVersion: inspection.bytecode.decodedVersion,
      flavor: inspection.bytecode.flavor,
      moduleCount: inspection.artifact.moduleCount,
      dependencyCount: inspection.artifact.dependencyCount,
    };
    for (const [key, actual] of Object.entries(actualInspection)) {
      if (actual !== expectedInspection[key]) {
        throw new Error(
          `${fixture.name} known fixture ${key} must match cached transaction inspection: expected ${expectedInspection[key]}, got ${actual}`
        );
      }
    }
  }
}

const invalidSourceVariantManifest = {
  ...manifest,
  verifiers: {
    ...manifest.verifiers,
    [manifest.current]: {
      ...current,
      sourceVariantPath: "../outside/src",
    },
  },
};
try {
  validateBytecodeVerifierManifest(
    invalidSourceVariantManifest,
    "invalid source variant test"
  );
  throw new Error("Verifier manifest should reject escaping source variants");
} catch (error) {
  if (!String(error?.message ?? error).includes("must not contain ..")) {
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
