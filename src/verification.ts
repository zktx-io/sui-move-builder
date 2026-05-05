import {
  asFailure,
  loadWasm,
  MOVE_PACKAGE_INTENTS,
  type MovePackageIntent,
  type MovePackageInput,
  type MovePackageResolvedDependencies,
  type WasmModule,
} from "./core.js";
import {
  applyLegacyPublicationMigrationToFiles,
  compilerModes,
  emitMovePackageStageReports,
  resolveSnapshotDependencies,
  stripMovePackageStageReports,
} from "./dependencyResolution.js";
import { type LockfileV4Helpers } from "./resolver.js";

export type VerificationStatus =
  | "verified"
  | "toolchain_mismatch"
  | "mismatch"
  | "build_failure"
  | "invalid_reference";

export type VerificationFailureStage =
  | "wasm_init"
  | "dependency_resolution"
  | "input_validation"
  | "compile"
  | "compiler_output"
  | "verification_output";

export interface ReferenceArtifact {
  modules: string[];
  dependencies?: string[];
  digest?: number[] | string;
  /** Root package address for on-chain package module comparison. */
  rootAddress?: string;
  /** Alias for rootAddress when the caller has a package object ID. */
  packageId?: string;
  /** Declared Sui toolchain version for evidence only. Bytecode comparison remains authoritative. */
  toolchainVersion?: string;
  /** Declared build config for evidence only. */
  buildConfig?: VerificationBuildConfig;
}

export interface VerificationBuildConfig {
  edition?: string;
  flavor?: string;
}

export interface VerificationModuleSummary {
  length: number;
  version: number;
  flavor?: number;
  sha256: string;
  name?: string;
  address?: string;
  functionCount?: number;
  structCount?: number;
  constantCount?: number;
  deserializeError?: string;
}

export interface VerificationArtifactSummary {
  moduleCount: number;
  perModule: VerificationModuleSummary[];
  dependencies: string[];
  digest?: string;
  toolchainVersion?: string;
  buildConfig?: VerificationBuildConfig;
}

export interface VerificationHeaderEvidence {
  name?: string;
  address?: string;
  version: number;
  flavor?: number;
}

export interface VerificationToolchainEvidence {
  source: "binary_header" | "metadata+binary_header";
  reference: VerificationHeaderEvidence[];
  currentBuild: VerificationHeaderEvidence[];
  referenceToolchainVersion?: string;
  currentBuildToolchainVersion?: string;
  referenceBuildConfig?: VerificationBuildConfig;
}

export interface VerificationBytecodeDiff {
  module?: string;
  firstDiffOffset?: number;
  reference: VerificationModuleSummary;
  currentBuild: VerificationModuleSummary;
}

export interface VerificationCurrentBuild {
  modules: string[];
  dependencies: string[];
  digest: number[] | string;
  warnings?: string;
}

export interface MovePackageProvenanceResult {
  status: VerificationStatus;
  failureStage?: VerificationFailureStage;
  currentBuild?: VerificationCurrentBuild;
  referenceSummary?: VerificationArtifactSummary;
  currentSummary?: VerificationArtifactSummary;
  toolchainEvidence?: VerificationToolchainEvidence;
  differences?: string[];
  bytecodeDiffs?: VerificationBytecodeDiff[];
  error?: string;
}

export interface MovePackageProvenanceInput extends MovePackageInput {
  /**
   * Rebuild policy for the current source. Defaults to dump.
   * Dump and upgrade use root-as-zero; publish keeps the package root address.
   * Transaction callers pass the externally extracted Publish or Upgrade kind.
   */
  intent?: MovePackageIntent;
  reference: ReferenceArtifact;
}

const verificationIntents = new Set<MovePackageIntent>(MOVE_PACKAGE_INTENTS);

type VerificationIntentResult =
  | { ok: true; value: MovePackageIntent }
  | { ok: false; failure: MovePackageProvenanceResult };

type VerificationWasmModule = Pick<
  WasmModule,
  "sui_move_version" | "sui_version" | "verify_against_reference"
> & {
  verification_resolve_package_groups(inputJson: string): string;
};

/** Initialize the verification WASM module (idempotent). */
export async function initMovePackageVerifier(options?: {
  wasm?: string | URL | BufferSource;
}): Promise<void> {
  await loadWasm(options?.wasm);
}

/** Sui Move version baked into the verification WASM. */
export async function getPinnedSuiMoveVersion(options?: {
  wasm?: string | URL | BufferSource;
}): Promise<string> {
  const mod = await loadWasm(options?.wasm);
  return mod.sui_move_version();
}

/** Sui repo version baked into the verification WASM. */
export async function getPinnedSuiVersion(options?: {
  wasm?: string | URL | BufferSource;
}): Promise<string> {
  const mod = await loadWasm(options?.wasm);
  return mod.sui_version();
}

/**
 * Rebuild source and compare it to caller-provided reference bytecode.
 * Browser WASM builds use declared host/crypto/network compatibility boundaries; see SECURITY.md.
 * `failureStage` is a failure-only diagnostic and is absent from verified, mismatch, and toolchain-mismatch results.
 */
export async function verifyMovePackageProvenance(
  input: MovePackageProvenanceInput
): Promise<MovePackageProvenanceResult> {
  const intentResult = verificationIntent(input.intent);
  if (!intentResult.ok) {
    return intentResult.failure;
  }
  const intent = intentResult.value;

  let mod: VerificationWasmModule;
  try {
    mod = (await loadWasm(input.wasm)) as unknown as VerificationWasmModule;
  } catch (error) {
    const failure = asFailure(error, "wasm_init");
    return buildFailure(failure.error, "wasm_init");
  }

  let resolved;
  try {
    resolved =
      input.resolvedDependencies ??
      (await resolveVerificationDependencies(input, mod));
  } catch (error) {
    const failure = asFailure(error, "dependency_resolution");
    return buildFailure(failure.error, "dependency_resolution");
  }

  let raw: string;
  try {
    raw = mod.verify_against_reference(
      JSON.stringify({
        files: resolved.files,
        dependencies: resolved.dependencies,
        options: {
          silenceWarnings: input.silenceWarnings,
          lintFlag: input.lintFlag,
          stripMetadata: input.stripMetadata,
          ansiColor: input.ansiColor,
          compileIntent: intent,
          withUnpublishedDependencies: input.withUnpublishedDependencies,
          modes: compilerModes(input),
        },
        reference: input.reference,
      })
    );
  } catch (error) {
    const failure = asFailure(error, "compiler_output");
    return buildFailure(failure.error, "verification_output");
  }

  try {
    return JSON.parse(raw) as MovePackageProvenanceResult;
  } catch (error) {
    const failure = asFailure(error, "compiler_output");
    return buildFailure(failure.error, "verification_output");
  }
}

function verificationIntent(
  intent: MovePackageProvenanceInput["intent"] | unknown
): VerificationIntentResult {
  if (intent === undefined) {
    return { ok: true, value: "dump" };
  }
  if (
    typeof intent === "string" &&
    verificationIntents.has(intent as MovePackageIntent)
  ) {
    return { ok: true, value: intent as MovePackageIntent };
  }
  return {
    ok: false,
    failure: buildFailure(
      `Invalid verification intent '${String(
        intent
      )}'. Expected one of: ${MOVE_PACKAGE_INTENTS.join(", ")}`,
      "input_validation"
    ),
  };
}

function buildFailure(
  error: string,
  failureStage: VerificationFailureStage
): MovePackageProvenanceResult {
  return {
    status: "build_failure",
    failureStage,
    error,
  };
}

function verificationResolverHelpers(
  mod: VerificationWasmModule
): LockfileV4Helpers {
  return {
    fetchPlan: (moveLockToml, environment) =>
      mod.verification_resolve_package_groups(
        JSON.stringify({
          operation: "lockfileFetchPlan",
          moveLockToml,
          environment,
        })
      ),
    resolvePackageGroups: (inputJson) =>
      mod.verification_resolve_package_groups(
        JSON.stringify({
          operation: "lockfileResolvePackageGroups",
          input: JSON.parse(inputJson),
        })
      ),
    manifestGraphResolvePackageGroups: (inputJson) =>
      mod.verification_resolve_package_groups(
        JSON.stringify({
          operation: "manifestGraphResolvePackageGroups",
          input: JSON.parse(inputJson),
        })
      ),
  };
}

async function resolveVerificationDependencies(
  input: Omit<MovePackageProvenanceInput, "resolvedDependencies">,
  mod: VerificationWasmModule
): Promise<MovePackageResolvedDependencies> {
  const resolved = await resolveSnapshotDependencies(
    input,
    verificationResolverHelpers(mod),
    (files) => {
      applyLegacyPublicationMigrationToFiles(
        files,
        (migrationFiles) =>
          mod.verification_resolve_package_groups(
            JSON.stringify({
              operation: "legacyPublicationMigration",
              input: { files: migrationFiles },
            })
          ),
        "Rust verification resolver"
      );
    }
  );
  emitMovePackageStageReports(input.onProgress, resolved.stageReports);
  return stripMovePackageStageReports(resolved);
}
