import { GitHubFetcher } from "./fetcher.js";
import { resolve as resolveMoveToml } from "./resolver.js";

export interface BuildInput {
  /** Virtual file system contents. Keys are paths (e.g. "Move.toml", "sources/Module.move"). */
  files: Record<string, string>;
  /** Optional dependency files keyed by path. */
  dependencies?: Record<string, string>;
  /** Optional custom URL for the wasm binary. Defaults to bundled wasm next to this module. */
  wasm?: string | URL;
  /** Emit ANSI color codes in diagnostics when available. */
  ansiColor?: boolean;
  /** Inject standard Sui system packages when missing (CLI-like behavior). */
  autoSystemDeps?: boolean;
  /** Network environment (mainnet, testnet, devnet). Defaults to mainnet. */
  network?: "mainnet" | "testnet" | "devnet";
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

function normalizeAddress(addr: string) {
  if (!addr) return addr;
  let clean = addr;
  if (clean.startsWith("0x")) clean = clean.slice(2);
  if (/^[0-9a-fA-F]+$/.test(clean)) {
    return "0x" + clean.padStart(64, "0");
  }
  return addr;
}

function ensureDefaultAddresses(moveToml: string): string {
  const defaults: Record<string, string> = {
    std: "0x1",
    sui: "0x2",
    sui_system: "0x3",
    bridge: "0xb",
  };
  const lines = moveToml.split(/\r?\n/);
  const sectionHeader = /^\s*\[[^\]]+\]\s*$/;
  let addrStart = -1;
  let addrEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[addresses\]\s*$/.test(lines[i])) {
      addrStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (sectionHeader.test(lines[j])) {
          addrEnd = j;
          break;
        }
      }
      break;
    }
  }

  const existing = new Set<string>();
  if (addrStart >= 0) {
    for (let i = addrStart + 1; i < addrEnd; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
      if (match) existing.add(match[1]);
    }
  }

  const missingLines = Object.entries(defaults)
    .filter(([name]) => !existing.has(name))
    .map(([name, value]) => `${name} = "${normalizeAddress(value)}"`);

  if (missingLines.length === 0) return moveToml;

  if (addrStart >= 0) {
    lines.splice(addrEnd, 0, ...missingLines);
  } else {
    lines.push("", "[addresses]", ...missingLines);
  }
  return lines.join("\n");
}

function ensureSystemDepsInMoveToml(moveToml: string): string {
  const systemDeps = [
    {
      name: "Sui",
      git: "https://github.com/MystenLabs/sui.git",
      subdir: "crates/sui-framework/packages/sui-framework",
      rev: "framework/mainnet",
    },
    {
      name: "MoveStdlib",
      git: "https://github.com/MystenLabs/sui.git",
      subdir: "crates/sui-framework/packages/move-stdlib",
      rev: "framework/mainnet",
    },
  ];
  const lines = moveToml.split(/\r?\n/);
  const sectionHeader = /^\s*\[[^\]]+\]\s*$/;
  let depsStart = -1;
  let depsEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[dependencies\]\s*$/.test(lines[i])) {
      depsStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (sectionHeader.test(lines[j])) {
          depsEnd = j;
          break;
        }
      }
      break;
    }
  }

  const existing = new Set<string>();
  if (depsStart >= 0) {
    for (let i = depsStart + 1; i < depsEnd; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
      if (match) existing.add(match[1]);
    }
  }

  const missingLines = systemDeps
    .filter((dep) => !existing.has(dep.name))
    .map(
      (dep) =>
        `${dep.name} = { git = "${dep.git}", subdir = "${dep.subdir}", rev = "${dep.rev}" }`
    );

  if (missingLines.length === 0) return moveToml;

  if (depsStart >= 0) {
    lines.splice(depsEnd, 0, ...missingLines);
  } else {
    lines.push("", "[dependencies]", ...missingLines);
  }
  return lines.join("\n");
}

function injectFallbackSystemDeps(
  deps: Record<string, string> | undefined
): Record<string, string> {
  const next = { ...(deps ?? {}) };
  if (next["dependencies/MoveStdlib/Move.toml"]) return next;
  const systemPkgs = [
    { name: "MoveStdlib", id: "0x1" },
    { name: "Sui", id: "0x2" },
    { name: "SuiSystem", id: "0x3" },
    { name: "Bridge", id: "0xb" },
  ];
  for (const pkg of systemPkgs) {
    const targetPath = `dependencies/${pkg.name}/Move.toml`;
    if (next[targetPath]) continue;
    next[targetPath] = [
      "[package]",
      `name = "${pkg.name}"`,
      'version = "0.0.0"',
      `published-at = "${normalizeAddress(pkg.id)}"`,
      "",
    ].join("\n");
  }
  return next;
}

function hasSystemDeps(deps: Record<string, string> | undefined): boolean {
  return Boolean(
    deps?.["dependencies/MoveStdlib/Move.toml"] &&
    deps?.["dependencies/Sui/Move.toml"]
  );
}

function asRecord(
  value: string | Record<string, string>
): Record<string, string> {
  return typeof value === "string" ? JSON.parse(value) : value;
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
    let dependencies = input.dependencies ?? {};
    let files = { ...input.files };
    const hasMoveToml = typeof files["Move.toml"] === "string";

    if (input.autoSystemDeps && hasMoveToml) {
      let moveToml = ensureDefaultAddresses(files["Move.toml"]);
      if (!hasSystemDeps(dependencies)) {
        moveToml = ensureSystemDepsInMoveToml(moveToml);
      }
      files["Move.toml"] = moveToml;
    }

    if (input.autoSystemDeps && !hasSystemDeps(dependencies) && hasMoveToml) {
      const resolved = await resolveMoveToml(
        files["Move.toml"],
        files,
        new GitHubFetcher(),
        input.network // Pass the network argument here
      );
      files = asRecord(resolved.files);
      dependencies = asRecord(resolved.dependencies);
    } else if (input.autoSystemDeps) {
      dependencies = injectFallbackSystemDeps(dependencies);
    }

    const mod = await loadWasm(input.wasm);
    const raw =
      input.ansiColor && typeof (mod as any).compile_with_color === "function"
        ? (mod as any).compile_with_color(
            toJson(files),
            toJson(dependencies),
            true
          )
        : mod.compile(toJson(files), toJson(dependencies));
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

// Resolver utilities (optional dependency fetching)
export { resolve, Resolver } from "./resolver.js";
export { GitHubFetcher, Fetcher } from "./fetcher.js";
export { parseToml } from "./tomlParser.js";

// Package fetching utilities
export {
  fetchPackageFromGitHub,
  fetchPackagesFromGitHub,
  parseGitHubUrl,
  githubUrl,
} from "./packageFetcher.js";
