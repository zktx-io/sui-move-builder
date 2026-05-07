import type { MovePackageProvenanceResult } from "./verification.js";

export function displayMessageForResult(
  result: MovePackageProvenanceResult
): string {
  const verifier = result.selectedVerifier?.verifierId
    ? ` using verifier ${result.selectedVerifier.verifierId}`
    : "";
  const version =
    result.referenceBytecode?.decodedVersion !== undefined
      ? ` for decoded bytecode version ${result.referenceBytecode.decodedVersion}`
      : "";
  if (result.status === "verified") {
    return `Verification succeeded${verifier}${version}: ${
      result.verdict ?? "verified"
    }.`;
  }
  const stage = result.failureStage ? ` at ${result.failureStage}` : "";
  const reason =
    result.error ?? result.summary ?? result.verdict ?? result.status;
  return `Verification failed${stage}${verifier}${version}: ${reason}`;
}
