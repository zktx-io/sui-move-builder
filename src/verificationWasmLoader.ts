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
        const mod = await loadBundledBytecodeVerifier(verifier);
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
  verifier: RuntimeVerifier
): Promise<VerificationWasmModule> {
  let ready = bundledBytecodeVerifierReady.get(verifier.verifierId);
  if (!ready) {
    ready = importVerificationWasm(verifier.importSpecifier ?? "").then(
      async (mod) => {
        await withNodeFileFetch(async () => {
          await mod.default({});
        });
        return mod;
      }
    );
    bundledBytecodeVerifierReady.set(verifier.verifierId, ready);
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
