import {
  asFailure,
  loadWasm,
  type MovePackageIntent,
  type MovePackageInput,
  type MovePackageResolvedDependencies,
  type WasmModule,
  withNodeFileFetch,
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
  failureStage?: VerificationFailureStage;
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

type VerificationWasmModule = Pick<
  WasmModule,
  "sui_move_version" | "sui_version" | "verify_against_reference"
> & {
  verification_resolve_package_groups(inputJson: string): string;
};

type VerificationWasmInitializerModule = VerificationWasmModule & {
  default(init?: unknown): Promise<unknown>;
};

interface BundledBytecodeVerifierRoute {
  verifierId: string;
  importSpecifier: string;
}

const CURRENT_BYTECODE_VERSION = 7;
const BUNDLED_BYTECODE_VERIFIER_ROUTES: ReadonlyMap<
  number,
  BundledBytecodeVerifierRoute
> = new Map([
  [
    6,
    {
      verifierId: "sui-1.26.2",
      importSpecifier: "./v6/sui_move_wasm.js",
    },
  ],
]);
const bundledBytecodeVerifierReady = new Map<
  number,
  Promise<VerificationWasmModule>
>();

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

  let mod: VerificationWasmModule;
  try {
    mod = await loadVerificationWasm(input);
  } catch (error) {
    if (isMovePackageProvenanceResult(error)) {
      return error;
    }
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

async function loadVerificationWasm(
  input: MovePackageProvenanceInput
): Promise<VerificationWasmModule> {
  if (input.wasm) {
    return (await loadWasm(input.wasm)) as unknown as VerificationWasmModule;
  }

  const bytecodeVersion = referenceBytecodeVersion(input.reference);
  if (
    bytecodeVersion === undefined ||
    bytecodeVersion === CURRENT_BYTECODE_VERSION
  ) {
    return (await loadWasm()) as unknown as VerificationWasmModule;
  }

  const route = BUNDLED_BYTECODE_VERIFIER_ROUTES.get(bytecodeVersion);
  if (!route) {
    throw unsupportedBytecodeVersion(bytecodeVersion);
  }

  return loadBundledBytecodeVerifier(bytecodeVersion, route);
}

function unsupportedBytecodeVersion(
  bytecodeVersion: number
): MovePackageProvenanceResult {
  return {
    status: "bytecode_version_mismatch",
    verdict: "unverified",
    summary: `Decoded bytecode version ${bytecodeVersion} is not supported by this verifier package.`,
    error: `Unsupported decoded bytecode version ${bytecodeVersion}. Supported bundled verifier versions: ${[
      CURRENT_BYTECODE_VERSION,
      ...BUNDLED_BYTECODE_VERIFIER_ROUTES.keys(),
    ]
      .sort((left, right) => left - right)
      .join(", ")}`,
  };
}

async function loadBundledBytecodeVerifier(
  bytecodeVersion: number,
  route: BundledBytecodeVerifierRoute
): Promise<VerificationWasmModule> {
  let ready = bundledBytecodeVerifierReady.get(bytecodeVersion);
  if (!ready) {
    ready = importVerificationWasm(route.importSpecifier).then(async (mod) => {
      await withNodeFileFetch(async () => {
        await mod.default({});
      });
      return mod;
    });
    bundledBytecodeVerifierReady.set(bytecodeVersion, ready);
  }
  return ready;
}

async function importVerificationWasm(
  specifier: string
): Promise<VerificationWasmInitializerModule> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)"
  ) as (specifier: string) => Promise<VerificationWasmInitializerModule>;
  return dynamicImport(specifier);
}

function referenceBytecodeVersion(
  reference: ReferenceArtifact
): number | undefined {
  const versions = new Set<number>();
  for (const moduleBase64 of reference.modules) {
    const version = moduleBytecodeVersion(moduleBase64);
    if (version === undefined) {
      return undefined;
    }
    versions.add(version);
  }
  if (versions.size !== 1) {
    return undefined;
  }
  return versions.values().next().value as number;
}

function moduleBytecodeVersion(moduleBase64: string): number | undefined {
  const header = decodeBase64Prefix(moduleBase64, 8);
  if (!header || header.length < 8) {
    return undefined;
  }
  const rawVersionWord =
    (header[4] | (header[5] << 8) | (header[6] << 16) | (header[7] << 24)) >>>
    0;
  return rawVersionWord & 0x00ff_ffff;
}

function decodeBase64Prefix(
  value: string,
  length: number
): Uint8Array | undefined {
  const bufferCtor = (globalThis as any).Buffer;
  if (typeof bufferCtor?.from === "function") {
    const decoded = bufferCtor.from(value, "base64");
    return new Uint8Array(decoded.subarray(0, length));
  }

  const atobFn = (globalThis as any).atob;
  if (typeof atobFn !== "function") {
    return undefined;
  }

  try {
    const decoded = atobFn(value);
    const bytes = new Uint8Array(Math.min(length, decoded.length));
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
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
