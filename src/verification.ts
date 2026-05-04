import {
  asFailure,
  compilerModes,
  loadWasm,
  type MovePackageInput,
  type MovePackageResolvedDependencies,
  type WasmModule,
} from "./core.js";
import { GitHubMovePackageFetcher } from "./fetcher.js";
import {
  resolve as resolveMoveToml,
  type DependencySource,
  type LockfileV4Helpers,
} from "./resolver.js";
import type { MovePackageStageReport } from "./stageReports.js";
import { StructuredBuildError } from "./structuredError.js";

export type VerificationStatus =
  | "verified"
  | "toolchain_mismatch"
  | "mismatch"
  | "build_failure"
  | "invalid_reference";

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
  currentBuild?: VerificationCurrentBuild;
  referenceSummary?: VerificationArtifactSummary;
  currentSummary?: VerificationArtifactSummary;
  toolchainEvidence?: VerificationToolchainEvidence;
  differences?: string[];
  bytecodeDiffs?: VerificationBytecodeDiff[];
  error?: string;
}

export interface MovePackageProvenanceInput extends MovePackageInput {
  reference: ReferenceArtifact;
}

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

export async function verifyMovePackageProvenance(
  input: MovePackageProvenanceInput
): Promise<MovePackageProvenanceResult> {
  let mod: VerificationWasmModule;
  try {
    mod = (await loadWasm(input.wasm)) as unknown as VerificationWasmModule;
  } catch (error) {
    const failure = asFailure(error, "wasm_init");
    return buildFailure(failure.error);
  }

  let resolved;
  try {
    resolved =
      input.resolvedDependencies ??
      (await resolveVerificationDependencies(input, mod));
  } catch (error) {
    const failure = asFailure(error, "dependency_resolution");
    return buildFailure(failure.error);
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
          compileIntent: "dump",
          withUnpublishedDependencies: input.withUnpublishedDependencies,
          modes: compilerModes(input),
        },
        reference: input.reference,
      })
    );
  } catch (error) {
    const failure = asFailure(error, "compile");
    return buildFailure(failure.error);
  }

  try {
    return JSON.parse(raw) as MovePackageProvenanceResult;
  } catch (error) {
    const failure = asFailure(error, "compiler_output");
    return buildFailure(failure.error);
  }
}

function buildFailure(error: string): MovePackageProvenanceResult {
  return {
    status: "build_failure",
    error,
  };
}

type LegacyPublicationMigrationResponse =
  | {
      status: "ok";
      publishedToml?: string;
      moveLock?: string;
    }
  | { status: "error"; error?: string; code?: string };

function parseLegacyPublicationMigrationResponse(
  raw: string
): LegacyPublicationMigrationResponse {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { status?: unknown }).status !== "string"
  ) {
    throw new Error(
      "Rust verification resolver returned an invalid legacy publication migration response"
    );
  }
  return parsed as LegacyPublicationMigrationResponse;
}

function applyVerificationLegacyPublicationMigration(
  files: Record<string, string>,
  mod: VerificationWasmModule
): void {
  if (!files["Move.lock"]) {
    return;
  }

  const response = parseLegacyPublicationMigrationResponse(
    mod.verification_resolve_package_groups(
      JSON.stringify({
        operation: "legacyPublicationMigration",
        input: { files },
      })
    )
  );
  if (response.status !== "ok") {
    throw new StructuredBuildError(
      response.error || "Legacy publication migration failed",
      response.code
    );
  }
  if (response.publishedToml) {
    files["Published.toml"] = response.publishedToml;
  }
  if (response.moveLock) {
    files["Move.lock"] = response.moveLock;
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

function emitVerificationStageReports(
  onProgress: MovePackageInput["onProgress"],
  reports: MovePackageStageReport[] | undefined
): void {
  if (!onProgress || !reports) {
    return;
  }
  for (const report of reports) {
    onProgress({ type: "stage_trace", ...report });
  }
}

async function resolveVerificationDependencies(
  input: Omit<MovePackageProvenanceInput, "resolvedDependencies">,
  mod: VerificationWasmModule
): Promise<MovePackageResolvedDependencies> {
  const moveToml = input.files["Move.toml"] || "";
  const inferredRootGit =
    input.rootGit ||
    ((input.files as any).__rootGit as
      | { git: string; rev: string; subdir?: string }
      | undefined);
  const rootSource: DependencySource | undefined = inferredRootGit
    ? {
        type: "git",
        git: inferredRootGit.git,
        rev: inferredRootGit.rev,
        subdir: inferredRootGit.subdir,
      }
    : undefined;

  const files = { ...input.files, "Move.toml": moveToml };
  applyVerificationLegacyPublicationMigration(files, mod);

  const resolved = await resolveMoveToml(
    moveToml,
    files,
    input.fetcher ?? new GitHubMovePackageFetcher(input.githubToken),
    input.network,
    rootSource,
    verificationResolverHelpers(mod),
    compilerModes(input)
  );
  emitVerificationStageReports(input.onProgress, resolved.stageReports);

  return {
    files: resolved.files,
    dependencies: resolved.dependencies,
    lockfileDependencies: resolved.lockfileDependencies,
  };
}
