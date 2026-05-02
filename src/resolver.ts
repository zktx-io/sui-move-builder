/**
 * Resolver for host-side package loading.
 *
 * TypeScript owns fetch/fetchLocal and snapshot assembly. Rust/WASM owns
 * manifest/lockfile package-group construction for compiler input.
 */

import { parseToml } from "./tomlParser.js";
import type { Fetcher, FetchLocalContext } from "./fetcher.js";
import {
  DependencyGraph,
  Package,
  PackageIdentifier,
  Dependency,
  PackageManifest,
  DependencySource,
  LockfileDependencyInfo,
  SubstOrRename,
} from "./dependencyGraph.js";

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

/**
 * Standard Zero Address (0x0...0)
 */
const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface LockfileV4Helpers {
  fetchPlan: (moveLockToml: string, environment: string) => string;
  resolvePackageGroups: (inputJson: string) => string;
  manifestPackagePlan?: (inputJson: string) => string;
  manifestResolvePackageGroups?: (inputJson: string) => string;
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
  reason?: string;
  rootId?: string;
  lockfileOrder?: string[];
  packages?: LockfileV4PlanPackage[];
}

interface LockfileV4ResolvePackageGroupsResponse {
  status: "ok" | "out_of_date" | "error";
  error?: string;
  reason?: string;
  packageId?: string;
  rootFiles?: Record<string, string>;
  dependencies?: unknown[];
  lockfileDependencies?: unknown[];
}

interface ManifestResolvePackageGroupsResponse {
  status: "ok" | "error";
  error?: string;
  rootFiles?: Record<string, string>;
  dependencies?: unknown[];
  lockfileDependencies?: unknown[];
}

interface ManifestGraphPackageGroupsResponse {
  status: "needFetch" | "ok" | "error";
  error?: string;
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

interface ManifestPackagePlanDependency {
  name: string;
  source: DependencySource;
  subst?: Record<string, SubstOrRename>;
}

interface ManifestPackagePlanResponse {
  status: "ok" | "error";
  error?: string;
  package?: {
    source: LockfileV4PlanSource;
    manifest: PackageManifest;
  };
  dependencies?: ManifestPackagePlanDependency[];
}

export class Resolver {
  private fetcher: Fetcher;
  private network: "mainnet" | "testnet" | "devnet";
  private rootSource: DependencySource | null;

  // Track visited dependencies by git source to avoid duplicates
  private visited: Set<string> = new Set();

  // CLI compat: suffix counter for create_ids logic
  // ORIGINAL: builder.rs:232-265 - adds suffix to packages with same name (MoveStdlib, MoveStdlib_1, ...)
  // Maps package name -> suffix counter (0 = no suffix, 1 = _1, etc.)
  private packageNameToSuffix: Map<string, number> = new Map();

  // Track which Sui framework revision each git repo+rev combo uses.
  // Sibling packages from the same repository must share the same framework instance.
  // Key: "git|rev" (excluding subdir), Value: resolved Sui framework revision
  private repoRevToSuiRev: Map<string, string> = new Map();

  // Cache for resolved Sui framework tag→SHA mappings
  // Ensures same tag (e.g., "framework/mainnet") always resolves to same SHA within a build
  // Key: "git|tag|subdir", Value: resolved SHA
  private suiTagToShaCache: Map<string, string> = new Map();

  // Store fetched package files: packageName -> files
  private packageFiles: Map<string, Record<string, string>> = new Map();

  private lockfileVersion: number | undefined;

  private lockfileV4Helpers: LockfileV4Helpers | undefined;

  constructor(
    fetcher: Fetcher,
    network: "mainnet" | "testnet" | "devnet" = "mainnet",
    rootSource: DependencySource | null = null,
    lockfileV4Helpers?: LockfileV4Helpers
  ) {
    this.fetcher = fetcher;
    this.network = network;
    this.rootSource = rootSource;
    this.lockfileV4Helpers = lockfileV4Helpers;
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

    const lockfileVersion = rootFiles["Move.lock"]
      ? (parseToml(rootFiles["Move.lock"]) as any).move?.version
      : undefined;
    this.lockfileVersion = lockfileVersion;

    if (lockfileVersion === undefined || lockfileVersion >= 3) {
      return this.resolveManifestGraphPackageGroups(rootFiles);
    }

    const depGraph = new DependencyGraph(rootPackageName);

    // Build root package (isRoot: true enables implicit dependency injection)
    const rootPackage = await this.buildPackage(
      rootPackageName,
      this.rootSource,
      selectedRootMoveToml,
      rootFiles,
      true // isRoot - inject implicit dependencies for root only
    );

    // Sui CLI behavior: If root package address is 0x0 and original-published-id exists,
    // replace the 0x0 address with original-published-id in the addresses table
    const rootAddr = rootPackage.manifest.addresses[rootPackageName];
    const normalizedRootAddr = this.normalizeAddress(rootAddr || "");
    if (normalizedRootAddr === ZERO_ADDRESS) {
      if (rootPackage.manifest.originalId) {
        rootPackage.manifest.addresses[rootPackageName] = this.normalizeAddress(
          rootPackage.manifest.originalId
        );
      }
    }

    depGraph.addPackage(rootPackage);
    this.packageFiles.set(rootPackageName, rootFiles);

    // ORIGINAL: graph/mod.rs:61-76 - PackageGraph::load()
    // CLI behavior: If lockfile load succeeds, use it directly.
    // Only fall back to manifests if lockfile is missing or invalid.
    // CLI does NOT check missingDeps - lockfile is the single source of truth.
    const loadedFromLockfile = await this.loadFromLockfile(
      depGraph,
      rootPackage,
      rootFiles
    );

    if (!loadedFromLockfile) {
      // Fallback: Recursively resolve all dependencies from manifests
      // ORIGINAL: graph/mod.rs:73-74 - "lockfile was missing or out of date; loading from manifests"
      await this.buildDependencyGraph(depGraph, rootPackage);
    }

    // Check for cycles
    const cycle = depGraph.detectCycle();
    if (cycle) {
      throw new Error(`Dependency cycle detected: ${cycle.join(" → ")}`);
    }

    return this.resolveManifestPackageGroups(depGraph, rootPackage, rootFiles);
  }

  private parseManifestPackageGroupsResponse(
    raw: string
  ): ManifestResolvePackageGroupsResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Rust manifest package-group resolution returned invalid JSON: ${
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
        "Rust manifest package-group resolution returned an invalid response shape"
      );
    }

    return parsed as ManifestResolvePackageGroupsResponse;
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

  private parseManifestPackagePlanResponse(
    raw: string
  ): ManifestPackagePlanResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Rust manifest package plan returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { status?: unknown }).status !== "string"
    ) {
      throw new Error("Rust manifest package plan returned an invalid shape");
    }

    return parsed as ManifestPackagePlanResponse;
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

  private async resolveManifestPackageGroups(
    depGraph: DependencyGraph,
    rootPackage: Package,
    rootFiles: Record<string, string>
  ): Promise<{
    files: string;
    dependencies: string;
    lockfileDependencies: string;
  }> {
    if (!this.lockfileV4Helpers?.manifestResolvePackageGroups) {
      throw new Error(
        "Rust manifest_resolve_package_groups helper is required"
      );
    }

    const compilerOrder = depGraph.compilerInputOrderWithIndices();
    const lockfileOrder = depGraph.allPackagesOrderWithIndices();
    const packages = [];

    for (let i = 0; i < lockfileOrder.indices.length; i++) {
      const packageIndex = lockfileOrder.indices[i];
      const packageId = lockfileOrder.ids[i];
      const pkg = depGraph.getPackageByIndex(packageIndex);
      if (!pkg || !packageId || pkg.id.name === rootPackage.id.name) {
        continue;
      }

      const files =
        this.packageFiles.get(packageId) ||
        this.packageFiles.get(pkg.id.name) ||
        this.packageFiles.get(pkg.manifest.name) ||
        {};
      if (Object.keys(files).length === 0) {
        throw new Error(`Manifest package '${packageId}' has no files`);
      }

      packages.push({
        id: packageId,
        source: this.dependencySourceToRustSource(pkg.id.source, packageId),
        files,
        depAliasToPackageName: pkg.depAliasToPackageName || {},
      });
    }

    const resolved = this.parseManifestPackageGroupsResponse(
      this.lockfileV4Helpers.manifestResolvePackageGroups(
        JSON.stringify({
          environment: this.network,
          rootPackageName: rootPackage.manifest.name,
          rootFiles,
          packages,
          compilerOrder: compilerOrder.ids,
          lockfileOrder: lockfileOrder.ids,
          rootDepAliasToPackageName: rootPackage.depAliasToPackageName || {},
        })
      )
    );

    if (resolved.status !== "ok") {
      throw new Error(
        resolved.error || "Manifest package-group resolution failed"
      );
    }
    if (
      !resolved.rootFiles ||
      !resolved.dependencies ||
      !resolved.lockfileDependencies
    ) {
      throw new Error(
        "Manifest package-group resolution did not include package groups"
      );
    }

    return {
      files: JSON.stringify(resolved.rootFiles),
      dependencies: JSON.stringify(resolved.dependencies),
      lockfileDependencies: JSON.stringify(resolved.lockfileDependencies),
    };
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
        throw new Error(resolved.error || "Manifest graph resolution failed");
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

  /**
   * Build a package from a host-provided file snapshot.
   */
  private async buildPackage(
    name: string,
    source: DependencySource | null,
    _moveTomlContent: string,
    files: Record<string, string>,
    isRoot: boolean = false
  ): Promise<Package> {
    if (!this.lockfileV4Helpers?.manifestPackagePlan) {
      throw new Error("Rust manifest_package_plan helper is required");
    }

    const planned = this.parseManifestPackagePlanResponse(
      this.lockfileV4Helpers.manifestPackagePlan(
        JSON.stringify({
          environment: this.network,
          packageIdHint: name,
          source: this.packageSourceToRustSource(source, name),
          files,
          isRoot,
          frameworkRev: WASM_BUILD_FRAMEWORK_REV,
        })
      )
    );

    if (planned.status !== "ok") {
      throw new Error(planned.error || "Rust manifest package plan failed");
    }
    if (!planned.package) {
      throw new Error("Rust manifest package plan did not include a package");
    }

    const manifest = planned.package.manifest;
    const dependencies = new Map<string, Dependency>();
    for (const dep of planned.dependencies || []) {
      dependencies.set(dep.name, {
        source: this.manifestPlanSourceToDependencySource(dep.source, dep.name),
        subst: dep.subst,
      });
    }

    const id: PackageIdentifier = {
      name: manifest.name,
      version: manifest.version,
      source: source || { type: "local" },
    };

    return {
      id,
      manifest,
      dependencies,
      devDependencies: new Map(),
    };
  }

  private manifestPlanSourceToDependencySource(
    source: DependencySource,
    dependencyName: string
  ): DependencySource {
    if (source.type === "git") {
      if (!source.git || !source.rev) {
        throw new Error(
          `Manifest dependency '${dependencyName}' has invalid git source`
        );
      }
      return {
        type: "git",
        git: source.git,
        rev: source.rev,
        subdir: source.subdir,
        isImplicit: source.isImplicit,
      };
    }
    if (source.type === "local") {
      if (!source.local) {
        throw new Error(
          `Manifest dependency '${dependencyName}' has invalid local source`
        );
      }
      return {
        type: "local",
        local: source.local,
      };
    }
    throw new Error(
      `Manifest dependency '${dependencyName}' has unsupported source ${this.describeSource(source)}`
    );
  }

  /**
   * Recursively build the dependency graph
   */
  private async buildDependencyGraph(
    graph: DependencyGraph,
    pkg: Package
  ): Promise<void> {
    // Sort dependencies to match CLI's BTreeMap iteration order:
    // 1. Alphabetical by name (BTreeMap's natural ASCII ordering)
    // 2. Implicit deps processed first (System packages take priority)
    // ORIGINAL: builder.rs uses BTreeMap which provides lexicographic ASCII ordering
    const sortedDeps = Array.from(pkg.dependencies.entries()).sort(
      ([nameA, depA], [nameB, depB]) => {
        // First: Implicit deps come first (descending)
        const isImplicitA = depA.source.isImplicit ? 1 : 0;
        const isImplicitB = depB.source.isImplicit ? 1 : 0;
        if (isImplicitA !== isImplicitB) {
          return isImplicitB - isImplicitA;
        }
        // Second: ASCII order (CLI's BTreeMap behavior, not localeCompare)
        // ASCII: 'P' (80) < 'd' (100) < 'm' (109)
        return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
      }
    );

    for (const [depName, dep] of sortedDeps) {
      let files: Record<string, string>;

      if (dep.source.type !== "git" && dep.source.type !== "local") {
        throw new Error(
          `Dependency '${depName}' has unsupported source ${this.describeSource(dep.source)}`
        );
      }

      // CLI behavior: local deps from same git repo share parent's framework version
      // Override Sui rev BEFORE cacheKey generation so sibling packages hit same visited entry
      // ORIGINAL: pin.rs:283-285 - local dep inherits parent's git tree including rev
      if (
        dep.source.type === "git" &&
        dep.source.git &&
        this.isSuiRepo(dep.source.git)
      ) {
        // Infer subdir for Sui framework packages
        if (!dep.source.subdir) {
          const inferredSubdir = this.inferSuiFrameworkSubdir(depName);
          if (inferredSubdir) {
            dep.source.subdir = inferredSubdir;
          }
        }

        // If parent package came from a git repo, check if sibling already resolved Sui
        const parentRepoKey =
          pkg.id.source.type === "git"
            ? `${pkg.id.source.git}|${pkg.id.source.rev}`
            : null;
        if (parentRepoKey) {
          const cachedSuiRev = this.repoRevToSuiRev.get(parentRepoKey);
          if (cachedSuiRev && dep.source.rev !== cachedSuiRev) {
            // Reuse the framework revision already selected for this repository.
            dep.source.rev = cachedSuiRev;
          }
        }

        // Pre-resolve Sui tags to SHA for consistent cacheKey generation.
        // Sibling dependency aliases must resolve to the same fetched package key.
        const suiTagKey = `${dep.source.git}|${dep.source.rev}|${dep.source.subdir || ""}`;
        const cachedSha = this.suiTagToShaCache.get(suiTagKey);
        if (cachedSha) {
          // Use cached SHA from previous resolution
          dep.source.rev = cachedSha;
        } else {
          // Pre-fetch to resolve tag/branch to SHA
          // This is necessary because cacheKey must use resolved SHA, not tag
          await this.fetcher.fetch(
            dep.source.git!,
            dep.source.rev!,
            dep.source.subdir
          );
          const resolvedSha = this.fetcher.getResolvedSha(
            dep.source.git!,
            dep.source.rev!
          );
          if (resolvedSha && resolvedSha !== dep.source.rev) {
            this.suiTagToShaCache.set(suiTagKey, resolvedSha);
            dep.source.rev = resolvedSha;
          }
        }
      }

      const cacheKey = this.dependencySourceKey(dep.source);

      if (this.visited.has(cacheKey)) {
        // ORIGINAL: builder.rs:330 - graph.add_edge(index, dep_index, dep.clone())
        this.addExistingDependencyEdge(graph, pkg, depName, dep);
        continue;
      }

      this.visited.add(cacheKey);

      if (dep.source.type === "git") {
        const subdir = dep.source.subdir;
        files = await this.fetcher.fetch(
          dep.source.git!,
          dep.source.rev!,
          subdir
        );
        if (Object.keys(files).length === 0) {
          throw new Error(
            `Dependency '${depName}' from ${this.describeSource(dep.source)} returned no files`
          );
        }

        // Update rev with resolved commit SHA (resolves tags/branches to actual SHA)
        const resolvedSha = this.fetcher.getResolvedSha(
          dep.source.git!,
          dep.source.rev!
        );
        if (resolvedSha) {
          dep.source.rev = resolvedSha;
        }

        // Store Sui framework revision for sibling packages from same git repo
        // ORIGINAL: CLI's visited map shares nodes for same fetched path
        if (dep.source.git && this.isSuiRepo(dep.source.git)) {
          const parentRepoKey =
            pkg.id.source.type === "git"
              ? `${pkg.id.source.git}|${pkg.id.source.rev}`
              : null;
          if (parentRepoKey && dep.source.rev) {
            if (!this.repoRevToSuiRev.has(parentRepoKey)) {
              this.repoRevToSuiRev.set(parentRepoKey, dep.source.rev);
            }
          }
        }
      } else {
        files = await this.fetchLocalPackage(dep.source.local!, depName, pkg);
      }

      const moveTomlContent = this.findMoveTomlForPackage(
        files,
        depName,
        dep.source
      );

      // Build package
      const depPackage = await this.buildPackage(
        depName,
        dep.source,
        moveTomlContent,
        files
      );

      // CLI compat: create_ids logic - add suffix to packages with same name
      // ORIGINAL: builder.rs:232-265 - diamond dependency support
      // CLI treats packages with same name but different sources as separate nodes
      // and records them in lockfile as MoveStdlib, MoveStdlib_1, MoveStdlib_2
      const pkgBaseName = depPackage.manifest.name;
      const suffix = this.packageNameToSuffix.get(pkgBaseName) ?? 0;

      // Generate unique ID: first uses original name, subsequent uses _1, _2 suffix
      const pkgId = suffix === 0 ? pkgBaseName : `${pkgBaseName}_${suffix}`;
      this.packageNameToSuffix.set(pkgBaseName, suffix + 1);

      // Update package ID (used as unique identifier in graph)
      depPackage.id.name = pkgId;

      // Use edition only from Move.toml (Move.lock editions are unreliable)
      // If Move.toml doesn't specify edition, default to 'legacy' for safety
      //
      // ORIGINAL SOURCE REFERENCE:
      // - move-package-alt-compilation/src/compilation.rs:385
      //   falls back to Edition::LEGACY when the manifest omits edition.
      // - move-package/src/resolution/resolution_graph.rs:661 (same pattern)
      if (!depPackage.manifest.edition) {
        depPackage.manifest.edition = "legacy";
      }

      // Add to graph
      graph.addPackage(depPackage);
      graph.addDependency(pkg.id.name, depPackage.id.name, dep);

      // Track alias -> package name mapping for Move.lock generation
      // ORIGINAL: to_lockfile.rs:27-35 - deps = { alias = "PackageID" }
      if (!pkg.depAliasToPackageName) {
        pkg.depAliasToPackageName = {};
      }
      pkg.depAliasToPackageName[depName] = depPackage.id.name;

      // ORIGINAL: builder.rs:330 - edge stores PinnedDependencyInfo with original source
      // Store original source info for diamond dependency lockfile generation
      if (!pkg.depAliasToSource) {
        pkg.depAliasToSource = {};
      }
      pkg.depAliasToSource[depName] = {
        name: depPackage.id.name,
        type: dep.source.type,
        git: dep.source.git,
        rev: dep.source.rev,
        subdir: dep.source.subdir,
      };

      // Use source files directly - compiler needs source, not bytecode
      this.packageFiles.set(depPackage.id.name, files);

      // Recursively resolve this package's dependencies
      await this.buildDependencyGraph(graph, depPackage);
    }
  }

  /**
   * Find a package in the graph by its source
   */
  private findPackageBySource(
    graph: DependencyGraph,
    source: DependencySource
  ): Package | undefined {
    for (const pkg of graph.getAllPackages()) {
      const pkgSource = pkg.id.source;
      if (
        pkgSource.type === source.type &&
        pkgSource.git === source.git &&
        pkgSource.rev === source.rev &&
        pkgSource.subdir === source.subdir &&
        pkgSource.local === source.local
      ) {
        return pkg;
      }
    }
    return undefined;
  }

  /**
   * Resolve relative path for local dependencies
   * Example: parentSubdir="packages/a", localPath="../b" -> "packages/b"
   */
  private resolveRelativePath(parentSubdir: string, localPath: string): string {
    // Split paths into parts
    const parentParts = parentSubdir
      ? parentSubdir.split("/").filter(Boolean)
      : [];
    const localParts = localPath.split("/").filter(Boolean);

    // Start with parent's directory
    const resultParts = [...parentParts];

    // Process each part of the local path
    for (const part of localParts) {
      if (part === "..") {
        // Go up one directory
        if (resultParts.length > 0) {
          resultParts.pop();
        }
      } else if (part !== ".") {
        // Add directory (skip '.')
        resultParts.push(part);
      }
    }

    return resultParts.join("/");
  }

  private dependencySourceKey(source: DependencySource): string {
    if (source.type === "git") {
      return `git|${source.git}|${source.rev}|${source.subdir || ""}`;
    }
    if (source.type === "local") {
      return `local|${source.local || ""}`;
    }
    return `${source.type}`;
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

  private findMoveTomlForPackage(
    files: Record<string, string>,
    packageName: string,
    source: DependencySource
  ): string {
    const networkTomlName = `Move.${this.network}.toml`;
    const networkMoveToml = Object.entries(files).find(([path]) =>
      path.endsWith(networkTomlName)
    );
    const moveToml = networkMoveToml?.[1] ?? files["Move.toml"];

    if (!moveToml) {
      throw new Error(
        `Dependency '${packageName}' from ${this.describeSource(source)} did not provide Move.toml`
      );
    }
    return moveToml;
  }

  private async fetchLocalPackage(
    localPath: string,
    dependencyName: string,
    parentPackage: Package
  ): Promise<Record<string, string>> {
    if (typeof this.fetcher.fetchLocal !== "function") {
      throw new Error(
        `Local dependency '${dependencyName}' at '${localPath}' requires fetcher.fetchLocal(localPath, context)`
      );
    }

    const context: FetchLocalContext = {
      dependencyName,
      parentPackageName: parentPackage.manifest.name,
      parentSource: parentPackage.id.source,
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

  private addExistingDependencyEdge(
    graph: DependencyGraph,
    pkg: Package,
    depName: string,
    dep: Dependency
  ): boolean {
    const existingPkg = this.findPackageBySource(graph, dep.source);
    if (!existingPkg) {
      return false;
    }

    graph.addDependency(pkg.id.name, existingPkg.id.name, dep);

    // ORIGINAL: to_lockfile.rs:27-35 - deps = { alias = "PackageID" }
    if (!pkg.depAliasToPackageName) {
      pkg.depAliasToPackageName = {};
    }
    pkg.depAliasToPackageName[depName] = existingPkg.id.name;

    // ORIGINAL: builder.rs:286 - visited key includes PackagePath.
    if (!pkg.depAliasToSource) {
      pkg.depAliasToSource = {};
    }
    pkg.depAliasToSource[depName] = {
      name: existingPkg.id.name,
      type: dep.source.type,
      git: dep.source.git,
      rev: dep.source.rev,
      subdir: dep.source.subdir,
      local: dep.source.local,
    };
    return true;
  }

  /**
   * Load dependency graph from lockfile (Sui CLI: load_from_lockfile)
   * Returns null if lockfile is missing or invalid
   */
  private async loadFromLockfile(
    graph: DependencyGraph,
    rootPackage: Package,
    rootFiles: Record<string, string>
  ): Promise<boolean> {
    const moveLockContent = rootFiles["Move.lock"];
    if (!moveLockContent) {
      return false;
    }

    const lockfile = parseToml(moveLockContent) as any;
    this.lockfileVersion = lockfile.move?.version;

    // Support both version 3 ([[move.package]]) and version 4 (pinned) formats
    const lockfileVersion = lockfile.move?.version;
    if (lockfileVersion === 3) {
      // ORIGINAL: schema/lockfile.rs:21 - V3 lockfile has no `pinned` section
      // ORIGINAL: lockfile.rs:35-37 - pins_for_env(env) returns None for V3
      // ORIGINAL: mod.rs:69-75 - None means re-resolve from manifests
      // CLI behavior: V3 lockfile is ignored, dependencies are re-resolved from Move.toml
      return false; // fallback to buildDependencyGraph (re-resolve from manifests)
    } else if (lockfileVersion && lockfileVersion >= 4) {
      // V4 pins are handled by resolveFromLockfileV4 before the JS graph path.
      // If that path returns here, the lockfile was missing, out of date, or unusable.
      return false;
    } else {
      // Legacy versions (v0/v1/v2) - best-effort support following CLI layout
      return await this.loadFromLockfileV0(graph, lockfile, rootPackage);
    }
  }

  /**
   * Load from Move.lock legacy formats (v0/v1/v2)
   * These formats use [[move.package]] and move.dependencies without versioned schema.
   */
  private async loadFromLockfileV0(
    graph: DependencyGraph,
    lockfile: any,
    rootPackage: Package
  ): Promise<boolean> {
    const packages = lockfile.move?.package;
    if (!packages || !Array.isArray(packages)) {
      return false;
    }

    // Lockfile order: use move.dependencies if present, otherwise package listing order
    const depsArray = Array.isArray(lockfile.move?.dependencies)
      ? lockfile.move.dependencies
          .map((d: any) => d.name || d.id || d)
          .filter(Boolean)
      : [];
    const pkgArray = packages.map((p: any) => p.name || p.id).filter(Boolean);
    const lockfileOrder = [
      ...depsArray,
      ...pkgArray.filter((p: string) => !depsArray.includes(p)),
    ];

    const packageById = new Map<string, Package>();
    const packageByName = new Map<string, Package>();

    // First pass: fetch and build packages
    for (const pkgInfo of packages) {
      const pkgId = pkgInfo.id || pkgInfo.name;
      const source = pkgInfo.source;
      if (!pkgId || !source) {
        continue;
      }

      let depSource: DependencySource | null = null;
      if (source.git && source.rev) {
        depSource = {
          type: "git",
          git: source.git,
          rev: source.rev,
          subdir: source.subdir,
        };
      } else if (source.local && this.rootSource?.type === "git") {
        const resolvedSubdir = this.resolveRelativePath(
          this.rootSource.subdir || "",
          source.local
        );
        depSource = {
          type: "git",
          git: this.rootSource.git!,
          rev: this.rootSource.rev!,
          subdir: resolvedSubdir,
        };
      } else {
        continue;
      }

      const files = await this.fetcher.fetch(
        depSource.git!,
        depSource.rev!,
        depSource.subdir
      );
      if (Object.keys(files).length === 0) continue;

      // ORIGINAL: pin.rs:61-63 (docstring) - "revisions for git dependencies are replaced with 40-character shas"
      // ORIGINAL: pin.rs:254-262 - ManifestGitDependency.pin() calls cache.resolve_to_tree() to convert rev to SHA
      // This ensures lockfile generation uses SHA, not tags/branches
      const resolvedSha = this.fetcher.getResolvedSha(
        depSource.git!,
        depSource.rev!
      );
      if (resolvedSha) {
        depSource.rev = resolvedSha;
      }

      const moveToml = files["Move.toml"];
      if (!moveToml) continue;

      const pkg = await this.buildPackage(pkgId, depSource, moveToml, files);
      packageById.set(pkgId, pkg);
      packageByName.set(pkg.manifest.name, pkg);
      this.packageFiles.set(pkg.manifest.name, files);
      graph.addPackage(pkg);
    }

    if (lockfileOrder.length) {
      graph.setLockfileOrder(lockfileOrder);
    }

    // Second pass: add edges based on lockfile dependencies inside each package
    for (const pkgInfo of packages) {
      const pkgId = pkgInfo.id || pkgInfo.name;
      const pkg = packageById.get(pkgId);
      if (!pkg) continue;

      const deps = pkgInfo.dependencies;
      if (deps && Array.isArray(deps)) {
        for (const depInfo of deps) {
          const depId = depInfo.id || depInfo.name;
          const depPkg =
            packageById.get(depId) || packageByName.get(depId as string);
          if (depPkg) {
            const dep: Dependency = { source: depPkg.id.source };
            graph.addDependency(pkg.id.name, depPkg.id.name, dep);

            // ORIGINAL: dependency_graph.rs:1284-1289 - lockfile deps come from package_graph.edges()
            // Preserve lockfile dependency aliases for package-group construction.
            if (!pkg.depAliasToPackageName) {
              pkg.depAliasToPackageName = {};
            }
            const depAlias = depInfo.name || depId;
            pkg.depAliasToPackageName[depAlias] = depPkg.id.name;
          }
        }
      }
    }

    // Root dependency edges and aliases must also reach package-group construction.
    for (const depName of rootPackage.dependencies.keys()) {
      const depPkg = packageByName.get(depName);
      if (depPkg) {
        const dep = rootPackage.dependencies.get(depName)!;
        graph.addDependency(rootPackage.id.name, depPkg.id.name, dep);
        if (!rootPackage.depAliasToPackageName) {
          rootPackage.depAliasToPackageName = {};
        }
        rootPackage.depAliasToPackageName[depName] = depPkg.id.name;
        if (!rootPackage.depAliasToSource) {
          rootPackage.depAliasToSource = {};
        }
        rootPackage.depAliasToSource[depName] = {
          name: depPkg.id.name,
          type: dep.source.type,
          git: dep.source.git,
          rev: dep.source.rev,
          subdir: dep.source.subdir,
          local: dep.source.local,
        };
      }
    }

    return packageById.size > 0;
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
      throw new Error(plan.error || "Move.lock V4 fetch plan failed");
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
        files = await this.fetchFromSource(source, packagePlan.id, {
          id: {
            name: rootPackageName,
            version: "0.0.0",
            source: this.rootSource || { type: "local" },
          },
          manifest: {
            name: rootPackageName,
            version: "0.0.0",
            addresses: {},
            dependencies: {},
          },
          dependencies: new Map(),
          devDependencies: new Map(),
        });
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
      throw new Error(
        resolved.error || "Move.lock V4 package-group resolution failed"
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
   * Convert lockfile dependency source to our DependencySource format
   */
  private lockfileSourceToDependencySource(
    source: LockfileDependencyInfo
  ): DependencySource | null {
    if ("git" in source) {
      return {
        type: "git",
        git: source.git,
        rev: source.rev,
        subdir: source.subdir,
      };
    }
    if ("local" in source) {
      return {
        type: "local",
        local: source.local,
      };
    }
    if ("root" in source) {
      return {
        type: "local",
      };
    }
    return null;
  }

  /**
   * Fetch files from a dependency source
   */
  private async fetchFromSource(
    source: DependencySource,
    dependencyName: string,
    parentPackage: Package
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
        parentPackage
      );
    }
    throw new Error(
      `Dependency '${dependencyName}' has unsupported source ${this.describeSource(source)}`
    );
  }

  /**
   * Normalize address to 0x-prefixed 64-char hex
   *
   * ORIGINAL SOURCE REFERENCE: move-core-types/src/account_address.rs
   *
   * Input handling (from_hex_literal, line 110-128):
   * - Accepts "0x" prefixed hex strings (e.g., "0x1", "0x2")
   * - Accepts raw hex strings (e.g., "0000...0001")
   * - Short addresses are LEFT-PADDED with zeros to 64 chars
   *
   * Output format (to_canonical_string, line 67-69):
   * - with_prefix=true → "0x" + 64 lowercase hex chars
   * - with_prefix=false → 64 lowercase hex chars (no prefix)
   * - Always exactly 64 hex characters (32 bytes)
   *
   * Example: "0x1" → "0x0000000000000000000000000000000000000000000000000000000000000001"
   */
  private normalizeAddress(addr: string): string {
    if (!addr) return addr;
    let clean = addr.trim();
    if (clean.startsWith("0x")) clean = clean.slice(2);

    // Only process valid hex strings; return as-is for named addresses
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
      return addr;
    }

    // Left-pad with zeros and add 0x prefix (matches to_canonical_string)
    return "0x" + clean.toLowerCase().padStart(64, "0");
  }

  /**
   * Check if git URL is Sui repository
   */
  private isSuiRepo(gitUrl: string): boolean {
    return gitUrl.includes("github.com/MystenLabs/sui");
  }

  /**
   * Infer subdir for Sui framework packages
   */
  private inferSuiFrameworkSubdir(packageName: string): string | undefined {
    const suiPackageMap: Record<string, string> = {
      Sui: "crates/sui-framework/packages/sui-framework",
      MoveStdlib: "crates/sui-framework/packages/move-stdlib",
      SuiSystem: "crates/sui-framework/packages/sui-system",
      Bridge: "crates/sui-framework/packages/bridge",
      SuiFramework: "crates/sui-framework/packages/sui-framework",
    };

    return (
      suiPackageMap[packageName] || suiPackageMap[packageName.toLowerCase()]
    );
  }
}

/**
 * Main resolve function (backward compatible)
 */
export async function resolve(
  rootMoveTomlContent: string,
  rootSourceFiles: Record<string, string>,
  fetcher: Fetcher,
  network: "mainnet" | "testnet" | "devnet" = "mainnet",
  rootSource?: DependencySource,
  lockfileV4Helpers?: LockfileV4Helpers
): Promise<{
  files: string;
  dependencies: string;
  lockfileDependencies: string;
}> {
  const resolver = new Resolver(
    fetcher,
    network,
    rootSource || null,
    lockfileV4Helpers
  );
  return resolver.resolve(rootMoveTomlContent, rootSourceFiles);
}
