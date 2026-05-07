import type {
  ReferenceArtifact,
  VerificationReferenceBytecode,
} from "./verification.js";

export function referenceBytecodeSummary(
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
  const decodedVersion = rawVersionWord & 0x00ff_ffff;
  const rawFlavor = rawVersionWord >>> 24;
  return {
    decodedVersion,
    flavor: bytecodeFlavor(decodedVersion, rawFlavor),
  };
}

function bytecodeFlavor(
  decodedVersion: number,
  rawFlavor: number
): number | null {
  if (rawFlavor !== 0) {
    return rawFlavor;
  }
  return decodedVersion <= 6 ? null : 0;
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
