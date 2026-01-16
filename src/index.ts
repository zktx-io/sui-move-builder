import { GitHubFetcher } from "./fetcher.js";
import { resolve as resolveMoveToml } from "./resolver.js";
import { parseToml } from "./tomlParser.js";

export interface ResolvedDependencies {
  /** JSON string of resolved files for the root package */
  files: string;
  /** JSON string of resolved dependencies */
  dependencies: string;
}

export interface BuildInput {
  /** Virtual file system contents. Keys are paths (e.g. "Move.toml", "sources/Module.move"). */
  files: Record<string, string>;
  /** Optional custom URL for the wasm binary. Defaults to bundled wasm next to this module. */
  wasm?: string | URL;
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
}

export interface BuildSuccess {
  /** Base64-encoded bytecode modules. */
  modules: string[];
  /** Hex-encoded dependency IDs. */
  dependencies: string[];
  /** Blake2b-256 package digest as byte array (matches Sui CLI JSON). */
  digest: number[];
}

export interface BuildFailure {
  error: string;
}

type WasmModule = typeof import("./sui_move_wasm.js");

let wasmReady: Promise<WasmModule> | undefined;

async function loadWasm(customWasm?: string | URL): Promise<WasmModule> {
  if (!wasmReady) {
    wasmReady = import("./sui_move_wasm.js").then(async (mod) => {
      if (customWasm) {
        await (mod.default as any)({ module_or_path: customWasm });
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

function parseCompileResult(output: string): BuildSuccess | BuildFailure {
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
    return {
      modules: parsed.modules,
      dependencies: parsed.dependencies,
      digest: digestBytes,
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
      }
    }
  } catch {
    // Logging is best-effort; ignore errors
  }
}

/** Initialize the wasm module (idempotent). Provide a custom wasm URL if hosting separately. */
export async function initMoveCompiler(options?: {
  wasm?: string | URL;
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
  let moveToml = input.files["Move.toml"] || "";
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
  };
}

/** Compile a Move package in memory using the bundled Move compiler wasm. */
export async function buildMovePackage(
  input: BuildInput
): Promise<BuildSuccess | BuildFailure> {
  try {
    // Use pre-resolved dependencies if provided, otherwise resolve them
    const resolved = input.resolvedDependencies
      ? input.resolvedDependencies
      : await resolveDependencies(input);

    const mod = await loadWasm(input.wasm);
    // Log dependency addresses passed to compiler (best-effort)
    logDependencyAddresses(resolved.dependencies);

    const raw =
      input.ansiColor && typeof (mod as any).compile_with_color === "function"
        ? (mod as any).compile_with_color(
          resolved.files,
          resolved.dependencies,
          true
        )
        : mod.compile(resolved.files, resolved.dependencies);
    const result = ensureCompileResult(raw);
    const ok = result.success();
    const output = result.output();

    if (!ok) {
      return asFailure(output);
    }
    return parseCompileResult(output);
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
    const passed = typeof raw.passed === 'function' ? raw.passed() : raw.passed;
    const output = typeof raw.output === 'function' ? raw.output() : raw.output;

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
      : mod.compile(filesJson, depsJson);
  const result = ensureCompileResult(raw);
  return {
    success: result.success(),
    output: result.output(),
  };
}

export type BuildResult = BuildSuccess | BuildFailure;

// Package fetching utility
export { fetchPackageFromGitHub } from "./packageFetcher.js";
