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

type VerificationWasmModule = Pick<
  WasmModule,
  "sui_move_version" | "sui_version" | "verify_against_reference"
> & {
  verification_resolve_package_groups(inputJson: string): string;
};

type VerificationWasmInitializerModule = VerificationWasmModule & {
  default(init?: unknown): Promise<unknown>;
};

interface LoadedVerificationWasm {
  mod: VerificationWasmModule;
  selectedVerifier: VerificationSelectedVerifier;
  referenceBytecode: VerificationReferenceBytecode;
}

interface BundledBytecodeVerifierRoute {
  verifierId: string;
  importSpecifier: string;
}

const CURRENT_VERIFIER_ID = "sui-1.70.2";
const CURRENT_BYTECODE_VERSION = 7;
const CURRENT_BYTECODE_FLAVOR = 5;
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
      loaded,
      JSON.stringify(input.files),
      "[]"
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
      loaded,
      resolved.files,
      resolved.dependencies
    );
  } catch (error) {
    const failure = asFailure(error, "compiler_output");
    return completeVerificationResult(
      buildFailure(failure.error, "verification_output"),
      loaded,
      resolved.files,
      resolved.dependencies
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

async function loadVerificationWasm(
  input: MovePackageProvenanceInput
): Promise<LoadedVerificationWasm> {
  const referenceBytecode = referenceBytecodeSummary(input.reference);
  if (input.wasm) {
    const mod = (await loadWasm(
      input.wasm
    )) as unknown as VerificationWasmModule;
    return {
      mod,
      referenceBytecode,
      selectedVerifier: {
        verifierId: "custom",
        suiVersion: safeSuiVersion(mod),
        decodedBytecodeVersion: referenceBytecode.decodedVersion,
        bytecodeFlavor: referenceBytecode.flavor,
      },
    };
  }

  const bytecodeVersion = referenceBytecode.decodedVersion;
  if (
    bytecodeVersion === undefined ||
    bytecodeVersion === CURRENT_BYTECODE_VERSION
  ) {
    const mod = (await loadWasm()) as unknown as VerificationWasmModule;
    return {
      mod,
      referenceBytecode,
      selectedVerifier: {
        verifierId: CURRENT_VERIFIER_ID,
        suiVersion: safeSuiVersion(mod),
        decodedBytecodeVersion: bytecodeVersion ?? CURRENT_BYTECODE_VERSION,
        bytecodeFlavor: referenceBytecode.flavor ?? CURRENT_BYTECODE_FLAVOR,
      },
    };
  }

  const route = BUNDLED_BYTECODE_VERIFIER_ROUTES.get(bytecodeVersion);
  if (!route) {
    throw unsupportedBytecodeVersion(bytecodeVersion, referenceBytecode);
  }

  const mod = await loadBundledBytecodeVerifier(bytecodeVersion, route);
  return {
    mod,
    referenceBytecode,
    selectedVerifier: {
      verifierId: route.verifierId,
      suiVersion: safeSuiVersion(mod),
      decodedBytecodeVersion: bytecodeVersion,
      bytecodeFlavor: referenceBytecode.flavor,
    },
  };
}

function unsupportedBytecodeVersion(
  bytecodeVersion: number,
  referenceBytecode: VerificationReferenceBytecode
): MovePackageProvenanceResult {
  const error = `Unsupported decoded bytecode version ${bytecodeVersion}. Supported bundled verifier versions: ${[
    CURRENT_BYTECODE_VERSION,
    ...BUNDLED_BYTECODE_VERIFIER_ROUTES.keys(),
  ]
    .sort((left, right) => left - right)
    .join(", ")}`;
  return {
    status: "bytecode_version_mismatch",
    verdict: "unverified",
    summary: `Decoded bytecode version ${bytecodeVersion} is not supported by this verifier package.`,
    displayMessage: `Verification failed: ${error}`,
    referenceBytecode,
    error,
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

function referenceBytecodeSummary(
  reference: ReferenceArtifact
): VerificationReferenceBytecode {
  const versions = new Set<number>();
  const flavors = new Set<number | null>();
  for (const moduleBase64 of reference.modules) {
    const header = moduleBytecodeHeader(moduleBase64);
    if (!header) {
      return { moduleCount: reference.modules.length };
    }
    versions.add(header.decodedVersion);
    flavors.add(header.flavor);
  }
  return {
    moduleCount: reference.modules.length,
    decodedVersion:
      versions.size === 1
        ? (versions.values().next().value as number)
        : undefined,
    flavor:
      flavors.size === 1
        ? (flavors.values().next().value as number | null)
        : undefined,
  };
}

function moduleBytecodeHeader(
  moduleBase64: string
): { decodedVersion: number; flavor: number | null } | undefined {
  const header = decodeBase64Prefix(moduleBase64, 8);
  if (!header || header.length < 8) {
    return undefined;
  }
  const rawVersionWord =
    (header[4] | (header[5] << 8) | (header[6] << 16) | (header[7] << 24)) >>>
    0;
  return {
    decodedVersion: rawVersionWord & 0x00ff_ffff,
    flavor: rawVersionWord >>> 24 || null,
  };
}

function safeSuiVersion(mod: VerificationWasmModule): string | undefined {
  try {
    return mod.sui_version();
  } catch {
    return undefined;
  }
}

function completeVerificationResult(
  result: MovePackageProvenanceResult,
  loaded: LoadedVerificationWasm,
  filesJson: string,
  dependenciesJson: string
): MovePackageProvenanceResult {
  const completed: MovePackageProvenanceResult = {
    ...result,
    selectedVerifier: result.selectedVerifier ?? loaded.selectedVerifier,
    referenceBytecode: result.referenceBytecode ?? loaded.referenceBytecode,
  };
  completed.sourceCompatibility ??= sourceCompatibilityEvidence(
    filesJson,
    dependenciesJson,
    loaded.selectedVerifier
  );
  completed.displayMessage ??= displayMessageForResult(completed);
  return completed;
}

function displayMessageForResult(result: MovePackageProvenanceResult): string {
  const verifier = result.selectedVerifier?.verifierId
    ? ` using verifier ${result.selectedVerifier.verifierId}`
    : "";
  const version =
    result.referenceBytecode?.decodedVersion !== undefined
      ? ` for decoded bytecode version ${result.referenceBytecode.decodedVersion}`
      : "";
  if (result.status === "verified") {
    return `Verification succeeded${verifier}${version}: ${
      result.verdict ?? "verified"
    }.`;
  }
  const stage = result.failureStage ? ` at ${result.failureStage}` : "";
  const reason =
    result.error ?? result.summary ?? result.verdict ?? result.status;
  return `Verification failed${stage}${verifier}${version}: ${reason}`;
}

function sourceCompatibilityEvidence(
  filesJson: string,
  dependenciesJson: string,
  selectedVerifier: VerificationSelectedVerifier
): VerificationSourceCompatibility | undefined {
  const supportedEditions =
    selectedVerifier.decodedBytecodeVersion === 6
      ? ["legacy", "2024.alpha", "2024.beta"]
      : ["legacy", "2024.alpha", "2024.beta", "2024"];
  const defaultEdition =
    selectedVerifier.decodedBytecodeVersion === 6 ? "legacy" : "2024";
  const unsupportedEditions: VerificationSourceEditionEvidence[] = [];
  const rootFiles = parseJsonObject(filesJson);
  const root = rootFiles
    ? sourceEditionEvidence(
        "root",
        rootFiles,
        undefined,
        supportedEditions,
        defaultEdition
      )
    : undefined;
  if (root && !root.supported) {
    unsupportedEditions.push(root);
  }

  const dependencies: VerificationSourceEditionEvidence[] = [];
  const dependencyGroups = parseJsonArray(dependenciesJson);
  for (const group of dependencyGroups) {
    if (!group || typeof group !== "object") {
      continue;
    }
    const files = parseRecord((group as any).files);
    if (!files) {
      continue;
    }
    const evidence = sourceEditionEvidence(
      "dependency",
      files,
      typeof (group as any).name === "string" ? (group as any).name : undefined,
      supportedEditions,
      defaultEdition
    );
    dependencies.push(evidence);
    if (!evidence.supported) {
      unsupportedEditions.push(evidence);
    }
  }

  return {
    supportedEditions,
    defaultEdition,
    root,
    dependencies,
    unsupportedEditions,
  };
}

function sourceEditionEvidence(
  source: "root" | "dependency",
  files: Record<string, string>,
  packageName: string | undefined,
  supportedEditions: readonly string[],
  defaultEdition: string
): VerificationSourceEditionEvidence {
  const manifestPath = Object.keys(files).find((path) =>
    path.endsWith("Move.toml")
  );
  const manifest = manifestPath ? files[manifestPath] : undefined;
  const declaredEdition = manifest
    ? moveTomlStringField(manifest, "edition")
    : undefined;
  const parsedName = manifest
    ? moveTomlStringField(manifest, "name")
    : undefined;
  const effectiveEdition = declaredEdition ?? defaultEdition;
  return {
    source,
    packageName: packageName ?? parsedName,
    manifestPath,
    declaredEdition,
    effectiveEdition,
    defaulted: declaredEdition === undefined,
    supported: supportedEditions.includes(effectiveEdition),
  };
}

function moveTomlStringField(
  content: string,
  field: string
): string | undefined {
  const match = content.match(
    new RegExp(`^\\s*${field}\\s*=\\s*["']([^"']+)["']`, "m")
  );
  return match?.[1];
}

function parseJsonObject(value: string): Record<string, string> | undefined {
  return parseRecord(parseJson(value));
}

function parseJsonArray(value: string): unknown[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      return undefined;
    }
    output[key] = item;
  }
  return output;
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
