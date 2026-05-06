import { loadWasmBindings } from "./wasm_helpers.mjs";

const verifier = await import(
  new URL("../../dist/verification/index.js", import.meta.url)
);

await verifier.initMovePackageVerifier();
const rawLite = await loadWasmBindings("lite");
const rawVerification = await loadWasmBindings("verification");

function frameworkPackage(id, addressName, localPath) {
  const publishedAt = id === "Sui" ? "0x2" : "0x1";
  return {
    name: id,
    files: {
      [`dependencies/${id}/Move.toml`]: `
[package]
name = "${id}"
version = "0.0.0"
edition = "2024"
published-at = "${publishedAt}"

[addresses]
${addressName} = "${publishedAt}"
`,
      [`dependencies/${id}/sources/dummy.move`]: `
module ${addressName}::dummy {
    public fun value(): u64 { 0 }
}
`,
    },
    edition: "2024",
    addressMapping: {
      [id]: publishedAt,
      [addressName]: publishedAt,
    },
    publishedIdForOutput: publishedAt,
    source: { type: "local", local: localPath },
    manifestDeps: [],
    manifest: {
      name: id,
      dependencies: {},
    },
  };
}

function frameworkDeps() {
  return [
    frameworkPackage("MoveStdlib", "std", "../move-stdlib"),
    frameworkPackage("Sui", "sui", "../sui"),
  ];
}

function fixtureFiles({
  value = 1,
  address = "0x0",
  publishedAt,
  includeAddressConstant = false,
} = {}) {
  const publishedAtLine = publishedAt ? `published-at = "${publishedAt}"` : "";
  const addressConstant = includeAddressConstant
    ? `
    const ROOT: address = @verify_fixture;
    public fun root(): address { ROOT }
`
    : "";
  return {
    "Move.toml": `
[package]
name = "VerifyFixture"
version = "0.0.0"
edition = "2024"
${publishedAtLine}

[addresses]
verify_fixture = "${address}"
`,
    "sources/main.move": `
module verify_fixture::main {
    public fun value(): u64 { ${value} }
${addressConstant}
}
`,
  };
}

function resolvedDependencies(files) {
  const dependencies = frameworkDeps();
  return {
    files: JSON.stringify(files),
    dependencies: JSON.stringify(dependencies),
    lockfileDependencies: JSON.stringify(dependencies),
  };
}

async function compileReference(files, intent) {
  const resolved = resolvedDependencies(files);
  const result = rawLite.compile(
    resolved.files,
    resolved.dependencies,
    JSON.stringify({ compileIntent: intent })
  );
  const success =
    typeof result.success === "function" ? result.success() : result.success;
  const output =
    typeof result.output === "function" ? result.output() : result.output;
  if (!success) {
    throw new Error(`${intent} reference build failed: ${output}`);
  }
  return JSON.parse(output);
}

function publishReference(files) {
  return compileReference(files, "publish");
}

function upgradeReference(files) {
  return compileReference(files, "upgrade");
}

async function verify(files, reference, options = { intent: "publish" }) {
  const result = await verifier.verifyMovePackageProvenance({
    files,
    resolvedDependencies: resolvedDependencies(files),
    network: "mainnet",
    silenceWarnings: true,
    ...options,
    reference,
  });
  if (!result?.status) {
    throw new Error("verification result has no status");
  }
  return result;
}

function rawVerify(files, reference, options) {
  const resolved = resolvedDependencies(files);
  return JSON.parse(
    rawVerification.verify_against_reference(
      JSON.stringify({
        files: resolved.files,
        dependencies: resolved.dependencies,
        options,
        reference,
      })
    )
  );
}

function expectStatus(result, status, label) {
  if (result.status !== status) {
    throw new Error(
      `${label}: expected ${status}, got ${result.status}: ${JSON.stringify(
        result,
        null,
        2
      )}`
    );
  }
}

function expectVerdict(result, verdict, label) {
  if (result.verdict !== verdict) {
    throw new Error(
      `${label}: expected verdict ${verdict}, got ${result.verdict}: ${JSON.stringify(
        result,
        null,
        2
      )}`
    );
  }
}

function expectFailureStage(result, stage, label) {
  if (result.failureStage !== stage) {
    throw new Error(
      `${label}: expected failureStage ${stage}, got ${result.failureStage}: ${JSON.stringify(
        result,
        null,
        2
      )}`
    );
  }
}

function expectErrorIncludes(result, text, label) {
  if (!result.error?.includes(text)) {
    throw new Error(
      `${label}: expected error to include ${text}, got ${result.error}: ${JSON.stringify(
        result,
        null,
        2
      )}`
    );
  }
}

function expectNoFailureStage(result, label) {
  if (result.failureStage !== undefined) {
    throw new Error(
      `${label}: expected no failureStage, got ${result.failureStage}: ${JSON.stringify(
        result,
        null,
        2
      )}`
    );
  }
}

function withHeaderVersion(base64, version) {
  const bytes = Buffer.from(base64, "base64");
  bytes.writeUInt32LE(version, 4);
  return bytes.toString("base64");
}

const files = fixtureFiles();
const reference = await publishReference(files);

const verifiedReference = await verify(files, {
  modules: reference.modules,
  dependencies: reference.dependencies,
  digest: reference.digest,
});
expectStatus(verifiedReference, "verified", "current reference");
expectVerdict(verifiedReference, "exact_bytecode_match", "current reference");
expectNoFailureStage(verifiedReference, "verified reference");

const metadataReference = await verify(files, {
  modules: reference.modules,
  dependencies: reference.dependencies,
  cliVersion: "0.0.0-metadata-only",
  buildConfig: { edition: "2024", flavor: "sui" },
});
expectStatus(metadataReference, "verified", "metadata does not override bytes");
expectVerdict(
  metadataReference,
  "exact_bytecode_match",
  "metadata does not override bytes"
);
if (metadataReference.referenceSummary?.cliVersion !== "0.0.0-metadata-only") {
  throw new Error("reference cliVersion should be reported as evidence");
}
if (metadataReference.referenceSummary?.buildConfig?.flavor !== "sui") {
  throw new Error("reference buildConfig should be reported as evidence");
}

expectStatus(
  await verify(files, {
    modules: reference.modules,
    dependencies: reference.dependencies,
  }),
  "verified",
  "reference without digest"
);

const wrongDigestResult = await verify(files, {
  modules: reference.modules,
  dependencies: reference.dependencies,
  digest: new Array(32).fill(0),
});
expectStatus(wrongDigestResult, "mismatch", "wrong digest");
expectVerdict(wrongDigestResult, "semantic_mismatch", "wrong digest");

const v6ReferenceModule = withHeaderVersion(reference.modules[0], 6);
const metadataBytecodeVersionMismatch = await verify(files, {
  modules: [v6ReferenceModule],
  dependencies: reference.dependencies,
  cliVersion: "0.0.0-metadata-only",
  buildConfig: { edition: "2024", flavor: "sui" },
});
expectStatus(
  metadataBytecodeVersionMismatch,
  "bytecode_version_mismatch",
  "synthetic_header_only reference"
);
expectVerdict(
  metadataBytecodeVersionMismatch,
  "bytecode_version_header_mismatch",
  "synthetic_header_only reference"
);
expectNoFailureStage(
  metadataBytecodeVersionMismatch,
  "bytecode version mismatch reference"
);
if (
  metadataBytecodeVersionMismatch.bytecodeDiffs?.[0]?.sameExceptVersionWord !==
  true
) {
  throw new Error(
    `synthetic_header_only should differ only in the version word: ${JSON.stringify(
      metadataBytecodeVersionMismatch,
      null,
      2
    )}`
  );
}
if (
  metadataBytecodeVersionMismatch.bytecodeHeaderEvidence?.source !==
  "metadata+binary_header"
) {
  throw new Error(
    "bytecode header evidence should record metadata plus header source"
  );
}
if (
  metadataBytecodeVersionMismatch.bytecodeHeaderEvidence
    ?.referenceCliVersion !== "0.0.0-metadata-only"
) {
  throw new Error(
    "bytecode header evidence should include reference version metadata"
  );
}

const changedReference = await publishReference(fixtureFiles({ value: 2 }));
const mismatchResult = await verify(files, {
  modules: changedReference.modules,
  dependencies: changedReference.dependencies,
});
expectStatus(
  mismatchResult,
  "mismatch",
  "same bytecode version changed module"
);
expectVerdict(
  mismatchResult,
  "semantic_mismatch",
  "same bytecode version changed module"
);
expectNoFailureStage(mismatchResult, "same bytecode version changed module");
if (!mismatchResult.bytecodeDiffs?.some((diff) => diff.identity?.matches)) {
  throw new Error(
    `same-bytecode version mismatch should include bytecode identity evidence: ${JSON.stringify(
      mismatchResult,
      null,
      2
    )}`
  );
}

const publishedAddress =
  "0x0000000000000000000000000000000000000000000000000000000000000042";
const zeroAddress =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const publishedFiles = fixtureFiles({
  address: publishedAddress,
  publishedAt: publishedAddress,
});
const publishedReference = await publishReference(publishedFiles);
const publishedRootSubstitutionResult = await verify(files, {
  modules: publishedReference.modules,
  dependencies: publishedReference.dependencies,
  rootAddress: publishedAddress,
});
expectStatus(
  publishedRootSubstitutionResult,
  "verified",
  "published root address substitution"
);
expectVerdict(
  publishedRootSubstitutionResult,
  "root_address_substitution_match",
  "published root address substitution"
);
if (
  publishedRootSubstitutionResult.referenceSummary?.perModule?.[0]?.sha256 ===
  publishedRootSubstitutionResult.currentSummary?.perModule?.[0]?.sha256
) {
  throw new Error(
    `root substitution should not be reported as raw byte equality: ${JSON.stringify(
      publishedRootSubstitutionResult,
      null,
      2
    )}`
  );
}
if (
  !publishedRootSubstitutionResult.bytecodeDiffs?.some(
    (diff) =>
      diff.classification === "root_address_substitution_match" &&
      diff.rawBytesMatch === false &&
      diff.semanticMatch === true &&
      diff.rootAddressSubstitutionApplied === true &&
      diff.identity?.currentBuildOriginalAddress === zeroAddress
  )
) {
  throw new Error(
    `root substitution should include raw/semantic bytecode evidence: ${JSON.stringify(
      publishedRootSubstitutionResult,
      null,
      2
    )}`
  );
}
if (
  publishedRootSubstitutionResult.currentSummary?.perModule?.[0]
    ?.originalAddress !== zeroAddress
) {
  throw new Error(
    `root substitution should preserve the original current address: ${JSON.stringify(
      publishedRootSubstitutionResult,
      null,
      2
    )}`
  );
}

const publishIntentResult = await verify(
  publishedFiles,
  {
    modules: publishedReference.modules,
    dependencies: publishedReference.dependencies,
    packageId: publishedAddress,
  },
  { intent: "publish" }
);
expectStatus(
  publishIntentResult,
  "verified",
  "publish intent accepts already populated package id"
);
expectVerdict(
  publishIntentResult,
  "exact_bytecode_match",
  "publish intent accepts already populated package id"
);
if (
  publishIntentResult.referenceSummary?.perModule?.[0]?.sha256 !==
  publishIntentResult.currentSummary?.perModule?.[0]?.sha256
) {
  throw new Error(
    `publish intent should preserve raw byte equality: ${JSON.stringify(
      publishIntentResult,
      null,
      2
    )}`
  );
}

const wrongRootAddress =
  "0x0000000000000000000000000000000000000000000000000000000000000099";
const publishWrongRootResult = await verify(
  publishedFiles,
  {
    modules: publishedReference.modules,
    dependencies: publishedReference.dependencies,
    rootAddress: wrongRootAddress,
  },
  { intent: "publish" }
);
expectStatus(
  publishWrongRootResult,
  "mismatch",
  "publish intent rejects conflicting rootAddress"
);
expectVerdict(
  publishWrongRootResult,
  "semantic_mismatch",
  "publish intent rejects conflicting rootAddress"
);
expectNoFailureStage(
  publishWrongRootResult,
  "publish intent rejects conflicting rootAddress"
);
if (
  !publishWrongRootResult.bytecodeDiffs?.some(
    (diff) =>
      diff.classification === "semantic_mismatch" &&
      diff.rootAddressConflict?.requestedRootAddress === wrongRootAddress &&
      diff.rootAddressConflict?.currentBuildAddress === publishedAddress
  )
) {
  throw new Error(
    `wrong rootAddress should be reported as semantic mismatch evidence: ${JSON.stringify(
      publishWrongRootResult,
      null,
      2
    )}`
  );
}

const publishedUpgradeReference = await upgradeReference(publishedFiles);
expectStatus(
  await verify(
    publishedFiles,
    {
      modules: publishedUpgradeReference.modules,
      dependencies: publishedUpgradeReference.dependencies,
    },
    { intent: "publish" }
  ),
  "mismatch",
  "publish intent does not verify upgrade bytecode"
);

const upgradeReferenceOutput = await upgradeReference(files);
expectStatus(
  await verify(
    files,
    {
      modules: upgradeReferenceOutput.modules,
      dependencies: upgradeReferenceOutput.dependencies,
    },
    { intent: "upgrade" }
  ),
  "verified",
  "upgrade intent verifies upgrade bytecode"
);
const upgradeReferenceWithPackageIdResult = await verify(
  files,
  {
    modules: upgradeReferenceOutput.modules,
    dependencies: upgradeReferenceOutput.dependencies,
    packageId: publishedAddress,
  },
  { intent: "upgrade" }
);
expectStatus(
  upgradeReferenceWithPackageIdResult,
  "verified",
  "upgrade intent keeps zero-root bytecode identity"
);
expectVerdict(
  upgradeReferenceWithPackageIdResult,
  "exact_bytecode_match",
  "upgrade intent keeps zero-root bytecode identity"
);

const zeroAddressConstantFiles = fixtureFiles({
  includeAddressConstant: true,
});
const publishedAddressConstantFiles = fixtureFiles({
  address: publishedAddress,
  publishedAt: publishedAddress,
  includeAddressConstant: true,
});
const addressConstantPublishReference = await publishReference(
  publishedAddressConstantFiles
);
expectStatus(
  await verify(
    zeroAddressConstantFiles,
    {
      modules: addressConstantPublishReference.modules,
      dependencies: addressConstantPublishReference.dependencies,
      rootAddress: publishedAddress,
    },
    { intent: "publish" }
  ),
  "mismatch",
  "root substitution alone does not hide embedded address differences"
);
expectStatus(
  await verify(
    publishedAddressConstantFiles,
    {
      modules: addressConstantPublishReference.modules,
      dependencies: addressConstantPublishReference.dependencies,
      packageId: publishedAddress,
    },
    { intent: "publish" }
  ),
  "verified",
  "publish intent verifies embedded address bytecode"
);

const missingIntentResult = await verifier.verifyMovePackageProvenance({
  files,
  resolvedDependencies: resolvedDependencies(files),
  network: "mainnet",
  silenceWarnings: true,
  reference: {
    modules: reference.modules,
  },
});
expectStatus(
  missingIntentResult,
  "build_failure",
  "missing verification intent"
);
expectFailureStage(
  missingIntentResult,
  "input_validation",
  "missing verification intent"
);

const dumpIntentResult = await verify(
  files,
  {
    modules: reference.modules,
  },
  { intent: "dump" }
);
expectStatus(dumpIntentResult, "build_failure", "dump verification intent");
expectFailureStage(
  dumpIntentResult,
  "input_validation",
  "dump verification intent"
);

const rawMissingIntentResult = rawVerify(
  files,
  {
    modules: reference.modules,
  },
  {}
);
expectStatus(
  rawMissingIntentResult,
  "build_failure",
  "raw missing verification intent"
);
expectFailureStage(
  rawMissingIntentResult,
  "input_validation",
  "raw missing verification intent"
);

const rawDumpIntentResult = rawVerify(
  files,
  {
    modules: reference.modules,
  },
  { compileIntent: "dump" }
);
expectStatus(
  rawDumpIntentResult,
  "build_failure",
  "raw dump verification intent"
);
expectFailureStage(
  rawDumpIntentResult,
  "input_validation",
  "raw dump verification intent"
);

const rawNumericIntentResult = rawVerify(
  files,
  {
    modules: reference.modules,
  },
  { compileIntent: 42 }
);
expectStatus(
  rawNumericIntentResult,
  "build_failure",
  "raw numeric verification intent"
);
expectFailureStage(
  rawNumericIntentResult,
  "input_validation",
  "raw numeric verification intent"
);
expectErrorIncludes(
  rawNumericIntentResult,
  "42",
  "raw numeric verification intent"
);

const invalidIntentResult = await verify(
  files,
  {
    modules: reference.modules,
  },
  { intent: "invalid" }
);
expectStatus(
  invalidIntentResult,
  "build_failure",
  "invalid verification intent"
);
expectFailureStage(
  invalidIntentResult,
  "input_validation",
  "invalid verification intent"
);

const malformedReferenceResult = await verify(files, {
  modules: ["AA=="],
});
expectStatus(
  malformedReferenceResult,
  "invalid_reference",
  "malformed reference"
);
expectFailureStage(
  malformedReferenceResult,
  "input_validation",
  "Rust input_validation failureStage should pass through TS unchanged"
);

const badFiles = {
  ...files,
  "sources/main.move": "module verify_fixture::main { public fun broken( }",
};
const compileFailureResult = await verify(badFiles, {
  modules: reference.modules,
});
expectStatus(compileFailureResult, "build_failure", "source compile failure");
expectFailureStage(compileFailureResult, "compile", "source compile failure");

const dependencyFailureFiles = {
  ...files,
  "Move.toml": `
[package]
name = "VerifyFixture"
version = "0.0.0"
edition = "2024"

[addresses]
verify_fixture = "0x0"

[dependencies]
MissingLocal = { local = "../missing-local" }
`,
};
const dependencyFailureResult = await verifier.verifyMovePackageProvenance({
  files: dependencyFailureFiles,
  intent: "publish",
  network: "mainnet",
  silenceWarnings: true,
  reference: {
    modules: reference.modules,
  },
});
expectStatus(
  dependencyFailureResult,
  "build_failure",
  "dependency resolution failure"
);
expectFailureStage(
  dependencyFailureResult,
  "dependency_resolution",
  "dependency resolution failure"
);

console.log("[OK] verification provenance checks passed");
