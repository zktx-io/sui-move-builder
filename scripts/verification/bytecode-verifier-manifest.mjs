import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export function getRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

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

export function legacyPackageName(verifierId) {
  return `@zktx.io/sui-move-builder-bytecode-verifier-${verifierId}`;
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

export function validateBytecodeVerifierManifest(manifest, label = "manifest") {
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
    manifest.distribution === "separate-npm-packages",
    `${label}: distribution must be separate-npm-packages`
  );
  assertString(manifest.current, `${label}: current`);
  assertObject(manifest.bytecodeVersions, `${label}: bytecodeVersions`);
  assertObject(manifest.verifiers, `${label}: verifiers`);
  assertValue(
    Object.hasOwn(manifest.verifiers, manifest.current),
    `${label}: current must name an existing verifier`
  );

  const seenPackageNames = new Set();
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
      !seenPackageNames.has(entry.packageName),
      `${label}: duplicate packageName ${entry.packageName}`
    );
    seenPackageNames.add(entry.packageName);
    assertString(
      entry.verificationWasmPath,
      `${label}: ${verifierId}.verificationWasmPath`
    );
    assertValue(
      Array.isArray(entry.knownFixtures),
      `${label}: ${verifierId}.knownFixtures must be an array`
    );

    if (entry.status === "current") {
      assertValue(
        entry.packageName === "@zktx.io/sui-move-builder",
        `${label}: current verifier packageName must be @zktx.io/sui-move-builder`
      );
    } else {
      assertValue(
        entry.packageName === legacyPackageName(verifierId),
        `${label}: legacy ${verifierId}.packageName must be ${legacyPackageName(verifierId)}`
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
    assertString(
      route.verifier,
      `${label}: bytecodeVersions.${version}.verifier`
    );
    const verifier = manifest.verifiers[route.verifier];
    assertValue(
      Boolean(verifier),
      `${label}: bytecodeVersions.${version}.verifier must name an existing verifier`
    );
    assertValue(
      verifier.bytecodeVersion === bytecodeVersion,
      `${label}: bytecodeVersions.${version}.verifier ${route.verifier} has bytecodeVersion ${verifier.bytecodeVersion}`
    );
    if (Object.hasOwn(route, "flavor")) {
      assertValue(
        route.flavor === null ||
          (Number.isInteger(route.flavor) && route.flavor >= 0),
        `${label}: bytecodeVersions.${version}.flavor must be null or a non-negative integer`
      );
      assertValue(
        route.flavor === verifier.bytecodeFlavor,
        `${label}: bytecodeVersions.${version}.flavor must match verifier bytecodeFlavor`
      );
    }
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

function assertValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
