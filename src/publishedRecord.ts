import {
  asFailure,
  getPinnedSuiVersion,
  loadWasm,
  type MovePackageFailure,
  type MovePackagePublishSuccess,
  type MovePackageUpgradeSuccess,
} from "./core.js";

export interface MovePackagePublication {
  network: string;
  chainId: string;
  publishedAt: string;
  originalId: string;
  version: number;
  suiVersion?: string;
  buildConfig?: { edition: string; flavor: string };
  upgradeCapability?: string;
  transactionDigest?: string;
}

export interface MovePackagePublicationUpdateInput {
  files: Record<string, string>;
  prepared: MovePackagePublishSuccess | MovePackageUpgradeSuccess;
  network: string;
  chainId: string;
  result?: unknown;
  effects?: unknown;
  wasm?: string | URL | BufferSource;
}

export interface MovePackagePublicationUpdateResult {
  files: Record<string, string>;
  publishedToml: string;
  publication: MovePackagePublication;
}

interface ExecutionPublication {
  packageId: string;
  version: number;
  upgradeCapability?: string;
  transactionDigest?: string;
}

type PublicationUpdateResponse =
  | {
      status: "ok";
      publishedToml: string;
      publication: MovePackagePublication;
    }
  | { status: "error"; error?: string; code?: string };

export async function updateMovePackagePublication(
  input: MovePackagePublicationUpdateInput
): Promise<MovePackagePublicationUpdateResult | MovePackageFailure> {
  if (
    input.prepared.intent !== "publish" &&
    input.prepared.intent !== "upgrade"
  ) {
    return failure("Prepared result must have publish or upgrade intent");
  }

  const execution = extractPublication(input.result ?? input.effects, {
    requireUpgradeCapability: input.prepared.intent === "publish",
  });
  if ("error" in execution) {
    return execution;
  }

  let mod;
  try {
    mod = await loadWasm(input.wasm);
  } catch (error) {
    return asFailure(error, "wasm_init");
  }

  const suiVersion = await getPinnedSuiVersion({ wasm: input.wasm });
  let response: PublicationUpdateResponse;
  try {
    response = parsePublicationUpdateResponse(
      mod.publication_update(
        JSON.stringify({
          command: input.prepared.intent,
          files: input.files,
          network: input.network,
          chainId: input.chainId,
          publishedId: execution.packageId,
          version: execution.version,
          upgradeCapability: execution.upgradeCapability,
          suiVersion,
          transactionDigest: execution.transactionDigest,
        })
      )
    );
  } catch (error) {
    return asFailure(error, "input_validation");
  }

  if (response.status !== "ok") {
    return {
      error: response.error || "Publication update failed",
      category: "input_validation",
      code: response.code,
    };
  }

  const files: Record<string, string> = {
    ...input.files,
    "Published.toml": response.publishedToml,
  };

  return {
    files,
    publishedToml: response.publishedToml,
    publication: response.publication,
  };
}

function parsePublicationUpdateResponse(
  raw: string
): PublicationUpdateResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Rust publication_update returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { status?: unknown }).status !== "string"
  ) {
    throw new Error("Rust publication_update returned an invalid response");
  }
  return parsed as PublicationUpdateResponse;
}

function extractPublication(
  value: unknown,
  options: { requireUpgradeCapability: boolean }
): ExecutionPublication | MovePackageFailure {
  const result = unwrapTransactionResult(value);
  if ("error" in result) {
    return result;
  }

  const publishedPackage = findPublishedPackage(result);
  if (!publishedPackage) {
    return failure("Transaction result does not include a published package");
  }

  const upgradeCapability = findUpgradeCapability(result);
  if (options.requireUpgradeCapability && !upgradeCapability) {
    return failure("Transaction result does not include an UpgradeCap object");
  }

  return {
    packageId: publishedPackage.packageId,
    version: publishedPackage.version,
    upgradeCapability,
    transactionDigest: result.digest,
  };
}

function unwrapTransactionResult(value: unknown):
  | {
      digest?: string;
      effects: Record<string, unknown>;
      objectChanges: unknown[];
      objectTypes: Record<string, string>;
    }
  | MovePackageFailure {
  if (!value || typeof value !== "object") {
    return failure("Transaction result is required");
  }

  const source = value as Record<string, unknown>;
  if (source.$kind === "FailedTransaction") {
    return failure("Transaction did not execute successfully");
  }

  const tx =
    source.$kind === "Transaction" && source.Transaction
      ? (source.Transaction as Record<string, unknown>)
      : source;
  const effects = objectField(tx, "effects") ?? objectField(source, "effects");
  const status =
    objectField(tx, "status") ??
    objectField(effects, "status") ??
    objectField(source, "status");

  if (!isSuccessfulStatus(status)) {
    return failure("Transaction did not execute successfully");
  }

  return {
    digest: stringField(tx, "digest") ?? stringField(source, "digest"),
    effects: effects ?? {},
    objectChanges: arrayField(tx, "objectChanges")
      .concat(arrayField(source, "objectChanges"))
      .concat(arrayField(effects, "objectChanges")),
    objectTypes:
      recordOfStrings(tx.objectTypes) ??
      recordOfStrings(source.objectTypes) ??
      recordOfStrings(effects?.objectTypes) ??
      {},
  };
}

function findPublishedPackage(result: {
  effects: Record<string, unknown>;
  objectChanges: unknown[];
}): { packageId: string; version: number } | undefined {
  for (const change of result.objectChanges) {
    if (!change || typeof change !== "object") {
      continue;
    }
    const record = change as Record<string, unknown>;
    if (record.type === "published") {
      const packageId = stringField(record, "packageId");
      const version = numberField(record, "version");
      if (packageId && version !== undefined) {
        return { packageId: normalizePublishedAddress(packageId), version };
      }
    }
  }

  for (const changed of arrayField(result.effects, "changedObjects")) {
    if (!changed || typeof changed !== "object") {
      continue;
    }
    const record = changed as Record<string, unknown>;
    if (record.outputState === "PackageWrite") {
      const packageId = stringField(record, "objectId");
      const version = numberField(record, "outputVersion");
      if (packageId && version !== undefined) {
        return { packageId: normalizePublishedAddress(packageId), version };
      }
    }
  }

  return undefined;
}

function findUpgradeCapability(result: {
  effects: Record<string, unknown>;
  objectChanges: unknown[];
  objectTypes: Record<string, string>;
}): string | undefined {
  for (const change of result.objectChanges) {
    if (!change || typeof change !== "object") {
      continue;
    }
    const record = change as Record<string, unknown>;
    const objectType = stringField(record, "objectType");
    if (record.type === "created" && isUpgradeCapType(objectType)) {
      return normalizeOptionalAddress(stringField(record, "objectId"));
    }
  }

  for (const changed of arrayField(result.effects, "changedObjects")) {
    if (!changed || typeof changed !== "object") {
      continue;
    }
    const record = changed as Record<string, unknown>;
    const objectId = stringField(record, "objectId");
    if (
      objectId &&
      record.idOperation === "Created" &&
      isUpgradeCapType(result.objectTypes[objectId])
    ) {
      return normalizePublishedAddress(objectId);
    }
  }

  return undefined;
}

function isSuccessfulStatus(status: unknown): boolean {
  if (!status || typeof status !== "object") {
    return false;
  }
  const record = status as Record<string, unknown>;
  if (record.success === true) {
    return true;
  }
  return record.status === "success";
}

function isUpgradeCapType(value: string | undefined): boolean {
  const parts = value?.split("::");
  if (parts?.length !== 3) {
    return false;
  }
  const [address, moduleName, structName] = parts;
  if (moduleName !== "package" || structName !== "UpgradeCap") {
    return false;
  }
  try {
    return (
      normalizePublishedAddress(address) === normalizePublishedAddress("0x2")
    );
  } catch {
    return false;
  }
}

function normalizePublishedAddress(value: string): string {
  const clean = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length > 64) {
    throw new Error(`Invalid Sui address: ${value}`);
  }
  return `0x${clean.padStart(64, "0").toLowerCase()}`;
}

function objectField(
  value: unknown,
  key: string
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === "object"
    ? (field as Record<string, unknown>)
    : undefined;
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : [];
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(
  value: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const field = value?.[key];
  if (typeof field === "number" && Number.isFinite(field)) {
    return field;
  }
  if (typeof field === "string" && /^\d+$/.test(field)) {
    return Number(field);
  }
  return undefined;
}

function recordOfStrings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.every(([, entry]) => typeof entry === "string")) {
    return Object.fromEntries(entries) as Record<string, string>;
  }
  return undefined;
}

function normalizeOptionalAddress(
  value: string | undefined
): string | undefined {
  return value ? normalizePublishedAddress(value) : undefined;
}

function failure(error: string): MovePackageFailure {
  return { error, category: "input_validation" };
}
