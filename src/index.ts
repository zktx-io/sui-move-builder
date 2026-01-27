import { GitHubFetcher } from "./fetcher.js";
import { resolve as resolveMoveToml } from "./resolver.js";
import { parseToml } from "./tomlParser.js";
import { generateMoveLockV4FromJson } from "./lockfileGenerator.js";

/** Build progress event types for tracking build status */
export type BuildProgressEvent =
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
  | { type: "lockfile_generate" };

/** Callback function for receiving build progress events */
export type OnProgressCallback = (event: BuildProgressEvent) => void;

export interface ResolvedDependencies {
  /** JSON string of resolved files for the root package */
  files: string;
  /** JSON string of resolved dependencies (linkage applied, for compilation) */
  dependencies: string;
  /** JSON string of all dependencies including diamond duplicates (for lockfile) */
  lockfileDependencies: string;
}

export interface BuildInput {
  /** Virtual file system contents. Keys are paths (e.g. "Move.toml", "sources/Module.move"). */
  files: Record<string, string>;
  /** Optional custom URL for the wasm binary. Defaults to bundled wasm next to this module. */
  wasm?: string | URL | BufferSource;
  /** Optional hint for the root package git source (enables resolving local deps from Move.lock). */
  rootGit?: { git: string; rev: string; subdir?: string };
  /** Optional GitHub token to raise API limits when resolving dependencies. */
  githubToken?: string;
  /** Emit ANSI color codes in diagnostics when available. */
  ansiColor?: boolean;
  /** Network environment (mainnet, testnet, devnet). Defaults to mainnet. */
  network?: "mainnet" | "testnet" | "devnet";
  /** Optional pre-resolved dependencies. If provided, dependency resolution will be skipped. */
  resolvedDependencies?: ResolvedDependencies;
  /** Use this option to silence warnings. */
  silenceWarnings?: boolean;
  /** Use this option to enable test mode (includes #[test_only] modules). */
  testMode?: boolean;
  /** Use this option to specify lint level (e.g. "all", "none"). */
  lintFlag?: string;
  /** Use this option to strip metadata from the output (e.g. for mainnet dep matching). */
  stripMetadata?: boolean;
  /** Optional progress callback for build events */
  onProgress?: OnProgressCallback;
}

export interface BuildSuccess {
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
}

export interface BuildFailure {
  error: string;
}

import { migrateLegacyLockToPublishedToml, stripEnvSectionsFromV3Lockfile, convertV3MovePackageToV4Pinned } from "./lockfileMigration.js";

// ORIGINAL SOURCE REFERENCE: sui-types/src/digests.rs:164-165, 262-269
// Chain IDs are first 4 bytes of genesis checkpoint digest as hex
// MAINNET_CHAIN_IDENTIFIER_BASE58 = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
// TESTNET_CHAIN_IDENTIFIER_BASE58 = "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD"
const CHAIN_IDS: Record<string, string> = {
  mainnet: "35834a8a",
  testnet: "4c78adac",
  devnet: "2",
  localnet: "localnet",
};

type WasmModule = typeof import("./sui_move_wasm.js");

let wasmReady: Promise<WasmModule> | undefined;

async function loadWasm(
  customWasm?: string | URL | BufferSource
): Promise<WasmModule> {
  if (!wasmReady) {
    wasmReady = import("./sui_move_wasm.js").then(async (mod) => {
      if (customWasm) {
        await (mod.default as any)(customWasm);
      } else {
        await mod.default();
      }
      return mod;
    });
  }
  return wasmReady;
}

function asFailure(err: unknown): BuildFailure {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Unknown error";
  return { error: msg };
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

function parseCompileResult(
  output: string,
  nameMap?: Map<string, string>,
  moveLock?: string,
  environment?: string
): BuildSuccess | BuildFailure {
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
    };
    if (!parsed.modules || !parsed.dependencies || !parsed.digest) {
      throw new Error("missing fields in compiler output");
    }
    const digestBytes =
      typeof parsed.digest === "string"
        ? hexToBytes(parsed.digest)
        : Array.from(parsed.digest);

    let dependencies = parsed.dependencies;

    // Fix: CLI uses the Dependency Graph to generate the dependency list, NOT the compiler output.
    // The compiler output only includes dependencies actually *used* in bytecode.
    // The CLI includes all *published* dependencies in the graph.
    // We recreate this list from `nameMap` (which contains graph deps with published IDs).
    if (nameMap) {
      dependencies = Array.from(nameMap.keys()).filter(
        (id) =>
          // Filter out 0x0 (Unpublished / Source-only)
          id !==
          "0x0000000000000000000000000000000000000000000000000000000000000000"
      );

      // Sort dependencies alphabetically by package name to match Sui CLI behavior (ASCII case-sensitive)
      dependencies.sort((a, b) => {
        const nameA = nameMap.get(a) || "";
        const nameB = nameMap.get(b) || "";
        return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
      });
    }

    return {
      modules: parsed.modules,
      // Filter out implicit system dependencies to match CLI behavior
      dependencies,
      digest: digestBytes,
      moveLock: moveLock || "",
      environment: environment || "mainnet",
    };
  } catch (error) {
    return asFailure(error);
  }
}

function logDependencyAddresses(depsJson: string): void {
  try {
    const deps = JSON.parse(depsJson) as Array<{
      name: string;
      files: Record<string, string>;
      addressMapping?: Record<string, string>;
    }>;
    for (const dep of deps) {
      // Prefer resolved address mapping
      const addr =
        dep.addressMapping?.[dep.name] ??
        (() => {
          const moveTomlEntry = Object.entries(dep.files).find(([path]) =>
            path.endsWith("Move.toml")
          );
          if (!moveTomlEntry) return undefined;
          const parsed = parseToml(moveTomlEntry[1]);
          return (
            (parsed.addresses && parsed.addresses[dep.name]) ||
            parsed.package?.published_at ||
            parsed.package?.["published-at"]
          );
        })();
      if (addr !== undefined) {
        // Address resolved
      }
    }
  } catch {
    // Logging is best-effort; ignore errors
  }
}

/** Initialize the wasm module (idempotent). Provide a custom wasm URL if hosting separately. */
export async function initMoveCompiler(options?: {
  wasm?: string | URL | BufferSource;
}): Promise<void> {
  await loadWasm(options?.wasm);
}

/**
 * Resolve dependencies for a Move package without compiling.
 * This function can be used to resolve dependencies once and reuse them across multiple builds.
 */
export async function resolveDependencies(
  input: Omit<BuildInput, "resolvedDependencies">
): Promise<ResolvedDependencies> {
  const moveToml = input.files["Move.toml"] || "";
  // CLI does not mutate Move.toml; use as-is.

  const inferredRootGit =
    input.rootGit ||
    ((input.files as any).__rootGit as
      | { git: string; rev: string; subdir?: string }
      | undefined);

  const resolved = await resolveMoveToml(
    moveToml,
    { ...input.files, "Move.toml": moveToml },
    new GitHubFetcher(input.githubToken),
    input.network,
    inferredRootGit
      ? {
        type: "git",
        git: inferredRootGit.git,
        rev: inferredRootGit.rev,
        subdir: inferredRootGit.subdir,
      }
      : undefined
  );

  return {
    files: resolved.files,
    dependencies: resolved.dependencies,
    lockfileDependencies: resolved.lockfileDependencies,
  };
}

/** Compile a Move package in memory using the bundled Move compiler wasm. */
export async function buildMovePackage(
  input: BuildInput
): Promise<BuildSuccess | BuildFailure> {
  const environment = input.network || "mainnet";

  try {
    // Filter input files to only include valid Move package files
    // This mimics the CLI behavior of only processing relevant files from the directory
    // and ignoring things like README.md, .gitignore, etc.
    const filteredFiles: Record<string, string> = {};
    for (const [path, content] of Object.entries(input.files)) {
      if (
        path.endsWith(".move") ||
        path.endsWith("Move.toml") ||
        path.endsWith("Move.lock") ||
        path.endsWith("Published.toml")
      ) {
        filteredFiles[path] = content;
      }
    }
    input.files = filteredFiles;

    // ORIGINAL CLI SOURCE:
    // - external-crates/move/crates/move-package-alt/src/package/root_package.rs:249-267
    //   save_lockfile_to_disk() migrates legacy lockfile pubs to modern pubfile BEFORE overwriting
    // - external-crates/move/crates/move-package-alt/src/compatibility/legacy_lockfile.rs
    //   load_legacy_lockfile() extracts publish info from V3 [env] sections
    //
    // CLI migration flow:
    // 1. Reads legacy Move.lock (V3 format with [env] sections containing publish info)
    // 2. Extracts publish info and writes to Published.toml
    // 3. Updates Move.lock to V4 format (removes publish info, keeps only dependency resolution)
    //
    // This WASM implementation:
    // - Extracts Published.toml content and applies it BEFORE resolve/build
    // - This ensures packages with legacy lockfiles use correct addresses during compilation
    // - Note: Move.lock V4 generation happens separately in lockfileGenerator.ts
    let migratedPublishedToml: string | undefined;
    const legacyLock = input.files["Move.lock"];
    if (legacyLock) {
      const chainId = CHAIN_IDS[environment] || environment;
      const migrationResult = migrateLegacyLockToPublishedToml(
        legacyLock,
        environment,
        chainId
      );
      migratedPublishedToml = migrationResult ?? undefined;
      if (migratedPublishedToml) {
        // Apply migration: update files to use migrated Published.toml and V4 lockfile
        // This ensures resolve/build uses the same state as CLI after migration
        if (!input.files["Published.toml"]) {
          input.files["Published.toml"] = migratedPublishedToml;
        }

        // CRITICAL: Also convert Move.lock to V4 format (strip [env] sections)
        // CLI does this during migration, and the lockfile content affects the build digest
        // Without this, first build produces different digest than CLI
        const strippedLock = stripEnvSectionsFromV3Lockfile(legacyLock);
        if (strippedLock) {
          input.files["Move.lock"] = strippedLock;
        }
      } else {
        // V3 lockfile without [env] sections (unpublished package)
        // CLI compat: V3 lockfile's [[move.package]] array is not used
        // CLI's pins_for_env() returns None → re-resolve from manifest (builder.rs:109-111)
        // Instead of converting V3 to V4, use buildDependencyGraph fallback in resolver.ts
      }
    }

    // Emit resolve_start event
    input.onProgress?.({ type: "resolve_start" });

    // Use pre-resolved dependencies if provided, otherwise resolve them
    const resolved = input.resolvedDependencies
      ? input.resolvedDependencies
      : await resolveDependencies(input);

    // Emit resolve_complete event
    let depCount = 0;
    try {
      const deps = JSON.parse(resolved.dependencies) as Array<{ name: string }>;
      depCount = deps.length;
    } catch {
      // Ignore
    }
    input.onProgress?.({ type: "resolve_complete", count: depCount });

    const mod = await loadWasm(input.wasm);
    // Log dependency addresses passed to compiler (best-effort)
    logDependencyAddresses(resolved.dependencies);

    // Build map of ID -> Name for sorting output AND filtering unpublished deps
    const idToName = new Map<string, string>();
    let rootPackageName = "Package";
    try {
      // Structure matches PackageGroupedFormat in compilationDependencies.ts
      const deps = JSON.parse(resolved.dependencies) as Array<{
        name: string;
        publishedIdForOutput?: string;
        files: Record<string, string>;
        manifest: {
          publishedAt?: string;
          originalId?: string;
          latestPublishedId?: string;
        };
      }>;

      // Extract root package name and direct dependencies from Move.toml
      const moveToml = input.files["Move.toml"];
      let _rootManifestDeps: string[] = [];
      if (moveToml) {
        const parsed = parseToml(moveToml);
        if (parsed.package?.name) {
          rootPackageName = parsed.package.name;
        }
        // Get direct dependencies from [dependencies] section
        if (parsed.dependencies) {
          _rootManifestDeps = Object.keys(
            parsed.dependencies as Record<string, unknown>
          );
        }
      }

      for (const dep of deps) {
        if (!dep.publishedIdForOutput) continue;

        // Strict Published Check Logic (matching CLI)
        // Exclude 0x0 address (Zero Address) from output dependencies
        if (
          dep.publishedIdForOutput ===
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        ) {
          continue;
        }

        // Exclude system package addresses that CLI doesn't include in output
        // These are implicit framework dependencies without explicit published-at in manifest
        //
        // ORIGINAL SOURCE REFERENCE: sui-types/src/lib.rs:127-133 (built_in_pkgs! macro)
        //   MOVE_STDLIB_ADDRESS = 0x1
        //   SUI_FRAMEWORK_ADDRESS = 0x2
        //   SUI_SYSTEM_ADDRESS = 0x3
        //   BRIDGE_ADDRESS = 0xb
        //   DEEPBOOK_ADDRESS = 0xdee9
        //
        // Note: We only filter out SuiSystem (0x3) and Bridge (0xb) because they are
        // implicitly added by the CLI when not explicitly declared in the manifest.
        // Sui (0x2) and Std (0x1) are handled separately as default implicit deps.
        const systemAddresses = [
          "0x0000000000000000000000000000000000000000000000000000000000000003", // SUI_SYSTEM_ADDRESS
          "0x000000000000000000000000000000000000000000000000000000000000000b", // BRIDGE_ADDRESS
        ];
        if (systemAddresses.includes(dep.publishedIdForOutput)) {
          continue;
        }

        idToName.set(dep.publishedIdForOutput, dep.name);
      }
    } catch {
      // Ignore parsing errors, sorting/filtering will degrade
    }

    // Emit compile_start event
    input.onProgress?.({ type: "compile_start" });

    // Convert dependencies to DependencyGraph format for WASM lockfile generation
    // ORIGINAL SOURCE: builder.rs:232-265 (create_ids), to_lockfile.rs
    const depsArray = JSON.parse(resolved.dependencies) as Array<{
      name: string;
      source?: { type: string; git?: string; rev?: string; subdir?: string; local?: string };
      deps?: Record<string, string>;
      manifestDigest?: string;
      depAliasToPackageName?: Record<string, string>;
    }>;

    // Build PackagePin array with unique IDs (suffix for same-name packages)
    const nameToSuffix = new Map<string, number>();
    const packages = depsArray.map((dep) => {
      const suffix = nameToSuffix.get(dep.name) ?? 0;
      const id = suffix === 0 ? dep.name : `${dep.name}_${suffix}`;
      nameToSuffix.set(dep.name, suffix + 1);
      return {
        id,
        name: dep.name,
        source: dep.source ?? { root: true },
        deps: dep.deps ?? {},
        manifestDigest: dep.manifestDigest ?? "",
        is_root: false,
      };
    });

    // Add root package
    packages.unshift({
      id: rootPackageName,
      name: rootPackageName,
      source: { root: true },
      deps: {},  // TODO: add root deps
      manifestDigest: "",  // TODO: compute
      is_root: true,
    });

    // Sort by ID for consistent output
    packages.sort((a, b) => a.id.localeCompare(b.id));

    const dependencyGraph = {
      environment,
      root: rootPackageName,
      packages,
    };

    const raw = (mod as any).compile(
      resolved.files,
      resolved.dependencies,  // Pass original array for compilation
      JSON.stringify({
        silenceWarnings: input.silenceWarnings,
        testMode: input.testMode,
        lintFlag: input.lintFlag,
        stripMetadata: input.stripMetadata,
      }),
      JSON.stringify(dependencyGraph)  // 4th param: graph for lockfile generation
    );

    const result = ensureCompileResult(raw);
    const ok = result.success();
    const output = result.output();

    // Emit compile_complete event
    input.onProgress?.({ type: "compile_complete" });

    if (!ok) {
      return asFailure(output);
    }

    // Emit lockfile_generate event
    input.onProgress?.({ type: "lockfile_generate" });

    // Get rootManifestDeps from Move.toml if not already extracted
    let rootManifestDeps: string[] = [];
    let rootManifestDepsInfo: Record<string, any> | undefined;
    let rootDepAliasToPackageName: Record<string, string> | undefined;

    try {
      const moveToml = input.files["Move.toml"];
      if (moveToml) {
        const parsed = parseToml(moveToml);
        if (parsed.dependencies) {
          rootManifestDeps = Object.keys(
            parsed.dependencies as Record<string, unknown>
          );
          rootManifestDepsInfo = parsed.dependencies as Record<string, any>;
        }
      }
    } catch {
      // Ignore
    }

    // Extract rootDepAliasToPackageName from resolved dependencies
    // First entry in dependencies array is root package (or find by name match)
    try {
      const depsArray = JSON.parse(resolved.dependencies) as Array<{
        name: string;
        depAliasToPackageName?: Record<string, string>;
      }>;

      // Find root package entry
      const rootEntry = depsArray.find((d) => d.name === rootPackageName);
      if (rootEntry?.depAliasToPackageName) {
        rootDepAliasToPackageName = rootEntry.depAliasToPackageName;
      }
    } catch {
      // Ignore parsing errors
    }

    // Generate Move.lock V4
    // ORIGINAL: root_package.rs:272-282 - Pass existing lockfile to preserve other environments
    // Use lockfileDependencies which includes ALL packages (no linkage filtering)
    const existingLockfile = input.files["Move.lock"];
    const moveLock = generateMoveLockV4FromJson(
      resolved.lockfileDependencies,
      rootPackageName,
      environment,
      rootManifestDeps,
      mod.compute_manifest_digest,
      rootManifestDepsInfo,
      rootDepAliasToPackageName,
      existingLockfile // Preserve other environments from existing lockfile
    );

    const buildResult = parseCompileResult(
      output,
      idToName,
      moveLock,
      environment
    );

    if (!("error" in buildResult)) {
      // Attempt migration if Legacy Lockfile exists
      const legacyLock = input.files["Move.lock"];
      if (legacyLock) {
        const chainId = CHAIN_IDS[environment] || environment;
        const migratedPublishedToml = migrateLegacyLockToPublishedToml(
          legacyLock,
          environment,
          chainId
        );
        if (migratedPublishedToml) {
          buildResult.publishedToml = migratedPublishedToml;
        }
      }
    }

    return buildResult;
  } catch (error) {
    return asFailure(error);
  }
}

export interface TestSuccess {
  /** Whether all tests passed. */
  passed: boolean;
  /** Output from the test runner (stdout). */
  output: string;
}

/** Compile and run tests for a Move package in memory. */
export async function testMovePackage(
  input: BuildInput
): Promise<TestSuccess | BuildFailure> {
  try {
    // Use pre-resolved dependencies if provided, otherwise resolve them
    const resolved = input.resolvedDependencies
      ? input.resolvedDependencies
      : await resolveDependencies(input);

    const mod = await loadWasm(input.wasm);
    // Log dependency addresses passed to compiler (best-effort)
    logDependencyAddresses(resolved.dependencies);

    const raw =
      input.ansiColor && typeof (mod as any).test_with_color === "function"
        ? (mod as any).test_with_color(
          resolved.files,
          resolved.dependencies,
          true
        )
        : (mod as any).test(resolved.files, resolved.dependencies); // Fallback if test_with_color missing

    // Check if raw result matches expected shape
    if (typeof raw.passed === "boolean" && typeof raw.output === "string") {
      return {
        passed: raw.passed,
        output: raw.output,
      };
    }

    // In case wasm-bindgen getters are needed (wrapper objects)
    const passed = typeof raw.passed === "function" ? raw.passed() : raw.passed;
    const output = typeof raw.output === "function" ? raw.output() : raw.output;

    return { passed, output };
  } catch (error) {
    return asFailure(error);
  }
}

/** Sui Move version baked into the wasm (e.g. from Cargo.lock). */
export async function getSuiMoveVersion(options?: {
  wasm?: string | URL;
}): Promise<string> {
  const mod = await loadWasm(options?.wasm);
  return mod.sui_move_version();
}

/** Sui repo version baked into the wasm (e.g. from Cargo.lock). */
export async function getSuiVersion(options?: {
  wasm?: string | URL;
}): Promise<string> {
  const mod = await loadWasm(options?.wasm);
  return mod.sui_version();
}

/** Get the raw wasm bindings (low-level interface). */
export async function getWasmBindings(options?: {
  wasm?: string | URL;
}): Promise<WasmModule> {
  return loadWasm(options?.wasm);
}

/** Low-level helper to call wasm compile directly with JSON strings. */
export async function compileRaw(
  filesJson: string,
  depsJson: string,
  options?: { wasm?: string | URL; ansiColor?: boolean }
) {
  const mod = await loadWasm(options?.wasm);
  const raw =
    options?.ansiColor && typeof (mod as any).compile_with_color === "function"
      ? (mod as any).compile_with_color(filesJson, depsJson, true)
      : mod.compile(
        filesJson,
        depsJson,
        JSON.stringify({ silenceWarnings: false })
      );
  const result = ensureCompileResult(raw);
  return {
    success: result.success(),
    output: result.output(),
  };
}

export type BuildResult = BuildSuccess | BuildFailure;

// Package fetching utility
export { fetchPackageFromGitHub } from "./packageFetcher.js";
