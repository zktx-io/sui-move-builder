/**
 * Resolver for host-side package loading.
 *
 * TypeScript owns fetch/fetchLocal and snapshot assembly. Rust/WASM owns
 * manifest/lockfile package-group construction for compiler input.
 */

import { parseToml } from "./tomlParser.js";
import type {
  MovePackageFetcher,
  MovePackageFetchLocalContext,
} from "./fetcher.js";
import { StructuredBuildError } from "./structuredError.js";

// Load from shared config (synchronized with scripts/build-wasm.mjs)
import suiVersionConfig from "../sui-version.json" with { type: "json" };

/**
 * Default Sui framework revision for WASM builds when building without lockfile.
 *
 * ORIGINAL SOURCE REFERENCE: sui-package-alt/src/environments.rs:10-22
 * - latest_system_packages().git_revision provides framework version
 * - Used when no lockfile exists and Sui dependency is implicit
 *
 * Value loaded from sui-version.json (shared with build script)
 */
const WASM_BUILD_FRAMEWORK_REV = suiVersionConfig.commit;

export interface DependencySource {
  type: "git" | "local" | "onchain";
  git?: string;
  rev?: string;
  subdir?: string;
  local?: string;
  address?: string;
}

export interface LockfileV4Helpers {
  fetchPlan: (moveLockToml: string, environment: string) => string;
  resolvePackageGroups: (inputJson: string) => string;
  manifestGraphResolvePackageGroups?: (inputJson: string) => string;
}

interface LockfileV4PlanSource {
  type: "root" | "git" | "local";
  git?: string;
  rev?: string;
  subdir?: string;
  local?: string;
}

interface LockfileV4PlanPackage {
  id: string;
  source: LockfileV4PlanSource;
  deps?: Record<string, string>;
  manifestDigest?: string;
  files?: Record<string, string>;
}

interface LockfileV4FetchPlanResponse {
  status: "ok" | "missing" | "error";
  error?: string;
  code?: string;
  reason?: string;
  rootId?: string;
  lockfileOrder?: string[];
  packages?: LockfileV4PlanPackage[];
}

interface LockfileV4ResolvePackageGroupsResponse {
  status: "ok" | "out_of_date" | "error";
  error?: string;
  code?: string;
  reason?: string;
  packageId?: string;
  rootFiles?: Record<string, string>;
  dependencies?: unknown[];
  lockfileDependencies?: unknown[];
}

interface ManifestGraphPackageGroupsResponse {
  status: "needFetch" | "ok" | "error";
  error?: string;
  code?: string;
  requests?: ManifestGraphFetchRequest[];
  rootFiles?: Record<string, string>;
  dependencies?: unknown[];
  lockfileDependencies?: unknown[];
}

interface ManifestGraphFetchRequest {
  source: LockfileV4PlanSource;
  dependencyName: string;
  parentPackageName: string;
  parentSource: LockfileV4PlanSource;
}

interface ManifestGraphFetchedPackage {
  source: LockfileV4PlanSource;
  requestedSource?: LockfileV4PlanSource;
  files: Record<string, string>;
}

export class Resolver {
  private fetcher: MovePackageFetcher;
  private network: "mainnet" | "testnet" | "devnet";
  private rootSource: DependencySource | null;
  private lockfileV4Helpers: LockfileV4Helpers | undefined;
  private modes: string[];

  constructor(
    fetcher: MovePackageFetcher,
    network: "mainnet" | "testnet" | "devnet" = "mainnet",
    rootSource: DependencySource | null = null,
    lockfileV4Helpers?: LockfileV4Helpers,
    modes: string[] = []
  ) {
    this.fetcher = fetcher;
    this.network = network;
    this.rootSource = rootSource;
    this.lockfileV4Helpers = lockfileV4Helpers;
    this.modes = modes;
  }

  /**
   * Main resolve function using 3-layer architecture
   */
  async resolve(
    rootMoveToml: string,
    rootFiles: Record<string, string>
  ): Promise<{
    files: string;
    dependencies: string;
    lockfileDependencies: string;
  }> {
    const networkTomlName = `Move.${this.network}.toml`;
    const selectedRootMoveToml = rootFiles[networkTomlName] || rootMoveToml;

    // Parse root Move.toml
    const rootParsed = parseToml(selectedRootMoveToml);
    const rootPackageName = rootParsed.package?.name || "RootPackage";

    const resolvedFromLockfileV4 = await this.resolveFromLockfileV4(
      rootFiles,
      rootPackageName
    );
    if (resolvedFromLockfileV4) {
      return resolvedFromLockfileV4;
    }

    if (rootFiles["Move.lock"]) {
      const parsedLockfile = parseToml(rootFiles["Move.lock"]) as any;
      const lockfileVersion = parsedLockfile.move?.version;
      if (Number(lockfileVersion) > 4) {
        throw new Error(
          `Move.lock version ${lockfileVersion} is newer than the supported V4 schema`
        );
      }
    }

    return this.resolveManifestGraphPackageGroups(rootFiles);
  }

  private parseManifestGraphPackageGroupsResponse(
    raw: string
  ): ManifestGraphPackageGroupsResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Rust manifest graph resolution returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { status?: unknown }).status !== "string"
    ) {
      throw new Error(
        "Rust manifest graph resolution returned an invalid response shape"
      );
    }

    return parsed as ManifestGraphPackageGroupsResponse;
  }

  private packageSourceToRustSource(
    source: DependencySource | null,
    packageId: string
  ): LockfileV4PlanSource {
    if (!source) {
      return { type: "root" };
    }
    return this.dependencySourceToRustSource(source, packageId);
  }

  private dependencySourceToRustSource(
    source: DependencySource,
    packageId: string
  ): LockfileV4PlanSource {
    if (source.type === "git") {
      if (!source.git || !source.rev) {
        throw new Error(
          `Manifest package '${packageId}' has invalid git source`
        );
      }
      return {
        type: "git",
        git: source.git,
        rev: source.rev,
        subdir: source.subdir,
      };
    }

    if (source.type === "local") {
      if (!source.local) {
        throw new Error(
          `Manifest package '${packageId}' has invalid local source`
        );
      }
      return {
        type: "local",
        local: source.local,
      };
    }

    throw new Error(
      `Manifest package '${packageId}' has unsupported source ${this.describeSource(source)}`
    );
  }

  private async resolveManifestGraphPackageGroups(
    rootFiles: Record<string, string>
  ): Promise<{
    files: string;
    dependencies: string;
    lockfileDependencies: string;
  }> {
    if (!this.lockfileV4Helpers?.manifestGraphResolvePackageGroups) {
      throw new Error(
        "Rust manifest_graph_resolve_package_groups helper is required"
      );
    }

    const packages: ManifestGraphFetchedPackage[] = [];
    const fetchedRequests = new Set<string>();
    const rootSource = this.packageSourceToRustSource(this.rootSource, "root");

    for (let iteration = 0; iteration < 1024; iteration++) {
      const resolved = this.parseManifestGraphPackageGroupsResponse(
        this.lockfileV4Helpers.manifestGraphResolvePackageGroups(
          JSON.stringify({
            environment: this.network,
            frameworkRev: WASM_BUILD_FRAMEWORK_REV,
            root: {
              source: rootSource,
              files: rootFiles,
            },
            packages,
            modes: this.modes,
          })
        )
      );

      if (resolved.status === "ok") {
        if (
          !resolved.rootFiles ||
          !resolved.dependencies ||
          !resolved.lockfileDependencies
        ) {
          throw new Error(
            "Manifest graph resolution did not include package groups"
          );
        }
        return {
          files: JSON.stringify(resolved.rootFiles),
          dependencies: JSON.stringify(resolved.dependencies),
          lockfileDependencies: JSON.stringify(resolved.lockfileDependencies),
        };
      }

      if (resolved.status === "error") {
        throw new StructuredBuildError(
          resolved.error || "Manifest graph resolution failed",
          resolved.code
        );
      }

      const requests = resolved.requests || [];
      if (requests.length === 0) {
        throw new Error(
          "Manifest graph resolution requested fetches but returned no requests"
        );
      }

      let fetchedAny = false;
      for (const request of requests) {
        const requestKey = this.lockfileV4PlanSourceKey(request.source);
        if (fetchedRequests.has(requestKey)) {
          continue;
        }
        fetchedRequests.add(requestKey);
        packages.push(await this.fetchManifestGraphPackage(request));
        fetchedAny = true;
      }

      if (!fetchedAny) {
        throw new Error(
          "Manifest graph resolution could not make progress fetching dependencies"
        );
      }
    }

    throw new Error("Manifest graph resolution exceeded the iteration limit");
  }

  private async fetchManifestGraphPackage(
    request: ManifestGraphFetchRequest
  ): Promise<ManifestGraphFetchedPackage> {
    const requestedSource = { ...request.source };
    const source = { ...request.source };
    let files: Record<string, string>;

    if (source.type === "git") {
      if (!source.git || !source.rev) {
        throw new Error(
          `Manifest dependency '${request.dependencyName}' has invalid git source`
        );
      }
      files = await this.fetcher.fetch(source.git, source.rev, source.subdir);
      if (!files || Object.keys(files).length === 0) {
        throw new Error(
          `Dependency '${request.dependencyName}' from ${this.describeLockfileV4Source(source)} returned no files`
        );
      }
      const resolvedSha = this.fetcher.getResolvedSha(source.git, source.rev);
      if (resolvedSha) {
        source.rev = resolvedSha;
      }
    } else if (source.type === "local") {
      if (!source.local) {
        throw new Error(
          `Manifest dependency '${request.dependencyName}' has invalid local source`
        );
      }
      if (typeof this.fetcher.fetchLocal !== "function") {
        throw new Error(
          `Local dependency '${request.dependencyName}' at '${source.local}' requires fetcher.fetchLocal(localPath, context)`
        );
      }
      files = await this.fetcher.fetchLocal(source.local, {
        dependencyName: request.dependencyName,
        parentPackageName: request.parentPackageName,
        parentSource: this.lockfileV4SourceToParentDependencySource(
          request.parentSource
        ),
        network: this.network,
      });
      if (!files || Object.keys(files).length === 0) {
        throw new Error(
          `Local dependency '${request.dependencyName}' at '${source.local}' returned no files`
        );
      }
    } else {
      throw new Error(
        `Dependency '${request.dependencyName}' has unsupported source ${this.describeLockfileV4Source(source)}`
      );
    }

    if (!this.filesIncludeMoveToml(files)) {
      throw new Error(
        `Dependency '${request.dependencyName}' from ${this.describeLockfileV4Source(source)} did not provide Move.toml`
      );
    }

    return {
      source,
      requestedSource,
      files,
    };
  }

  private lockfileV4PlanSourceKey(source: LockfileV4PlanSource): string {
    if (source.type === "git") {
      return `git|${source.git || ""}|${source.rev || ""}|${source.subdir || ""}`;
    }
    if (source.type === "local") {
      return `local|${source.local || ""}`;
    }
    return "root";
  }

  private lockfileV4SourceToParentDependencySource(
    source: LockfileV4PlanSource
  ): DependencySource {
    if (source.type === "git") {
      return {
        type: "git",
        git: source.git,
        rev: source.rev,
        subdir: source.subdir,
      };
    }
    if (source.type === "local") {
      return {
        type: "local",
        local: source.local,
      };
    }
    return this.rootSource || { type: "local" };
  }

  private describeSource(source: DependencySource): string {
    if (source.type === "git") {
      return `${source.git}@${source.rev}${source.subdir ? `/${source.subdir}` : ""}`;
    }
    if (source.type === "local") {
      return source.local ? `local:${source.local}` : "local:<root>";
    }
    return source.type;
  }

  private describeLockfileV4Source(source: LockfileV4PlanSource): string {
    if (source.type === "git") {
      return `${source.git}@${source.rev}${source.subdir ? `/${source.subdir}` : ""}`;
    }
    if (source.type === "local") {
      return source.local ? `local:${source.local}` : "local:<empty>";
    }
    return "root";
  }

  private filesIncludeMoveToml(files: Record<string, string>): boolean {
    return Object.keys(files).some((path) => path.endsWith("Move.toml"));
  }

  private async fetchLocalPackage(
    localPath: string,
    dependencyName: string,
    parentPackageName: string,
    parentSource: DependencySource
  ): Promise<Record<string, string>> {
    if (typeof this.fetcher.fetchLocal !== "function") {
      throw new Error(
        `Local dependency '${dependencyName}' at '${localPath}' requires fetcher.fetchLocal(localPath, context)`
      );
    }

    const context: MovePackageFetchLocalContext = {
      dependencyName,
      parentPackageName,
      parentSource,
      network: this.network,
    };
    const files = await this.fetcher.fetchLocal(localPath, context);
    if (!files || Object.keys(files).length === 0) {
      throw new Error(
        `Local dependency '${dependencyName}' at '${localPath}' returned no files`
      );
    }
    return files;
  }

  /**
   * Load from Move.lock version 4+ format (pinned section)
   */
  private parseLockfileV4Response<
    T extends { status?: string; error?: string },
  >(raw: string, operation: string): T {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Rust lockfile V4 ${operation} returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { status?: unknown }).status !== "string"
    ) {
      throw new Error(
        `Rust lockfile V4 ${operation} returned an invalid response shape`
      );
    }

    return parsed as T;
  }

  private lockfileV4SourceToDependencySource(
    source: LockfileV4PlanSource,
    packageId: string
  ): DependencySource {
    if (source.type === "root") {
      return { type: "local" };
    }

    if (source.type === "git") {
      if (!source.git || !source.rev) {
        throw new Error(
          `Move.lock V4 package '${packageId}' has invalid git source`
        );
      }
      return {
        type: "git",
        git: source.git,
        rev: source.rev,
        subdir: source.subdir,
      };
    }

    if (source.type === "local") {
      if (!source.local) {
        throw new Error(
          `Move.lock V4 package '${packageId}' has invalid local source`
        );
      }
      return {
        type: "local",
        local: source.local,
      };
    }

    throw new Error(
      `Move.lock V4 package '${packageId}' has unsupported source`
    );
  }

  private async resolveFromLockfileV4(
    rootFiles: Record<string, string>,
    rootPackageName: string
  ): Promise<{
    files: string;
    dependencies: string;
    lockfileDependencies: string;
  } | null> {
    if (!this.lockfileV4Helpers) {
      return null;
    }

    const moveLockContent = rootFiles["Move.lock"];
    if (!moveLockContent) {
      return null;
    }

    const plan = this.parseLockfileV4Response<LockfileV4FetchPlanResponse>(
      this.lockfileV4Helpers.fetchPlan(moveLockContent, this.network),
      "fetch plan"
    );
    if (plan.status === "missing") {
      return null;
    }
    if (plan.status === "error") {
      throw new StructuredBuildError(
        plan.error || "Move.lock V4 fetch plan failed",
        plan.code
      );
    }
    if (plan.status !== "ok" || !plan.packages) {
      throw new Error("Move.lock V4 fetch plan did not include packages");
    }

    const packagesWithFiles: LockfileV4PlanPackage[] = [];

    for (const packagePlan of plan.packages) {
      let files: Record<string, string>;
      if (packagePlan.source.type === "root") {
        files = rootFiles;
      } else {
        const source = this.lockfileV4SourceToDependencySource(
          packagePlan.source,
          packagePlan.id
        );
        files = await this.fetchFromSource(
          source,
          packagePlan.id,
          rootPackageName,
          this.rootSource || { type: "local" }
        );
      }

      packagesWithFiles.push({
        ...packagePlan,
        files,
      });
    }

    const validationInput = {
      environment: this.network,
      rootPackageName,
      rootMoveToml: rootFiles["Move.toml"] || "",
      modes: this.modes,
      packages: packagesWithFiles,
    };
    const resolved =
      this.parseLockfileV4Response<LockfileV4ResolvePackageGroupsResponse>(
        this.lockfileV4Helpers.resolvePackageGroups(
          JSON.stringify(validationInput)
        ),
        "package-group resolution"
      );

    if (resolved.status === "out_of_date") {
      return null;
    }
    if (resolved.status === "error") {
      throw new StructuredBuildError(
        resolved.error || "Move.lock V4 package-group resolution failed",
        resolved.code
      );
    }
    if (
      resolved.status !== "ok" ||
      !resolved.rootFiles ||
      !resolved.dependencies ||
      !resolved.lockfileDependencies
    ) {
      throw new Error(
        "Move.lock V4 package-group resolution did not include package groups"
      );
    }

    return {
      files: JSON.stringify(resolved.rootFiles),
      dependencies: JSON.stringify(resolved.dependencies),
      lockfileDependencies: JSON.stringify(resolved.lockfileDependencies),
    };
  }

  /**
   * Fetch files from a dependency source
   */
  private async fetchFromSource(
    source: DependencySource,
    dependencyName: string,
    parentPackageName: string,
    parentSource: DependencySource
  ): Promise<Record<string, string>> {
    if (source.type === "git" && source.git && source.rev) {
      const files = await this.fetcher.fetch(
        source.git,
        source.rev,
        source.subdir
      );
      if (Object.keys(files).length === 0) {
        throw new Error(
          `Dependency '${dependencyName}' from ${this.describeSource(source)} returned no files`
        );
      }
      return files;
    }
    if (source.type === "local" && source.local) {
      return this.fetchLocalPackage(
        source.local,
        dependencyName,
        parentPackageName,
        parentSource
      );
    }
    throw new Error(
      `Dependency '${dependencyName}' has unsupported source ${this.describeSource(source)}`
    );
  }
}

/**
 * Main resolve function (backward compatible)
 */
export async function resolve(
  rootMoveTomlContent: string,
  rootSourceFiles: Record<string, string>,
  fetcher: MovePackageFetcher,
  network: "mainnet" | "testnet" | "devnet" = "mainnet",
  rootSource?: DependencySource,
  lockfileV4Helpers?: LockfileV4Helpers,
  modes: string[] = []
): Promise<{
  files: string;
  dependencies: string;
  lockfileDependencies: string;
}> {
  const resolver = new Resolver(
    fetcher,
    network,
    rootSource || null,
    lockfileV4Helpers,
    modes
  );
  return resolver.resolve(rootMoveTomlContent, rootSourceFiles);
}
