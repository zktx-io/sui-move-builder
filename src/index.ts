type MaybePromise<T> = T | Promise<T>;

export interface BuildInput {
  /** Virtual file system contents. Keys are paths (e.g. "Move.toml", "sources/Module.move"). */
  files: Record<string, string>;
  /** Optional dependency files keyed by path. */
  dependencies?: Record<string, string>;
  /** Optional custom URL for the wasm binary. Defaults to bundled wasm next to this module. */
  wasm?: string | URL;
}

export interface BuildSuccess {
  success: true;
  /** Base64-encoded bytecode modules. */
  modules: string[];
  /** Hex-encoded dependency IDs. */
  dependencies: string[];
  /** Hex-encoded Blake2b-256 package digest. */
  digest: string;
}

export interface BuildFailure {
  success: false;
  error: string;
}

type WasmModule = typeof import("./sui_move_wasm.js");

const wasmUrl = (() => {
  try {
    // Works in ESM builds; CJS bundle falls back to plain string.
    return new URL("./sui_move_wasm_bg.wasm", import.meta.url);
  } catch {
    return "./sui_move_wasm_bg.wasm";
  }
})();
let wasmReady: Promise<WasmModule> | undefined;

async function loadWasm(customWasm?: string | URL): Promise<WasmModule> {
  if (!wasmReady) {
    wasmReady = import("./sui_move_wasm.js").then(async (mod) => {
      await mod.default(customWasm ?? wasmUrl);
      return mod;
    });
  }
  return wasmReady;
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function asFailure(err: unknown): BuildFailure {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Unknown error";
  return { success: false, error: msg };
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
  const toHex = (bytes: number[]): string =>
    bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  try {
    const parsed = JSON.parse(output) as {
      modules?: string[];
      dependencies?: string[];
      digest?: number[] | string;
    };
    if (!parsed.modules || !parsed.dependencies || !parsed.digest) {
      throw new Error("missing fields in compiler output");
    }
    const digestHex =
      typeof parsed.digest === "string" ? parsed.digest : toHex(parsed.digest);
    return {
      success: true,
      modules: parsed.modules,
      dependencies: parsed.dependencies,
      digest: digestHex,
    };
  } catch (error) {
    return asFailure(error);
  }
}

/** Initialize the wasm module (idempotent). Provide a custom wasm URL if hosting separately. */
export async function initMoveCompiler(options?: {
  wasm?: string | URL;
}): Promise<void> {
  await loadWasm(options?.wasm);
}

/** Compile a Move package in memory using the bundled Move compiler wasm. */
export async function buildMovePackage(
  input: BuildInput
): Promise<BuildSuccess | BuildFailure> {
  try {
    const mod = await loadWasm(input.wasm);
    const raw = mod.compile(
      toJson(input.files),
      toJson(input.dependencies ?? {})
    );
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
  options?: { wasm?: string | URL }
) {
  const mod = await loadWasm(options?.wasm);
  const result = ensureCompileResult(mod.compile(filesJson, depsJson));
  return {
    success: result.success(),
    output: result.output(),
  };
}

export type BuildResult = BuildSuccess | BuildFailure;

// Resolver utilities (optional dependency fetching)
export { resolve, Resolver } from "./resolver.js";
export { GitHubFetcher, Fetcher } from "./fetcher.js";
export { parseToml } from "./tomlParser.js";
