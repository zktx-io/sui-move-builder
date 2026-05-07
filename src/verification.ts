import {
  asFailure,
  loadWasm,
  type MovePackageIntent,
  type MovePackageInput,
  type MovePackageResolvedDependencies,
} from "./core.js";
import {
  applyLegacyPublicationMigrationToFiles,
  compilerModes,
  emitMovePackageStageReports,
  resolveSnapshotDependencies,
  stripMovePackageStageReports,
} from "./dependencyResolution.js";
import { type LockfileV4Helpers } from "./resolver.js";
import { displayMessageForResult } from "./verificationMessages.js";
import {
  loadVerificationWasm,
  type LoadedVerificationWasm,
  type VerificationWasmModule,
} from "./verificationWasmLoader.js";

export type VerificationStatus =
  | "verified"
  | "bytecode_version_mismatch"
  | "mismatch"
  | "build_failure"
  | "invalid_reference";

export type VerificationVerdict =
  | "exact_bytecode_match"
  | "root_address_substitution_match"
  | "bytecode_version_header_mismatch"
  | "bytecode_format_drift"
  | "semantic_mismatch"
  | "unverified";

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
  /** Declared Sui CLI version for evidence only. Bytecode comparison remains authoritative. */
  cliVersion?: string;
  /** Declared build config for evidence only. */
  buildConfig?: VerificationBuildConfig;
}

export interface VerificationBuildConfig {
  edition?: string;
  flavor?: string;
}

export interface VerificationSelectedVerifier {
  verifierId: string;
  suiVersion?: string;
  decodedBytecodeVersion?: number;
  bytecodeFlavor?: number | null;
}

export interface VerificationReferenceBytecode {
  decodedVersion?: number;
  flavor?: number | null;
  moduleCount: number;
}

export interface VerificationSourceEditionEvidence {
  source: "root" | "dependency";
  packageName?: string;
  manifestPath?: string;
  declaredEdition?: string;
  effectiveEdition: string;
  defaulted: boolean;
  supported: boolean;
}

export interface VerificationSourceCompatibility {
  supportedEditions: string[];
  defaultEdition: string;
  root?: VerificationSourceEditionEvidence;
  dependencies?: VerificationSourceEditionEvidence[];
  unsupportedEditions: VerificationSourceEditionEvidence[];
}

export interface VerificationModuleSummary {
  length: number;
  version: number;
  flavor?: number;
  sha256: string;
  name?: string;
  address?: string;
  originalAddress?: string;
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
  cliVersion?: string;
  buildConfig?: VerificationBuildConfig;
}

export interface VerificationHeaderEvidence {
  name?: string;
  address?: string;
  version: number;
  flavor?: number;
}

export interface VerificationBytecodeHeaderEvidence {
  source: "binary_header" | "metadata+binary_header";
  reference: VerificationHeaderEvidence[];
  currentBuild: VerificationHeaderEvidence[];
  /** Caller-declared Sui CLI version for the reference artifact, when provided. */
  referenceCliVersion?: string;
  /** Sui source version baked into the verifier WASM, not a local CLI probe. */
  currentVerifierSuiVersion?: string;
  referenceBuildConfig?: VerificationBuildConfig;
}

export interface VerificationBytecodeDiff {
  module?: string;
  classification: VerificationVerdict;
  firstDiffOffset?: number;
  changedSections?: string[];
  changedTables?: VerificationChangedTable[];
  rawBytesMatch: boolean;
  semanticMatch: boolean;
  rootAddressSubstitutionApplied: boolean;
  rootAddressConflict?: VerificationRootAddressConflict;
  sameExceptVersionWord: boolean;
  identity: VerificationBytecodeIdentityEvidence;
  shape: VerificationBytecodeShapeEvidence;
  reference: VerificationModuleSummary;
  currentBuild: VerificationModuleSummary;
}

export interface VerificationChangedTable {
  name: string;
  referenceBytes?: number;
  currentBuildBytes?: number;
  referenceSha256?: string;
  currentBuildSha256?: string;
  sameSha256: boolean;
  sameBytes: boolean;
}

export interface VerificationRootAddressConflict {
  requestedRootAddress: string;
  currentBuildAddress: string;
}

export interface VerificationBytecodeIdentityEvidence {
  matches: boolean;
  referenceName?: string;
  currentBuildName?: string;
  referenceAddress?: string;
  currentBuildAddress?: string;
  referenceOriginalAddress?: string;
  currentBuildOriginalAddress?: string;
}

export interface VerificationBytecodeShapeEvidence {
  matches: boolean;
  referenceFunctionCount?: number;
  currentBuildFunctionCount?: number;
  referenceStructCount?: number;
  currentBuildStructCount?: number;
  referenceConstantCount?: number;
  currentBuildConstantCount?: number;
}

export interface VerificationCurrentBuild {
  modules: string[];
  dependencies: string[];
  digest: number[] | string;
  warnings?: string;
}

export interface MovePackageProvenanceResult {
  status: VerificationStatus;
  verdict?: VerificationVerdict;
  summary?: string;
  displayMessage?: string;
  failureStage?: VerificationFailureStage;
  selectedVerifier?: VerificationSelectedVerifier;
  referenceBytecode?: VerificationReferenceBytecode;
  sourceCompatibility?: VerificationSourceCompatibility;
  currentBuild?: VerificationCurrentBuild;
  referenceSummary?: VerificationArtifactSummary;
  currentSummary?: VerificationArtifactSummary;
  bytecodeHeaderEvidence?: VerificationBytecodeHeaderEvidence;
  differences?: string[];
  bytecodeDiffs?: VerificationBytecodeDiff[];
  error?: string;
}

export interface MovePackageProvenanceInput extends MovePackageInput {
  /**
   * Rebuild policy for the current source.
   * Transaction callers pass the externally extracted Publish or Upgrade kind.
   * Publish keeps the package root address; upgrade uses root-as-zero.
   */
  intent: VerificationProvenanceIntent;
  reference: ReferenceArtifact;
}

export type VerificationProvenanceIntent = Extract<
  MovePackageIntent,
  "publish" | "upgrade"
>;

const VERIFICATION_PROVENANCE_INTENTS = [
  "publish",
  "upgrade",
] as const satisfies readonly VerificationProvenanceIntent[];
const verificationIntents = new Set<VerificationProvenanceIntent>(
  VERIFICATION_PROVENANCE_INTENTS
);

type VerificationIntentResult =
  | { ok: true; value: VerificationProvenanceIntent }
  | { ok: false; failure: MovePackageProvenanceResult };

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
 * `failureStage` is a failure-only diagnostic and is absent from verified, mismatch, and bytecode-version-mismatch results.
 */
export async function verifyMovePackageProvenance(
  input: MovePackageProvenanceInput
): Promise<MovePackageProvenanceResult> {
  const intentResult = verificationIntent(input.intent);
  if (!intentResult.ok) {
    return intentResult.failure;
  }
  const intent = intentResult.value;

  let loaded: LoadedVerificationWasm;
  try {
    loaded = await loadVerificationWasm(input);
  } catch (error) {
    if (isMovePackageProvenanceResult(error)) {
      return error;
    }
    const failure = asFailure(error, "wasm_init");
    return buildFailure(failure.error, "wasm_init");
  }
  const { mod } = loaded;

  let resolved;
  try {
    resolved =
      input.resolvedDependencies ??
      (await resolveVerificationDependencies(input, mod));
  } catch (error) {
    const failure = asFailure(error, "dependency_resolution");
    return completeVerificationResult(
      buildFailure(failure.error, "dependency_resolution"),
      loaded
    );
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
    return completeVerificationResult(
      JSON.parse(raw) as MovePackageProvenanceResult,
      loaded
    );
  } catch (error) {
    const failure = asFailure(error, "compiler_output");
    return completeVerificationResult(
      buildFailure(failure.error, "verification_output"),
      loaded
    );
  }
}

function verificationIntent(
  intent: MovePackageProvenanceInput["intent"] | unknown
): VerificationIntentResult {
  if (
    typeof intent === "string" &&
    verificationIntents.has(intent as VerificationProvenanceIntent)
  ) {
    return { ok: true, value: intent as VerificationProvenanceIntent };
  }
  return {
    ok: false,
    failure: buildFailure(
      `Invalid verification intent '${String(
        intent
      )}'. Expected one of: ${VERIFICATION_PROVENANCE_INTENTS.join(", ")}`,
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
    displayMessage: `Verification failed at ${failureStage}: ${error}`,
  };
}

function isMovePackageProvenanceResult(
  value: unknown
): value is MovePackageProvenanceResult {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as MovePackageProvenanceResult).status === "string"
  );
}

function completeVerificationResult(
  result: MovePackageProvenanceResult,
  loaded: LoadedVerificationWasm
): MovePackageProvenanceResult {
  const completed: MovePackageProvenanceResult = {
    ...result,
    selectedVerifier: result.selectedVerifier ?? loaded.selectedVerifier,
    referenceBytecode: result.referenceBytecode ?? loaded.referenceBytecode,
  };
  completed.displayMessage ??= displayMessageForResult(completed);
  return completed;
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
