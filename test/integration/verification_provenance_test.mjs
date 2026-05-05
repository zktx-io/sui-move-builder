import { loadWasmBindings } from "./wasm_helpers.mjs";

const builder = await import(
  new URL("../../dist/lite/index.js", import.meta.url)
);
const verifier = await import(
  new URL("../../dist/verification/index.js", import.meta.url)
);

await builder.initMovePackageBuilder();
await verifier.initMovePackageVerifier();
const rawLite = await loadWasmBindings("lite");

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

async function dumpReference(files) {
  const result = await builder.dumpMovePackage({
    files,
    resolvedDependencies: resolvedDependencies(files),
    network: "mainnet",
    silenceWarnings: true,
  });
  if ("error" in result) {
    throw new Error(`dump reference build failed: ${result.error}`);
  }
  return result;
}

async function publishReference(files) {
  const resolved = resolvedDependencies(files);
  const result = rawLite.compile(
    resolved.files,
    resolved.dependencies,
    JSON.stringify({ compileIntent: "publish" })
  );
  const success =
    typeof result.success === "function" ? result.success() : result.success;
  const output =
    typeof result.output === "function" ? result.output() : result.output;
  if (!success) {
    throw new Error(`publish reference build failed: ${output}`);
  }
  return JSON.parse(output);
}

async function verify(files, reference, options = {}) {
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
const reference = await dumpReference(files);

const verifiedReference = await verify(files, {
  modules: reference.modules,
  dependencies: reference.dependencies,
  digest: reference.digest,
});
expectStatus(verifiedReference, "verified", "current reference");
expectNoFailureStage(verifiedReference, "verified reference");

const metadataReference = await verify(files, {
  modules: reference.modules,
  dependencies: reference.dependencies,
  toolchainVersion: "0.0.0-metadata-only",
  buildConfig: { edition: "2024", flavor: "sui" },
});
expectStatus(metadataReference, "verified", "metadata does not override bytes");
if (
  metadataReference.referenceSummary?.toolchainVersion !== "0.0.0-metadata-only"
) {
  throw new Error("reference toolchainVersion should be reported as evidence");
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

expectStatus(
  await verify(files, {
    modules: reference.modules,
    dependencies: reference.dependencies,
    digest: new Array(32).fill(0),
  }),
  "mismatch",
  "wrong digest"
);

const v6ReferenceModule = withHeaderVersion(reference.modules[0], 6);
const metadataToolchainMismatch = await verify(files, {
  modules: [v6ReferenceModule],
  dependencies: reference.dependencies,
  toolchainVersion: "0.0.0-metadata-only",
  buildConfig: { edition: "2024", flavor: "sui" },
});
expectStatus(
  metadataToolchainMismatch,
  "toolchain_mismatch",
  "v6 reference header"
);
expectNoFailureStage(metadataToolchainMismatch, "toolchain mismatch reference");
if (
  metadataToolchainMismatch.toolchainEvidence?.source !==
  "metadata+binary_header"
) {
  throw new Error(
    "toolchain evidence should record metadata plus header source"
  );
}
if (
  metadataToolchainMismatch.toolchainEvidence?.referenceToolchainVersion !==
  "0.0.0-metadata-only"
) {
  throw new Error(
    "toolchain evidence should include reference version metadata"
  );
}

const changedReference = await dumpReference(fixtureFiles({ value: 2 }));
const mismatchResult = await verify(files, {
  modules: changedReference.modules,
  dependencies: changedReference.dependencies,
});
expectStatus(mismatchResult, "mismatch", "same toolchain changed module");
expectNoFailureStage(mismatchResult, "same toolchain changed module");

const publishedAddress =
  "0x0000000000000000000000000000000000000000000000000000000000000042";
const publishedFiles = fixtureFiles({
  address: publishedAddress,
  publishedAt: publishedAddress,
});
const publishedReference = await publishReference(publishedFiles);
expectStatus(
  await verify(files, {
    modules: publishedReference.modules,
    dependencies: publishedReference.dependencies,
    rootAddress: publishedAddress,
  }),
  "verified",
  "published root address substitution"
);

expectStatus(
  await verify(
    publishedFiles,
    {
      modules: publishedReference.modules,
      dependencies: publishedReference.dependencies,
      packageId: publishedAddress,
    },
    { intent: "publish" }
  ),
  "verified",
  "publish intent accepts already populated package id"
);

const publishedDumpReference = await dumpReference(publishedFiles);
expectStatus(
  await verify(
    publishedFiles,
    {
      modules: publishedDumpReference.modules,
      dependencies: publishedDumpReference.dependencies,
    },
    { intent: "publish" }
  ),
  "mismatch",
  "publish intent does not verify dump bytecode"
);

expectStatus(
  await verify(
    files,
    {
      modules: reference.modules,
      dependencies: reference.dependencies,
    },
    { intent: "upgrade" }
  ),
  "verified",
  "upgrade intent matches dump root_as_zero bytecode"
);

const addressConstantFiles = fixtureFiles({
  address: publishedAddress,
  publishedAt: publishedAddress,
  includeAddressConstant: true,
});
const addressConstantPublishReference =
  await publishReference(addressConstantFiles);
expectStatus(
  await verify(addressConstantFiles, {
    modules: addressConstantPublishReference.modules,
    dependencies: addressConstantPublishReference.dependencies,
    rootAddress: publishedAddress,
  }),
  "mismatch",
  "root substitution alone does not hide embedded address differences"
);
expectStatus(
  await verify(
    addressConstantFiles,
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
