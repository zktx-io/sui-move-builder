import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { loadBytecodeVersionSourceRecords } from "./bytecode-version-source-records.mjs";
import { getRepoRoot } from "./repo-root.mjs";

const require = createRequire(import.meta.url);

export { getRepoRoot } from "./repo-root.mjs";

export function getBytecodeVerifierManifestPath(repoRoot = getRepoRoot()) {
  return path.join(
    repoRoot,
    "scripts",
    "verification",
    "bytecode-verifiers.json"
  );
}

export function loadBytecodeVerifierManifest(repoRoot = getRepoRoot()) {
  const manifestPath = getBytecodeVerifierManifestPath(repoRoot);
  const manifest = require(manifestPath);
  validateBytecodeVerifierManifest(manifest, manifestPath);
  return { manifest, manifestPath };
}

export function getBytecodeVerifierEntry(verifierId, repoRoot = getRepoRoot()) {
  const { manifest } = loadBytecodeVerifierManifest(repoRoot);
  const entry = manifest.verifiers[verifierId];
  if (!entry) {
    throw new Error(
      `Unknown bytecode verifier '${verifierId}' in ${getBytecodeVerifierManifestPath(repoRoot)}`
    );
  }
  return entry;
}

export function getBytecodeVerifierRoute(verifierId, repoRoot = getRepoRoot()) {
  const { manifest } = loadBytecodeVerifierManifest(repoRoot);
  for (const [bytecodeVersion, route] of Object.entries(
    manifest.bytecodeVersions
  )) {
    for (const candidate of bytecodeVersionRouteCandidates(route)) {
      if (candidate.verifier === verifierId) {
        return {
          bytecodeVersion: Number.parseInt(bytecodeVersion, 10),
          route: candidate,
        };
      }
    }
  }
  return undefined;
}

export function bytecodeVersionRouteCandidates(route) {
  if (Array.isArray(route.candidates)) {
    return route.candidates;
  }
  return [
    {
      verifier: route.verifier,
      flavor: route.flavor ?? null,
      distPath: route.distPath,
    },
  ];
}

export function isolatedVerifierRoot(repoRoot, verifierId) {
  return path.join(repoRoot, ".sui-build", "bytecode-verifiers", verifierId);
}

export function defaultCompatDir(repoRoot, verifierId) {
  return path.join(
    repoRoot,
    "scripts",
    "compat",
    "bytecode-verifiers",
    verifierId
  );
}

export function validateBytecodeVerifierManifest(
  manifest,
  label = "manifest",
  repoRoot = getRepoRoot(),
  sourceRecords
) {
  const editionSourceRecords =
    sourceRecords ?? loadBytecodeVersionSourceRecords(repoRoot).sourceRecords;
  const sourceRecordByVersion = new Map(
    editionSourceRecords.records.map((record) => [
      record.decodedBytecodeVersion,
      record,
    ])
  );
  const sourceRecordByVerifier = new Map(
    [
      ...editionSourceRecords.records,
      ...(editionSourceRecords.verifierSourceRecords ?? []),
    ].map((record) => [record.verifierId, record])
  );
  assertObject(manifest, `${label} root`);
  assertValue(
    manifest.schemaVersion === 1,
    `${label}: schemaVersion must be 1`
  );
  assertValue(
    manifest.selectionModel === "bytecode-version-first",
    `${label}: selectionModel must be bytecode-version-first`
  );
  assertValue(
    manifest.distribution === "bundled-lazy",
    `${label}: distribution must be bundled-lazy`
  );
  assertString(manifest.current, `${label}: current`);
  assertObject(manifest.bytecodeVersions, `${label}: bytecodeVersions`);
  assertObject(manifest.verifiers, `${label}: verifiers`);
  assertValue(
    Object.hasOwn(manifest.verifiers, manifest.current),
    `${label}: current must name an existing verifier`
  );

  for (const [verifierId, entry] of Object.entries(manifest.verifiers)) {
    assertObject(entry, `${label}: verifiers.${verifierId}`);
    assertString(entry.verifierId, `${label}: ${verifierId}.verifierId`);
    assertValue(
      entry.verifierId === verifierId,
      `${label}: ${verifierId}.verifierId must match its key`
    );
    assertValue(
      /^sui-[a-z0-9][a-z0-9._-]*$/.test(entry.verifierId),
      `${label}: ${verifierId}.verifierId must be a package-compatible Sui source version handle`
    );
    assertString(entry.suiVersion, `${label}: ${verifierId}.suiVersion`);
    if (entry.epochId !== undefined) {
      assertString(entry.epochId, `${label}: ${verifierId}.epochId`);
      assertValue(
        /^v[0-9]+-[a-z0-9][a-z0-9-]*$/.test(entry.epochId),
        `${label}: ${verifierId}.epochId must be a semantic epoch id like v6-classic`
      );
    }
    if (entry.rustVersion !== undefined) {
      assertString(entry.rustVersion, `${label}: ${verifierId}.rustVersion`);
    }
    if (entry.wasmBindgenVersion !== undefined) {
      assertString(
        entry.wasmBindgenVersion,
        `${label}: ${verifierId}.wasmBindgenVersion`
      );
    }
    if (entry.reqwestVersion !== undefined) {
      assertString(
        entry.reqwestVersion,
        `${label}: ${verifierId}.reqwestVersion`
      );
    }
    if (entry.fastcryptoRev !== undefined) {
      assertString(
        entry.fastcryptoRev,
        `${label}: ${verifierId}.fastcryptoRev`
      );
      assertValue(
        /^[0-9a-f]{40}$/i.test(entry.fastcryptoRev),
        `${label}: ${verifierId}.fastcryptoRev must be a 40-character git hash`
      );
    }
    if (entry.dependencyVersionPins !== undefined) {
      assertObject(
        entry.dependencyVersionPins,
        `${label}: ${verifierId}.dependencyVersionPins`
      );
      for (const [specifier, preciseVersion] of Object.entries(
        entry.dependencyVersionPins
      )) {
        assertValue(
          /^[a-zA-Z0-9_-]+(@[0-9][0-9A-Za-z.+-]*)?$/.test(specifier),
          `${label}: ${verifierId}.dependencyVersionPins key ${specifier} must be a package name or package@version`
        );
        assertString(
          preciseVersion,
          `${label}: ${verifierId}.dependencyVersionPins.${specifier}`
        );
        assertValue(
          /^[0-9][0-9A-Za-z.+-]*$/.test(preciseVersion),
          `${label}: ${verifierId}.dependencyVersionPins.${specifier} must be a precise version`
        );
      }
    }
    if (entry.sourceVariantPath !== undefined) {
      validateSourceVariantPath(
        entry.sourceVariantPath,
        `${label}: ${verifierId}.sourceVariantPath`,
        repoRoot
      );
    }
    assertString(entry.tag, `${label}: ${verifierId}.tag`);
    assertString(entry.commit, `${label}: ${verifierId}.commit`);
    assertValue(
      /^[0-9a-f]{40}$/i.test(entry.commit),
      `${label}: ${verifierId}.commit must be a 40-character git hash`
    );
    assertValue(
      entry.status === "current" || entry.status === "legacy",
      `${label}: ${verifierId}.status must be current or legacy`
    );
    assertValue(
      Number.isInteger(entry.bytecodeVersion) && entry.bytecodeVersion > 0,
      `${label}: ${verifierId}.bytecodeVersion must be a positive integer`
    );
    assertValue(
      entry.bytecodeFlavor === null ||
        (Number.isInteger(entry.bytecodeFlavor) && entry.bytecodeFlavor >= 0),
      `${label}: ${verifierId}.bytecodeFlavor must be null or a non-negative integer`
    );
    assertString(
      entry.selectionReason,
      `${label}: ${verifierId}.selectionReason`
    );
    assertString(entry.packageName, `${label}: ${verifierId}.packageName`);
    assertValue(
      entry.packageName === "@zktx.io/sui-move-builder",
      `${label}: ${verifierId}.packageName must be @zktx.io/sui-move-builder for bundled-lazy distribution`
    );
    assertString(
      entry.verificationWasmPath,
      `${label}: ${verifierId}.verificationWasmPath`
    );
    assertValue(
      Array.isArray(entry.knownFixtures),
      `${label}: ${verifierId}.knownFixtures must be an array`
    );
    for (const [fixtureIndex, fixture] of entry.knownFixtures.entries()) {
      validateKnownFixture(
        fixture,
        `${label}: ${verifierId}.knownFixtures[${fixtureIndex}]`,
        entry,
        sourceRecordByVersion,
        sourceRecordByVerifier
      );
    }
  }

  for (const [version, route] of Object.entries(manifest.bytecodeVersions)) {
    assertObject(route, `${label}: bytecodeVersions.${version}`);
    const bytecodeVersion = Number.parseInt(version, 10);
    assertValue(
      String(bytecodeVersion) === version && bytecodeVersion > 0,
      `${label}: bytecodeVersions key ${version} must be a positive integer string`
    );
    const candidates = bytecodeVersionRouteCandidates(route);
    assertValue(
      candidates.length > 0,
      `${label}: bytecodeVersions.${version} must contain at least one verifier candidate`
    );
    if (Array.isArray(route.candidates)) {
      assertValue(
        !Object.hasOwn(route, "verifier") &&
          !Object.hasOwn(route, "distPath") &&
          !Object.hasOwn(route, "flavor"),
        `${label}: bytecodeVersions.${version} must not mix candidates with single-verifier route fields`
      );
    }
    const seenCandidateVerifiers = new Set();
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const candidateLabel = `${label}: bytecodeVersions.${version}.candidates[${candidateIndex}]`;
      assertObject(candidate, candidateLabel);
      assertString(candidate.verifier, `${candidateLabel}.verifier`);
      assertValue(
        !seenCandidateVerifiers.has(candidate.verifier),
        `${candidateLabel}.verifier must be unique within bytecode version ${version}`
      );
      seenCandidateVerifiers.add(candidate.verifier);
      const verifier = manifest.verifiers[candidate.verifier];
      assertValue(
        Boolean(verifier),
        `${candidateLabel}.verifier must name an existing verifier`
      );
      assertValue(
        verifier.bytecodeVersion === bytecodeVersion,
        `${candidateLabel}.verifier ${candidate.verifier} has bytecodeVersion ${verifier.bytecodeVersion}`
      );
      if (Object.hasOwn(candidate, "flavor")) {
        assertValue(
          candidate.flavor === null ||
            (Number.isInteger(candidate.flavor) && candidate.flavor >= 0),
          `${candidateLabel}.flavor must be null or a non-negative integer`
        );
        assertValue(
          candidate.flavor === verifier.bytecodeFlavor,
          `${candidateLabel}.flavor must match verifier bytecodeFlavor`
        );
      }
      assertString(candidate.distPath, `${candidateLabel}.distPath`);
      validateBundledDistPath(
        candidate.distPath,
        manifest.current,
        candidate.verifier,
        bytecodeVersion,
        verifier.epochId,
        `${candidateLabel}.distPath`
      );
      assertValue(
        verifier.verificationWasmPath ===
          path.posix.join(candidate.distPath, "sui_move_wasm_bg.wasm"),
        `${label}: ${candidate.verifier}.verificationWasmPath must point inside ${candidate.distPath}`
      );
    }
  }
}

function validateBundledDistPath(
  distPath,
  currentVerifierId,
  verifierId,
  bytecodeVersion,
  epochId,
  label
) {
  assertString(distPath, label);
  assertValue(!path.isAbsolute(distPath), `${label} must be relative`);
  assertValue(
    !distPath.split(/[\\/]+/).includes(".."),
    `${label} must not contain .. path segments`
  );
  const expected =
    verifierId === currentVerifierId
      ? "dist/verification"
      : `dist/verification/v${bytecodeVersion}/${epochId?.replace(
          /^v[0-9]+-/,
          ""
        )}`;
  assertValue(distPath === expected, `${label} must be ${expected}`);
}

function validateSourceVariantPath(sourceVariantPath, label, repoRoot) {
  assertString(sourceVariantPath, label);
  assertValue(!path.isAbsolute(sourceVariantPath), `${label} must be relative`);
  assertValue(
    !sourceVariantPath.split(/[\\/]+/).includes(".."),
    `${label} must not contain .. path segments`
  );

  const resolved = path.resolve(repoRoot, sourceVariantPath);
  const relative = path.relative(repoRoot, resolved);
  assertValue(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    `${label} must resolve inside the repository`
  );
  assertValue(
    fs.existsSync(path.join(resolved, "lib.rs")),
    `${label} must point to a src directory containing lib.rs`
  );
}

function validateKnownFixture(
  fixture,
  label,
  verifier,
  sourceRecordByVersion,
  sourceRecordByVerifier
) {
  assertObject(fixture, label);
  assertString(fixture.name, `${label}.name`);
  assertValue(
    fixture.network === "mainnet",
    `${label}.network must be mainnet for supported verifier proof fixtures`
  );
  assertString(fixture.txDigest, `${label}.txDigest`);
  assertValue(
    fixture.intent === "publish" || fixture.intent === "upgrade",
    `${label}.intent must be publish or upgrade`
  );
  assertObject(fixture.rootGit, `${label}.rootGit`);
  assertString(fixture.rootGit.git, `${label}.rootGit.git`);
  assertString(fixture.rootGit.rev, `${label}.rootGit.rev`);
  if (fixture.rootGit.subdir !== undefined) {
    assertString(fixture.rootGit.subdir, `${label}.rootGit.subdir`);
  }
  if (fixture.proofCacheDir !== undefined) {
    assertString(fixture.proofCacheDir, `${label}.proofCacheDir`);
    assertValue(
      !path.isAbsolute(fixture.proofCacheDir) &&
        !fixture.proofCacheDir.split(/[\\/]/).includes(".."),
      `${label}.proofCacheDir must be a repo-relative path`
    );
  }
  if (fixture.proofDependencySource !== undefined) {
    assertValue(
      fixture.proofDependencySource === "local-sui-source" ||
        fixture.proofDependencySource === "github",
      `${label}.proofDependencySource must be local-sui-source or github`
    );
  }
  assertValue(
    fixture.expectedStatus === "verified",
    `${label}.expectedStatus must be verified`
  );
  assertValue(
    fixture.expectedVerdict === "exact_bytecode_match",
    `${label}.expectedVerdict must be exact_bytecode_match`
  );
  validateKnownFixtureInspection(
    fixture.referenceInspection,
    `${label}.referenceInspection`,
    verifier
  );
  validateKnownFixtureManifest(
    fixture.referenceManifest,
    `${label}.referenceManifest`,
    verifier,
    sourceRecordByVersion,
    sourceRecordByVerifier
  );
}

function validateKnownFixtureManifest(
  referenceManifest,
  label,
  verifier,
  sourceRecordByVersion,
  sourceRecordByVerifier
) {
  assertObject(referenceManifest, label);
  assertValue(
    referenceManifest.edition === null ||
      typeof referenceManifest.edition === "string",
    `${label}.edition must be a string or null`
  );
  assertValue(
    typeof referenceManifest.defaulted === "boolean",
    `${label}.defaulted must be a boolean`
  );
  if (referenceManifest.defaulted) {
    assertValue(
      referenceManifest.edition === null,
      `${label}.edition must be null when defaulted`
    );
  }
  const effectiveEdition =
    referenceManifest.edition ?? missingEditionFallbackForVerifier(verifier);
  assertValue(
    supportedEditionsForVerifier(
      verifier,
      sourceRecordByVersion,
      sourceRecordByVerifier
    ).includes(effectiveEdition),
    `${label}.edition ${effectiveEdition} is not supported by verifier ${verifier.verifierId}`
  );
}

function supportedEditionsForVerifier(
  verifier,
  sourceRecordByVersion,
  sourceRecordByVerifier
) {
  return compilerEditionSignals(
    verifier,
    sourceRecordByVersion,
    sourceRecordByVerifier
  ).validEditions;
}

function missingEditionFallbackForVerifier(verifier) {
  assertString(verifier.verifierId, "verifier.verifierId");
  return "legacy";
}

function compilerEditionSignals(
  verifier,
  sourceRecordByVersion,
  sourceRecordByVerifier
) {
  const sourceRecord =
    sourceRecordByVerifier.get(verifier.verifierId) ??
    sourceRecordByVersion.get(verifier.bytecodeVersion);
  assertValue(
    Boolean(sourceRecord?.signals?.moveCompilerEditions),
    `verifier ${verifier.verifierId} must have moveCompilerEditions source signals`
  );
  return sourceRecord.signals.moveCompilerEditions;
}

function validateKnownFixtureInspection(inspection, label, verifier) {
  assertObject(inspection, label);
  assertValue(
    inspection.decodedVersion === verifier.bytecodeVersion,
    `${label}.decodedVersion must match verifier bytecodeVersion`
  );
  assertValue(
    inspection.flavor === verifier.bytecodeFlavor,
    `${label}.flavor must match verifier bytecodeFlavor`
  );
  assertValue(
    Number.isInteger(inspection.moduleCount) && inspection.moduleCount > 0,
    `${label}.moduleCount must be a positive integer`
  );
  assertValue(
    Number.isInteger(inspection.dependencyCount) &&
      inspection.dependencyCount >= 0,
    `${label}.dependencyCount must be a non-negative integer`
  );
  assertValue(
    Array.isArray(inspection.warnings),
    `${label}.warnings must be an array`
  );
  assertValue(
    inspection.warnings.length === 0,
    `${label}.warnings must be empty for promoted verifier fixtures`
  );
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

function assertValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
