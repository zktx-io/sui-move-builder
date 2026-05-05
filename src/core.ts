import type { MovePackageFetcher } from "./fetcher.js";
import { generateMoveLockV4FromJson } from "./lockfileGenerator.js";
import { structuredErrorCode } from "./structuredError.js";
import type { MovePackageStageReport } from "./stageReports.js";
import {
  applyLegacyPublicationMigrationToFiles,
  compilerModes,
  emitMovePackageStageReports,
  resolveSnapshotDependencies,
  stripMovePackageStageReports,
  type MovePackageResolvedDependenciesInternal,
} from "./dependencyResolution.js";

export {
  compilerModes,
  emitMovePackageStageReports,
} from "./dependencyResolution.js";

/** Build progress event types for tracking build status */
export type MovePackageProgressEvent =
  | { type: "resolve_start" }
  | {
      type: "resolve_dep";
      name: string;
      source: string;
      current: number;
      total: number;
    }
  | { type: "resolve_complete"; count: number }
  | { type: "compile_start" }
  | { type: "compile_complete" }
  | { type: "lockfile_generate" }
  | ({ type: "stage_trace" } & MovePackageStageReport);

/** Callback function for receiving build progress events */
export type MovePackageProgressCallback = (
  event: MovePackageProgressEvent
) => void;

export type { MovePackageStageReport } from "./stageReports.js";

export interface MovePackageResolvedDependencies {
  /** JSON string of resolved files for the root package */
  files: string;
  /** JSON string of resolved dependencies (linkage applied, for compilation) */
  dependencies: string;
  /** JSON string of all dependencies including diamond duplicates (for lockfile) */
  lockfileDependencies: string;
}

export type MovePackageIntent = "dump" | "publish" | "upgrade";

export interface MovePackageGitSource {
  git: string;
  rev: string;
  subdir?: string;
}

export interface MovePackageInput {
  /** Virtual file system contents. Keys are paths (e.g. "Move.toml", "sources/Module.move"). */
  files: Record<string, string>;
  /** Optional custom URL for the wasm binary. Defaults to bundled wasm next to this module. */
  wasm?: string | URL | BufferSource;
  /** Optional root package git source for resolving relative local deps from Move.lock. */
  rootGit?: MovePackageGitSource;
  /** Optional GitHub token to raise API limits when resolving dependencies. */
  githubToken?: string;
  /** Optional dependency fetcher. Defaults to GitHubMovePackageFetcher. */
  fetcher?: MovePackageFetcher;
  /** Emit ANSI color codes in diagnostics when available. */
  ansiColor?: boolean;
  /** Network environment (mainnet, testnet, devnet). Defaults to mainnet. */
  network?: "mainnet" | "testnet" | "devnet";
  /** Optional pre-resolved dependencies. If provided, dependency resolution will be skipped. */
  resolvedDependencies?: MovePackageResolvedDependencies;
  /** Use this option to silence warnings. */
  silenceWarnings?: boolean;
  /** Compile with unpublished dependencies using the CLI BuildConfig behavior. */
  withUnpublishedDependencies?: boolean;
  /** Arbitrary Move compiler modes, equivalent to CLI --mode values. */
  modes?: string[];
  /** Move compiler lint level. Accepted values: "none", "default", "all". */
  lintFlag?: "none" | "default" | "all";
  /** Reserved for metadata stripping; not applied by the current WASM compiler path. */
  stripMetadata?: boolean;
  /** Optional progress callback for build events */
  onProgress?: MovePackageProgressCallback;
}

export interface MovePackageUpgradeInput extends MovePackageInput {
  /** Published package ID to upgrade. Defaults to the selected environment publication metadata. */
  packageId?: string;
}

export interface MovePackageSuccess {
  /** Base64-encoded bytecode modules. */
  modules: string[];
  /** Hex-encoded dependency IDs. */
  dependencies: string[];
  /** Blake2b-256 package digest as byte array (matches Sui CLI JSON). */
  digest: number[];
  /** Move.lock V4 content (TOML string) */
  moveLock: string;
  /** Build environment used */
  environment: string;
  /** Generated Published.toml content (if migration occurred) */
  publishedToml?: string;
  /** Compiler warnings (if any) */
  warnings?: string;
}

export interface MovePackageDumpSuccess extends MovePackageSuccess {
  intent: "dump";
}

export interface MovePackagePublishSuccess extends MovePackageSuccess {
  intent: "publish";
}

export interface MovePackageUpgradeSuccess extends MovePackageSuccess {
  intent: "upgrade";
  packageId: string;
}

export type MovePackageFailureCategory =
  | "dependency_resolution"
  | "compile"
  | "compiler_output"
  | "input_validation"
  | "lockfile_generation"
  | "test_runner"
  | "wasm_init"
  | "unknown";

export interface MovePackageFailure {
  error: string;
  /** Broad failing stage. Intended for reporting; the error string remains the detailed diagnostic. */
  category?: MovePackageFailureCategory;
  /** Optional structured failure code produced by Rust/WASM helpers. */
  code?: string;
}

function isMoveManifestPath(path: string): boolean {
  const fileName = path.split(/[\\/]/).pop() || path;
  return fileName === "Move.toml" || /^Move\.[^.\\/]+\.toml$/.test(fileName);
}

function normalizeSuiAddress(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const clean = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length > 64) {
    return undefined;
  }
  return `0x${clean.padStart(64, "0").toLowerCase()}`;
}

function isNonZeroAddress(value: string | undefined): boolean {
  const normalized = normalizeSuiAddress(value);
  return Boolean(normalized && !/^0x0+$/.test(normalized));
}

interface RootPublicationMetadata {
  packageName: string;
  publishedAt?: string;
  originalId?: string;
}

export type WasmModule = typeof import("./sui_move_wasm.js");

let wasmReady: Promise<WasmModule> | undefined;

function isNodeLikeEnvironment(): boolean {
  return Boolean((globalThis as any).process?.versions?.node);
}

async function importNodeModule<T>(specifier: string): Promise<T> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)"
  ) as (specifier: string) => Promise<T>;
  return dynamicImport(specifier);
}

function asFileUrl(input: unknown): URL | undefined {
  try {
    if (input instanceof URL) {
      return input.protocol === "file:" ? input : undefined;
    }
    if (typeof input === "string") {
      const url = new URL(input);
      return url.protocol === "file:" ? url : undefined;
    }
    if (typeof Request !== "undefined" && input instanceof Request) {
      const url = new URL(input.url);
      return url.protocol === "file:" ? url : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function fetchNodeFileUrl(fileUrl: URL): Promise<Response> {
  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    importNodeModule<{ readFile(path: string): Promise<Uint8Array> }>(
      "node:fs/promises"
    ),
    importNodeModule<{ fileURLToPath(url: string | URL): string }>("node:url"),
  ]);
  const bytes = await readFile(fileURLToPath(fileUrl));
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return new Response(body, {
    headers: { "Content-Type": "application/wasm" },
  });
}

async function withNodeFileFetch<T>(operation: () => Promise<T>): Promise<T> {
  if (!isNodeLikeEnvironment()) {
    return operation();
  }

  const previousFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (input: unknown, init?: unknown) => {
    const fileUrl = asFileUrl(input);
    if (fileUrl) {
      return fetchNodeFileUrl(fileUrl);
    }
    if (typeof previousFetch !== "function") {
      throw new TypeError("fetch is not available");
    }
    return previousFetch.call(globalThis, input, init);
  };

  try {
    return await operation();
  } finally {
    if (previousFetch === undefined) {
      delete (globalThis as any).fetch;
    } else {
      (globalThis as any).fetch = previousFetch;
    }
  }
}

export async function loadWasm(
  customWasm?: string | URL | BufferSource
): Promise<WasmModule> {
  if (!wasmReady) {
    wasmReady = import("./sui_move_wasm.js").then(async (mod) => {
      await withNodeFileFetch(async () => {
        if (customWasm) {
          await (mod.default as any)({ module_or_path: customWasm });
        } else {
          await mod.default({});
        }
      });
      return mod;
    });
  }
  return wasmReady;
}

export function asFailure(
  err: unknown,
  category: MovePackageFailureCategory = "unknown"
): MovePackageFailure {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Unknown error";
  const code = structuredErrorCode(err);
  return code ? { error: msg, category, code } : { error: msg, category };
}

function ensureCompileResult(result: unknown): {
  success: () => boolean;
  output: () => string;
} {
  if (typeof result !== "object" || result === null) {
    throw new Error("Unexpected compile result shape from wasm");
  }

  const asAny = result as any;

  // wasm-bindgen structs expose methods
  if (
    typeof asAny.success === "function" &&
    typeof asAny.output === "function"
  ) {
    return asAny as { success: () => boolean; output: () => string };
  }

  // Some builds may expose plain fields; wrap them into functions.
  if (typeof asAny.success === "boolean" && typeof asAny.output === "string") {
    return {
      success: () => asAny.success as boolean,
      output: () => asAny.output as string,
    };
  }

  throw new Error("Unexpected compile result shape from wasm");
}

function applyLegacyPublicationMigration(
  files: Record<string, string>,
  mod: WasmModule
): string | undefined {
  return applyLegacyPublicationMigrationToFiles(
    files,
    (migrationFiles) =>
      mod.legacy_publication_migration(
        JSON.stringify({ files: migrationFiles })
      ),
    "Rust legacy_publication_migration"
  );
}

function parseCompileResult(
  output: string,
  moveLock?: string,
  environment?: string
): MovePackageSuccess | MovePackageFailure {
  const hexToBytes = (hex: string): number[] => {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const padded = clean.length % 2 === 0 ? clean : `0${clean}`;
    const bytes: number[] = [];
    for (let i = 0; i < padded.length; i += 2) {
      const byte = parseInt(padded.slice(i, i + 2), 16);
      if (Number.isNaN(byte)) {
        throw new Error("invalid hex digest");
      }
      bytes.push(byte);
    }
    return bytes;
  };
  try {
    const parsed = JSON.parse(output) as {
      modules?: string[];
      dependencies?: string[];
      digest?: number[] | string;
      warnings?: string;
    };
    if (!parsed.modules || !parsed.dependencies || !parsed.digest) {
      throw new Error("missing fields in compiler output");
    }
    const digestBytes =
      typeof parsed.digest === "string"
        ? hexToBytes(parsed.digest)
        : Array.from(parsed.digest);

    return {
      modules: parsed.modules,
      dependencies: parsed.dependencies,
      digest: digestBytes,
      moveLock: moveLock || "",
      environment: environment || "mainnet",
      warnings: parsed.warnings,
    };
  } catch (error) {
    return asFailure(error, "compiler_output");
  }
}

function parseRootPublicationMetadata(output: string): RootPublicationMetadata {
  const parsed = JSON.parse(output) as {
    status?: string;
    error?: string;
    packageName?: string;
    publishedAt?: string | null;
    originalId?: string | null;
  };
  if (parsed.status !== "ok" || !parsed.packageName) {
    throw new Error(parsed.error || "Unable to read root publication metadata");
  }
  return {
    packageName: parsed.packageName,
    publishedAt: parsed.publishedAt || undefined,
    originalId: parsed.originalId || undefined,
  };
}

function rootPublicationMetadata(
  mod: WasmModule,
  files: Record<string, string>,
  environment: string
): RootPublicationMetadata {
  return parseRootPublicationMetadata(
    mod.root_publication_metadata(
      JSON.stringify({
        files,
        environment,
      })
    )
  );
}

function validatePackageIntent(
  intent: MovePackageIntent,
  input: MovePackageInput | MovePackageUpgradeInput,
  mod: WasmModule,
  files: Record<string, string>,
  environment: string
): { packageId?: string } | MovePackageFailure {
  if (intent === "dump") {
    return {};
  }

  let metadata: RootPublicationMetadata;
  try {
    metadata = rootPublicationMetadata(mod, files, environment);
  } catch (error) {
    return asFailure(error, "input_validation");
  }

  const publishedAt = normalizeSuiAddress(metadata.publishedAt);
  const originalId = normalizeSuiAddress(metadata.originalId);

  if (intent === "publish") {
    if (isNonZeroAddress(publishedAt) || isNonZeroAddress(originalId)) {
      return {
        error: `Package '${metadata.packageName}' is already published for ${environment}`,
        category: "input_validation",
      };
    }
    return {};
  }

  const inputPackageId = normalizeSuiAddress(
    (input as MovePackageUpgradeInput).packageId
  );
  const packageId = inputPackageId || publishedAt;
  if (!packageId || !isNonZeroAddress(packageId)) {
    return {
      error: `Package '${metadata.packageName}' has no published package id for ${environment}`,
      category: "input_validation",
    };
  }
  if (inputPackageId && publishedAt && inputPackageId !== publishedAt) {
    return {
      error: `Input packageId ${inputPackageId} does not match published package id ${publishedAt}`,
      category: "input_validation",
    };
  }

  return { packageId };
}

/** Initialize the wasm module (idempotent). Provide a custom wasm URL if hosting separately. */
export async function initMovePackageBuilder(options?: {
  wasm?: string | URL | BufferSource;
}): Promise<void> {
  await loadWasm(options?.wasm);
}

/**
 * Resolve dependencies for a Move package without compiling.
 * Resolves dependencies once for reuse across multiple builds.
 */
export async function resolveMovePackageDependencies(
  input: Omit<MovePackageInput, "resolvedDependencies">
): Promise<MovePackageResolvedDependencies> {
  const resolved = await resolveMovePackageDependenciesInternal(input);
  emitMovePackageStageReports(input.onProgress, resolved.stageReports);
  return stripMovePackageStageReports(resolved);
}

export async function resolveMovePackageDependenciesForTest(
  input: Omit<MovePackageInput, "resolvedDependencies">
): Promise<MovePackageResolvedDependenciesInternal> {
  return resolveMovePackageDependenciesInternal({
    ...input,
    includeTestMode: true,
  });
}

async function resolveMovePackageDependenciesInternal(
  input: Omit<MovePackageInput, "resolvedDependencies"> & {
    includeTestMode?: boolean;
    skipLegacyPublicationMigration?: boolean;
  }
): Promise<MovePackageResolvedDependenciesInternal> {
  const mod = await loadWasm(input.wasm);
  return resolveSnapshotDependencies(
    input,
    {
      fetchPlan: mod.lockfile_v4_fetch_plan,
      resolvePackageGroups: mod.lockfile_v4_resolve_package_groups,
      manifestGraphResolvePackageGroups:
        mod.manifest_graph_resolve_package_groups,
    },
    (files) => {
      applyLegacyPublicationMigration(files, mod);
    }
  );
}

async function compileMovePackage(
  input: MovePackageInput | MovePackageUpgradeInput,
  intent: MovePackageIntent
): Promise<
  | MovePackageDumpSuccess
  | MovePackagePublishSuccess
  | MovePackageUpgradeSuccess
  | MovePackageFailure
> {
  const environment = input.network || "mainnet";

  try {
    // Filter input files to only include valid Move package files
    // This mimics the CLI behavior of only processing relevant files from the directory
    // and ignoring things like README.md, .gitignore, etc.
    const filteredFiles: Record<string, string> = {};
    for (const [path, content] of Object.entries(input.files)) {
      if (
        path.endsWith(".move") ||
        isMoveManifestPath(path) ||
        path.endsWith("Move.lock") ||
        path.endsWith("Published.toml")
      ) {
        filteredFiles[path] = content;
      }
    }
    input.files = filteredFiles;

    let mod: WasmModule;
    try {
      mod = await loadWasm(input.wasm);
    } catch (error) {
      return asFailure(error, "wasm_init");
    }

    let migratedPublishedToml: string | undefined;
    try {
      migratedPublishedToml = applyLegacyPublicationMigration(input.files, mod);
    } catch (error) {
      return asFailure(error, "lockfile_generation");
    }

    const intentValidation = validatePackageIntent(
      intent,
      input,
      mod,
      input.files,
      environment
    );
    if ("error" in intentValidation) {
      return intentValidation;
    }

    // Emit resolve_start event
    input.onProgress?.({ type: "resolve_start" });

    // Use pre-resolved dependencies if provided, otherwise resolve them
    let resolved: MovePackageResolvedDependenciesInternal;
    try {
      resolved = input.resolvedDependencies
        ? input.resolvedDependencies
        : await resolveMovePackageDependenciesInternal({
            ...input,
            skipLegacyPublicationMigration: true,
          });
    } catch (error) {
      return asFailure(error, "dependency_resolution");
    }
    emitMovePackageStageReports(input.onProgress, resolved.stageReports);

    // Emit resolve_complete event
    let depCount = 0;
    try {
      const deps = JSON.parse(resolved.dependencies) as Array<{ name: string }>;
      depCount = deps.length;
    } catch {
      // Ignore
    }
    input.onProgress?.({ type: "resolve_complete", count: depCount });

    // Emit compile_start event
    input.onProgress?.({ type: "compile_start" });

    let result: { success: () => boolean; output: () => string };
    try {
      const raw = (mod as any).compile(
        resolved.files,
        resolved.dependencies, // Pass original array for compilation
        JSON.stringify({
          silenceWarnings: input.silenceWarnings,
          lintFlag: input.lintFlag,
          stripMetadata: input.stripMetadata,
          ansiColor: input.ansiColor,
          compileIntent: intent,
          withUnpublishedDependencies: input.withUnpublishedDependencies,
          modes: compilerModes(input),
        })
      );
      result = ensureCompileResult(raw);
    } catch (error) {
      return asFailure(error, "compile");
    }
    const ok = result.success();
    const output = result.output();

    // Emit compile_complete event
    input.onProgress?.({ type: "compile_complete" });

    if (!ok) {
      return asFailure(output, "compile");
    }

    // Emit lockfile_generate event
    input.onProgress?.({ type: "lockfile_generate" });

    // Generate Move.lock V4
    // ORIGINAL: root_package.rs:272-282 - Pass existing lockfile to preserve other environments
    // Use lockfileDependencies which includes ALL packages (no linkage filtering)
    let moveLock: string;
    try {
      const existingLockfile = input.files["Move.lock"];
      moveLock = generateMoveLockV4FromJson(
        resolved.lockfileDependencies,
        environment,
        existingLockfile, // Preserve other environments from existing lockfile
        mod.lockfile_v4_generate,
        input.files
      );
    } catch (error) {
      return asFailure(error, "lockfile_generation");
    }

    const buildResult = parseCompileResult(output, moveLock, environment);

    if (!("error" in buildResult)) {
      (
        buildResult as MovePackageSuccess & { intent: MovePackageIntent }
      ).intent = intent;
      if (intent === "upgrade") {
        (buildResult as MovePackageUpgradeSuccess).packageId =
          intentValidation.packageId as string;
      }

      if (migratedPublishedToml) {
        buildResult.publishedToml = migratedPublishedToml;
      }
    }

    return buildResult as
      | MovePackageDumpSuccess
      | MovePackagePublishSuccess
      | MovePackageUpgradeSuccess
      | MovePackageFailure;
  } catch (error) {
    return asFailure(error);
  }
}

/**
 * Prepare CLI dump-style bytecode output for a Move package.
 * Browser WASM builds use declared host/crypto/network compatibility boundaries; see SECURITY.md.
 */
export async function dumpMovePackage(
  input: MovePackageInput
): Promise<MovePackageDumpSuccess | MovePackageFailure> {
  return compileMovePackage(input, "dump") as Promise<
    MovePackageDumpSuccess | MovePackageFailure
  >;
}

/** Prepare modules, dependencies, and digest for a publish transaction payload. */
export async function prepareMovePackagePublish(
  input: MovePackageInput
): Promise<MovePackagePublishSuccess | MovePackageFailure> {
  return compileMovePackage(input, "publish") as Promise<
    MovePackagePublishSuccess | MovePackageFailure
  >;
}

/** Prepare modules, dependencies, digest, and package ID for an upgrade transaction payload. */
export async function prepareMovePackageUpgrade(
  input: MovePackageUpgradeInput
): Promise<MovePackageUpgradeSuccess | MovePackageFailure> {
  return compileMovePackage(input, "upgrade") as Promise<
    MovePackageUpgradeSuccess | MovePackageFailure
  >;
}

/** Sui Move version baked into the wasm (e.g. from Cargo.lock). */
export async function getPinnedSuiMoveVersion(options?: {
  wasm?: string | URL | BufferSource;
}): Promise<string> {
  const mod = await loadWasm(options?.wasm);
  return mod.sui_move_version();
}

/** Sui repo version baked into the wasm (e.g. from Cargo.lock). */
export async function getPinnedSuiVersion(options?: {
  wasm?: string | URL | BufferSource;
}): Promise<string> {
  const mod = await loadWasm(options?.wasm);
  return mod.sui_version();
}

export type MovePackageResult =
  | MovePackageDumpSuccess
  | MovePackagePublishSuccess
  | MovePackageUpgradeSuccess
  | MovePackageFailure;
