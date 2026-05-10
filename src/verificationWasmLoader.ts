import { loadWasm, type WasmModule, withNodeFileFetch } from "./core.js";
import { referenceBytecodeSummary } from "./verificationBytecode.js";
import { VERIFICATION_RUNTIME_CONFIG } from "./generated/verificationRuntimeConfig.js";
import type {
  MovePackageProvenanceInput,
  MovePackageProvenanceResult,
  VerificationReferenceBytecode,
  VerificationSelectedVerifier,
} from "./verification.js";

export type VerificationWasmModule = Pick<
  WasmModule,
  "sui_move_version" | "sui_version" | "verify_against_reference"
> & {
  verification_resolve_package_groups(inputJson: string): string;
};

type VerificationWasmInitializerModule = VerificationWasmModule & {
  default(init?: unknown): Promise<unknown>;
};

const ROUTE_IMPORT_RETRY_DELAYS_MS = [250, 750] as const;

export interface LoadedVerificationWasm {
  mod: VerificationWasmModule;
  selectedVerifier: VerificationSelectedVerifier;
  referenceBytecode: VerificationReferenceBytecode;
}

interface RuntimeRoute {
  decodedBytecodeVersion: number;
  candidates: readonly RuntimeRouteCandidate[];
}

interface RuntimeRouteCandidate {
  verifierId: string;
  epochId: string;
  decodedBytecodeVersion: number;
  bytecodeFlavor: number | null;
}

interface RuntimeVerifier {
  verifierId: string;
  epochId: string;
  decodedBytecodeVersion: number;
  bytecodeFlavor: number | null;
  importSpecifier: string | null;
}

export interface VerificationWasmCandidate {
  verifierId: string;
  epochId: string;
  referenceBytecode: VerificationReferenceBytecode;
  selectedVerifier: VerificationSelectedVerifier;
  load(): Promise<LoadedVerificationWasm>;
}

const bundledBytecodeVerifierReady = new Map<
  string,
  Promise<VerificationWasmModule>
>();

export async function loadVerificationWasmCandidates(
  input: MovePackageProvenanceInput
): Promise<VerificationWasmCandidate[]> {
  const referenceBytecode = referenceBytecodeSummary(input.reference);
  if (input.wasm) {
    const customVerifier: VerificationSelectedVerifier = {
      verifierId: input.wasmVerifier?.verifierId ?? "custom",
      epochId: input.wasmVerifier?.epochId ?? "custom",
      decodedBytecodeVersion:
        input.wasmVerifier?.decodedBytecodeVersion ??
        referenceBytecode.decodedVersion,
      bytecodeFlavor:
        input.wasmVerifier?.bytecodeFlavor ?? referenceBytecode.flavor,
    };
    return [
      {
        verifierId: customVerifier.verifierId,
        epochId: customVerifier.epochId ?? customVerifier.verifierId,
        referenceBytecode,
        selectedVerifier: customVerifier,
        async load() {
          const mod = (await loadWasm(
            input.wasm
          )) as unknown as VerificationWasmModule;
          return {
            mod,
            referenceBytecode,
            selectedVerifier: {
              ...customVerifier,
              suiVersion: safeSuiVersion(mod),
            },
          };
        },
      },
    ];
  }
  const verifierAssetBaseUrl = normalizedVerifierAssetBaseUrl(
    input.verifierAssetBaseUrl,
    referenceBytecode
  );

  const bytecodeVersion = referenceBytecode.decodedVersion;
  if (
    bytecodeVersion === undefined ||
    bytecodeVersion === VERIFICATION_RUNTIME_CONFIG.currentBytecodeVersion
  ) {
    const current = currentVerifierConfig();
    return [
      {
        verifierId: current.verifierId,
        epochId: current.epochId,
        referenceBytecode,
        selectedVerifier: {
          verifierId: current.verifierId,
          epochId: current.epochId,
          decodedBytecodeVersion:
            bytecodeVersion ?? current.decodedBytecodeVersion,
          bytecodeFlavor: referenceBytecode.flavor ?? current.bytecodeFlavor,
        },
        async load() {
          const mod = (await loadWasm()) as unknown as VerificationWasmModule;
          return {
            mod,
            referenceBytecode,
            selectedVerifier: {
              verifierId: current.verifierId,
              epochId: current.epochId,
              suiVersion: safeSuiVersion(mod),
              decodedBytecodeVersion:
                bytecodeVersion ?? current.decodedBytecodeVersion,
              bytecodeFlavor:
                referenceBytecode.flavor ?? current.bytecodeFlavor,
            },
          };
        },
      },
    ];
  }

  const route = routeForBytecodeVersion(bytecodeVersion);
  if (!route) {
    throw unsupportedBytecodeVersion(bytecodeVersion, referenceBytecode);
  }
  const candidates = orderedRouteCandidates(route).map(
    ({ candidate, verifier }) => ({
      verifierId: verifier.verifierId,
      epochId: verifier.epochId,
      referenceBytecode,
      selectedVerifier: {
        verifierId: verifier.verifierId,
        epochId: verifier.epochId,
        decodedBytecodeVersion: bytecodeVersion,
        bytecodeFlavor: referenceBytecode.flavor,
      },
      async load() {
        if (!verifier.importSpecifier) {
          throw unsupportedBytecodeVersion(bytecodeVersion, referenceBytecode);
        }
        const importSpecifier = verifierImportSpecifier(
          verifier,
          verifierAssetBaseUrl
        );
        const mod = await loadBundledBytecodeVerifier(verifier, importSpecifier);
        return {
          mod,
          referenceBytecode,
          selectedVerifier: {
            verifierId: verifier.verifierId,
            epochId: verifier.epochId,
            suiVersion: safeSuiVersion(mod),
            decodedBytecodeVersion: bytecodeVersion,
            bytecodeFlavor:
              referenceBytecode.flavor ?? candidate.bytecodeFlavor,
          },
        };
      },
    })
  );
  if (candidates.length === 0) {
    throw unsupportedBytecodeVersion(bytecodeVersion, referenceBytecode);
  }
  return candidates;
}

function unsupportedBytecodeVersion(
  bytecodeVersion: number,
  referenceBytecode: VerificationReferenceBytecode
): MovePackageProvenanceResult {
  const error = `Unsupported decoded bytecode version ${bytecodeVersion}. Supported bundled verifier versions: ${supportedBytecodeVersions()
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
  verifier: RuntimeVerifier,
  importSpecifier: string
): Promise<VerificationWasmModule> {
  const cacheKey = `${verifier.verifierId}|${importSpecifier}`;
  let ready = bundledBytecodeVerifierReady.get(cacheKey);
  if (!ready) {
    ready = importVerificationWasm(importSpecifier).then(async (mod) => {
      await withNodeFileFetch(async () => {
        await mod.default({});
      });
      return mod;
    });
    ready.catch(() => {
      if (bundledBytecodeVerifierReady.get(cacheKey) === ready) {
        bundledBytecodeVerifierReady.delete(cacheKey);
      }
    });
    bundledBytecodeVerifierReady.set(cacheKey, ready);
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
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt <= ROUTE_IMPORT_RETRY_DELAYS_MS.length;
    attempt++
  ) {
    const attemptSpecifier =
      attempt === 0 ? specifier : retryImportSpecifier(specifier, attempt);
    try {
      return await dynamicImport(attemptSpecifier);
    } catch (error) {
      lastError = error;
      if (
        attempt >= ROUTE_IMPORT_RETRY_DELAYS_MS.length ||
        !(await shouldRetryRouteImport(specifier, error))
      ) {
        throw error;
      }
      await delay(ROUTE_IMPORT_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

function normalizedVerifierAssetBaseUrl(
  value: string | URL | undefined,
  referenceBytecode: VerificationReferenceBytecode
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const invalid = (reason: string): never => {
    throw inputValidationFailure(
      `Invalid verifierAssetBaseUrl: ${reason}`,
      referenceBytecode
    );
  };
  if (value instanceof URL) {
    if (value.protocol !== "http:" && value.protocol !== "https:") {
      invalid("URL objects must use http: or https:");
    }
    if (value.search || value.hash) {
      invalid("query strings and hashes are not supported");
    }
    return trimTrailingSlash(value.toString());
  }
  const raw = value.trim();
  if (!raw) {
    invalid("value must not be empty");
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      invalid("absolute URLs must be valid HTTP(S) URLs");
    }
    if (url.search || url.hash) {
      invalid("query strings and hashes are not supported");
    }
    return trimTrailingSlash(url.toString());
  }
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    if (raw.includes("?") || raw.includes("#")) {
      invalid("query strings and hashes are not supported");
    }
    return trimTrailingSlash(raw);
  }
  invalid("use a root-relative path such as /assets or an absolute HTTP(S) URL");
}

function verifierImportSpecifier(
  verifier: RuntimeVerifier,
  verifierAssetBaseUrl: string | undefined
): string {
  if (verifierAssetBaseUrl === undefined) {
    return verifier.importSpecifier ?? "";
  }
  const relative = (verifier.importSpecifier ?? "").replace(/^\.\/+/, "");
  return verifierAssetBaseUrl
    ? `${verifierAssetBaseUrl}/${relative}`
    : `/${relative}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function inputValidationFailure(
  error: string,
  referenceBytecode: VerificationReferenceBytecode
): MovePackageProvenanceResult {
  return {
    status: "build_failure",
    failureStage: "input_validation",
    error,
    displayMessage: `Verification failed at input_validation: ${error}`,
    referenceBytecode,
  };
}

function retryImportSpecifier(specifier: string, attempt: number): string {
  if (!isPathLikeImportSpecifier(specifier)) {
    return specifier;
  }
  const separator = specifier.includes("?") ? "&" : "?";
  return `${specifier}${separator}sui_move_builder_retry=${attempt}`;
}

function isPathLikeImportSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("http://") ||
    specifier.startsWith("https://")
  );
}

async function shouldRetryRouteImport(
  specifier: string,
  _error: unknown
): Promise<boolean> {
  const status = await routeImportStatus(specifier);
  if (status === undefined) {
    return true;
  }
  if (status >= 400) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  return true;
}

async function routeImportStatus(specifier: string): Promise<number | undefined> {
  const url = statusProbeUrl(specifier);
  if (!url || typeof fetch !== "function") {
    return undefined;
  }
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.status;
  } catch {
    return undefined;
  }
}

function statusProbeUrl(specifier: string): string | undefined {
  if (specifier.startsWith("http://") || specifier.startsWith("https://")) {
    return specifier;
  }
  if (specifier.startsWith("/")) {
    return specifier;
  }
  return undefined;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function currentVerifierConfig(): RuntimeVerifier {
  const current = verifierConfig(VERIFICATION_RUNTIME_CONFIG.currentVerifierId);
  if (!current) {
    throw new Error(
      `Missing current verifier ${VERIFICATION_RUNTIME_CONFIG.currentVerifierId}`
    );
  }
  return current;
}

function routeForBytecodeVersion(
  bytecodeVersion: number
): RuntimeRoute | undefined {
  return runtimeRoutes()[String(bytecodeVersion)];
}

function verifierConfig(verifierId: string): RuntimeVerifier | undefined {
  return runtimeVerifiers()[verifierId];
}

function supportedBytecodeVersions(): number[] {
  return Object.keys(runtimeRoutes()).map((version) =>
    Number.parseInt(version, 10)
  );
}

function runtimeRoutes() {
  return VERIFICATION_RUNTIME_CONFIG.routes as unknown as Record<
    string,
    RuntimeRoute
  >;
}

function runtimeVerifiers() {
  return VERIFICATION_RUNTIME_CONFIG.verifiers as unknown as Record<
    string,
    RuntimeVerifier
  >;
}

function safeSuiVersion(mod: VerificationWasmModule): string | undefined {
  try {
    return mod.sui_version();
  } catch {
    return undefined;
  }
}

function orderedRouteCandidates(route: RuntimeRoute) {
  return route.candidates
    .map((candidate) => {
      const verifier = verifierConfig(candidate.verifierId);
      if (!verifier) return undefined;
      return { candidate, verifier };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
}
