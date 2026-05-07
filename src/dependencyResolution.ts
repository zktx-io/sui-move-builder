import { GitHubMovePackageFetcher } from "./fetcher.js";
import {
  resolve as resolveMoveToml,
  type DependencySource,
  type LockfileV4Helpers,
} from "./resolver.js";
import type {
  MovePackageInput,
  MovePackageResolvedDependencies,
} from "./core.js";
import type { MovePackageStageReport } from "./stageReports.js";
import { StructuredBuildError } from "./structuredError.js";

export type MovePackageResolvedDependenciesInternal =
  MovePackageResolvedDependencies & {
    stageReports?: MovePackageStageReport[];
  };

export type DependencyResolutionInput = Omit<
  MovePackageInput,
  "resolvedDependencies"
> & {
  includeTestMode?: boolean;
  skipLegacyPublicationMigration?: boolean;
};

export type LegacyPublicationMigrationResponse =
  | {
      status: "ok";
      publishedToml?: string;
      moveLock?: string;
    }
  | { status: "error"; error?: string; code?: string };

export function compilerModes(
  input: Pick<MovePackageInput, "modes">
): string[] {
  return input.modes ?? [];
}

export function packageSelectionModes(
  input: Pick<MovePackageInput, "modes"> & { includeTestMode?: boolean }
): string[] {
  const modes = [...compilerModes(input)];
  if (input.includeTestMode && !modes.includes("test")) {
    modes.push("test");
  }
  return modes;
}

export function emitMovePackageStageReports(
  onProgress: MovePackageInput["onProgress"],
  reports: MovePackageStageReport[] | undefined
): void {
  if (!onProgress || !reports) {
    return;
  }
  for (const report of reports) {
    onProgress({ type: "stage_trace", ...report });
  }
}

export function stripMovePackageStageReports(
  resolved: MovePackageResolvedDependenciesInternal
): MovePackageResolvedDependencies {
  return {
    files: resolved.files,
    dependencies: resolved.dependencies,
    lockfileDependencies: resolved.lockfileDependencies,
  };
}

export function parseLegacyPublicationMigrationResponse(
  raw: string,
  source: string
): LegacyPublicationMigrationResponse {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { status?: unknown }).status !== "string"
  ) {
    throw new Error(`${source} returned an invalid response`);
  }
  return parsed as LegacyPublicationMigrationResponse;
}

export function applyLegacyPublicationMigrationToFiles(
  files: Record<string, string>,
  runMigration: (files: Record<string, string>) => string,
  source: string
): string | undefined {
  if (!files["Move.lock"]) {
    return undefined;
  }

  const response = parseLegacyPublicationMigrationResponse(
    runMigration(files),
    source
  );
  if (response.status !== "ok") {
    throw new StructuredBuildError(
      response.error || "Legacy publication migration failed",
      response.code
    );
  }
  if (response.publishedToml) {
    files["Published.toml"] = response.publishedToml;
  }
  if (response.moveLock) {
    files["Move.lock"] = response.moveLock;
  }
  return response.publishedToml;
}

function rootGitSource(
  input: Pick<MovePackageInput, "rootGit">
): DependencySource | undefined {
  return input.rootGit
    ? {
        type: "git",
        git: input.rootGit.git,
        rev: input.rootGit.rev,
        subdir: input.rootGit.subdir,
      }
    : undefined;
}

export async function resolveSnapshotDependencies(
  input: DependencyResolutionInput,
  helpers: LockfileV4Helpers,
  legacyPublicationMigration?: (files: Record<string, string>) => void
): Promise<MovePackageResolvedDependenciesInternal> {
  const moveToml = input.files["Move.toml"] || "";
  const files = { ...input.files, "Move.toml": moveToml };

  if (!input.skipLegacyPublicationMigration) {
    legacyPublicationMigration?.(files);
  }

  const resolved = await resolveMoveToml(
    moveToml,
    files,
    input.fetcher ?? new GitHubMovePackageFetcher(input.githubToken),
    input.network,
    rootGitSource(input),
    helpers,
    packageSelectionModes(input),
    (report) => input.onProgress?.({ type: "fetch_failed", ...report })
  );

  return {
    files: resolved.files,
    dependencies: resolved.dependencies,
    lockfileDependencies: resolved.lockfileDependencies,
    ...(resolved.stageReports ? { stageReports: resolved.stageReports } : {}),
  };
}
