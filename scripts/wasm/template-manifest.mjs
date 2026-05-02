import { promises as fs } from "node:fs";
import path from "node:path";

const REQUIRED_FILE_PATCHES = [
  "fastcryptoSecp256r1Mod",
  "nitroAttestation",
  "moveUnitTestRunner",
];

function assertManifest(condition, message) {
  if (!condition) {
    throw new Error(`Invalid template manifest: ${message}`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertSimpleName(value, label) {
  assertManifest(
    typeof value === "string" && value.length > 0,
    `${label} must be a non-empty string`
  );
  assertManifest(
    !path.isAbsolute(value),
    `${label} must be a relative filename`
  );
  assertManifest(
    !value.includes("/") && !value.includes("\\"),
    `${label} must not include path separators`
  );
  assertManifest(
    value !== "." && value !== "..",
    `${label} must be a filename`
  );
}

async function assertTemplateFile(templatesDir, fileName, label) {
  assertSimpleName(fileName, label);
  const filePath = path.join(templatesDir, fileName);
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(
      `Template manifest references missing file for ${label}: ${filePath}`
    );
  }
}

async function assertStubTemplateFile(templatesDir, templateName, label) {
  assertSimpleName(templateName, label);
  assertManifest(
    !templateName.endsWith(".rs"),
    `${label} must omit the .rs extension`
  );
  await assertTemplateFile(templatesDir, `${templateName}.rs`, label);
}

export async function loadTemplateManifest(templatesDir) {
  const manifestPath = path.join(templatesDir, "manifest.json");
  let manifest;

  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read template manifest ${manifestPath}: ${error.message}`
    );
  }

  assertManifest(manifest.schemaVersion === 1, "schemaVersion must be 1");
  assertManifest(
    isPlainObject(manifest.stubTemplates),
    "stubTemplates must be an object"
  );
  assertManifest(
    Array.isArray(manifest.offendingCrates),
    "offendingCrates must be an array"
  );
  if (manifest.emptyStubCrates !== undefined) {
    assertManifest(
      Array.isArray(manifest.emptyStubCrates),
      "emptyStubCrates must be an array when present"
    );
  }
  assertManifest(
    isPlainObject(manifest.filePatches),
    "filePatches must be an object"
  );

  for (const [crateName, templateName] of Object.entries(
    manifest.stubTemplates
  )) {
    assertSimpleName(crateName, `stubTemplates key ${crateName}`);
    await assertStubTemplateFile(
      templatesDir,
      templateName,
      `stubTemplates.${crateName}`
    );
  }

  const emptyStubCrates = manifest.emptyStubCrates || [];
  const emptyStubSet = new Set(emptyStubCrates);

  for (const [index, crateName] of emptyStubCrates.entries()) {
    assertSimpleName(crateName, `emptyStubCrates[${index}]`);
  }

  for (const [index, crateName] of manifest.offendingCrates.entries()) {
    assertSimpleName(crateName, `offendingCrates[${index}]`);
    assertManifest(
      manifest.stubTemplates[crateName] || emptyStubSet.has(crateName),
      `offendingCrates[${index}] (${crateName}) must have a stubTemplates entry or an explicit emptyStubCrates entry`
    );
  }

  for (const key of REQUIRED_FILE_PATCHES) {
    await assertTemplateFile(
      templatesDir,
      manifest.filePatches[key],
      `filePatches.${key}`
    );
  }

  return {
    schemaVersion: manifest.schemaVersion,
    stubTemplates: manifest.stubTemplates,
    offendingCrates: manifest.offendingCrates,
    emptyStubCrates,
    filePatches: manifest.filePatches,
    manifestPath,
  };
}
