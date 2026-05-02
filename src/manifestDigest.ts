export type ManifestDigestFn = (
  moveToml: string,
  packageNameOverride: string | undefined,
  environment: string
) => string;

export function computeManifestDigestFromMoveToml(
  digestFn: ManifestDigestFn | undefined,
  moveToml: string | undefined,
  packageName: string,
  environment: string
): string | undefined {
  if (!digestFn || !moveToml) {
    return undefined;
  }
  const digest = digestFn(moveToml, packageName, environment);
  return digest || undefined;
}

export function requireManifestDigestFromMoveToml(
  digestFn: ManifestDigestFn | undefined,
  moveToml: string | undefined,
  packageName: string,
  environment: string
): string {
  const digest = computeManifestDigestFromMoveToml(
    digestFn,
    moveToml,
    packageName,
    environment
  );
  if (!digest) {
    throw new Error(`Failed to compute manifest_digest for ${packageName}`);
  }
  return digest;
}
