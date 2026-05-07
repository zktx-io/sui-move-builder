import { VERIFICATION_RUNTIME_CONFIG } from "./generated/verificationRuntimeConfig.js";
import type {
  VerificationSelectedVerifier,
  VerificationSourceCompatibility,
  VerificationSourceEditionEvidence,
} from "./verification.js";

interface RuntimeVerifierConfig {
  decodedBytecodeVersion: number;
  defaultEdition: string | null;
  supportedEditions: readonly string[];
}

export function sourceCompatibilityEvidence(
  filesJson: string,
  dependenciesJson: string,
  selectedVerifier: VerificationSelectedVerifier
): VerificationSourceCompatibility | undefined {
  const verifierConfig = sourceCompatibilityConfig(selectedVerifier);
  if (!verifierConfig.defaultEdition) {
    return undefined;
  }
  const supportedEditions = [...verifierConfig.supportedEditions];
  const defaultEdition = verifierConfig.defaultEdition;
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

function sourceCompatibilityConfig(
  selectedVerifier: VerificationSelectedVerifier
): RuntimeVerifierConfig {
  const version =
    selectedVerifier.decodedBytecodeVersion ??
    VERIFICATION_RUNTIME_CONFIG.currentBytecodeVersion;
  const route = runtimeRoutes()[String(version)];
  const verifierId =
    route?.verifierId ?? VERIFICATION_RUNTIME_CONFIG.currentVerifierId;
  return runtimeVerifiers()[verifierId] ?? currentVerifierConfig();
}

function currentVerifierConfig(): RuntimeVerifierConfig {
  const current =
    runtimeVerifiers()[VERIFICATION_RUNTIME_CONFIG.currentVerifierId];
  if (!current) {
    throw new Error(
      `Missing current verifier ${VERIFICATION_RUNTIME_CONFIG.currentVerifierId}`
    );
  }
  return current;
}

function runtimeRoutes() {
  return VERIFICATION_RUNTIME_CONFIG.routes as Record<
    string,
    { verifierId: string }
  >;
}

function runtimeVerifiers() {
  return VERIFICATION_RUNTIME_CONFIG.verifiers as Record<
    string,
    RuntimeVerifierConfig
  >;
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
