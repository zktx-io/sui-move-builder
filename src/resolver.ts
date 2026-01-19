/**
 * New Resolver using 3-layer architecture matching Sui CLI
 *
 * Layer 1: DependencyGraph - Build DAG of packages
 * Layer 2: ResolvedGraph - Unified address resolution
 * Layer 3: CompilationDependencies - Compiler-ready format
 */

import { parseToml } from "./tomlParser.js";
import type { Fetcher } from "./fetcher.js";
import {
  DependencyGraph,
  Package,
  PackageIdentifier,
  Dependency,
  PackageManifest,
  DependencySource,
  LockfileDependencyInfo,
} from "./dependencyGraph.js";
import { ResolvedGraph } from "./resolvedGraph.js";
import { CompilationDependencies } from "./compilationDependencies.js";

export class Resolver {
  private fetcher: Fetcher;
  private network: "mainnet" | "testnet" | "devnet";
  private rootSource: DependencySource | null;

  // Track visited dependencies by git source to avoid duplicates
  private visited: Set<string> = new Set();

  // Track visited package names to handle version conflicts
  // Maps package name -> first seen source
  private packageNameCache: Map<string, DependencySource> = new Map();

  // Store fetched package files: packageName -> files
  private packageFiles: Map<string, Record<string, string>> = new Map();

  private lockfileVersion: number | undefined;

  constructor(
    fetcher: Fetcher,
    network: "mainnet" | "testnet" | "devnet" = "mainnet",
    rootSource: DependencySource | null = null
  ) {
    this.fetcher = fetcher;
    this.network = network;
    this.rootSource = rootSource;
  }

  /**
   * Main resolve function using 3-layer architecture
   */
  async resolve(
    rootMoveToml: string,
    rootFiles: Record<string, string>
  ): Promise<{ files: string; dependencies: string }> {
    // Parse root Move.toml
    const rootParsed = parseToml(rootMoveToml);
    const rootPackageName = rootParsed.package?.name || "RootPackage";

    // Extract edition from root Move.lock if available
    const rootEdition: string | undefined = rootParsed.package?.edition;

    // === LAYER 1: Build DependencyGraph ===
    const depGraph = new DependencyGraph(rootPackageName);

    // Build root package
    const rootPackage = await this.buildPackage(
      rootPackageName,
      this.rootSource,
      rootMoveToml,
      rootFiles
    );

    // Update root package edition from Move.lock
    if (rootEdition) {
      rootPackage.manifest.edition = rootEdition;
    }

    // Sui CLI behavior: If root package address is 0x0 and original-published-id exists,
    // replace the 0x0 address with original-published-id in the addresses table
    const rootAddr = rootPackage.manifest.addresses[rootPackageName];
    const normalizedRootAddr = this.normalizeAddress(rootAddr || "");
    if (
      normalizedRootAddr ===
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      if (rootPackage.manifest.originalId) {
        rootPackage.manifest.addresses[rootPackageName] = this.normalizeAddress(
          rootPackage.manifest.originalId
        );
      }
    }

    depGraph.addPackage(rootPackage);
    this.packageFiles.set(rootPackageName, rootFiles);

    // Try to load from lockfile first (Sui CLI behavior)
    const loadedFromLockfile = await this.loadFromLockfile(
      depGraph,
      rootPackage,
      rootFiles
    );

    const missingDeps = Array.from(rootPackage.dependencies.keys()).filter(
      (name) => !depGraph.getPackage(name)
    );

    if (!loadedFromLockfile || missingDeps.length > 0) {
      // Fallback: Recursively resolve all dependencies from manifests
      await this.buildDependencyGraph(depGraph, rootPackage);
    }



    // Check for cycles
    const cycle = depGraph.detectCycle();
    if (cycle) {
      throw new Error(`Dependency cycle detected: ${cycle.join(" → ")}`);
    }

    // === LAYER 2: Resolve Addresses ===
    const resolvedGraph = new ResolvedGraph(depGraph, {});
    await resolvedGraph.resolve();

    // Ensure we use the correct Move.toml for compilation (handling Move.mainnet.toml etc)
    const networkTomlName = `Move.${this.network}.toml`;
    for (const [pkgName, files] of this.packageFiles) {
      if (files[networkTomlName]) {
        // If a network-specific TOML exists, it takes precedence as the "Move.toml"
        // for the compilation phase. This handles cases where Move.toml
        // is just a symlink/placeholder and Move.mainnet.toml has real config.
        files["Move.toml"] = files[networkTomlName];
      }
    }

    // === LAYER 3: Prepare Compilation Dependencies ===
    const compilationDeps = new CompilationDependencies(resolvedGraph);
    await compilationDeps.compute(this.packageFiles);

    // === Convert to Compiler Input Format ===
    // Rebuild root Move.toml with unified addresses (matches CLI named_address_map)
    const unifiedTable = resolvedGraph.getUnifiedAddressTable();

    // Fix: Ensure unified table reflects the actual published IDs of packages
    // This allows aliases for dependencies with mismatched names to resolve to the correct published address.
    // We prioritize originalId for compilation (stability).
    for (const pkg of depGraph.getAllPackages()) {
      const publishedId =
        pkg.manifest.originalId ||
        pkg.manifest.publishedAt ||
        pkg.manifest.latestPublishedId;

      if (pkg.manifest.name === "Sui" || pkg.manifest.name === "sui") {

      }

      if (
        publishedId &&
        publishedId !== "0x0" &&
        !publishedId.startsWith(
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        )
      ) {
        const normalized = this.normalizeAddress(publishedId);
        // Map both ExactName and lowercase_name just to be safe and cover common Move patterns
        unifiedTable[pkg.manifest.name] = normalized;
        unifiedTable[pkg.manifest.name.toLowerCase()] = normalized;
      }
    }

    const updatedRootToml = this.reconstructMoveToml(
      rootParsed,
      unifiedTable,
      true,
      rootEdition
    );

    const updatedRootFiles = { ...rootFiles };
    delete updatedRootFiles["Move.lock"];
    updatedRootFiles["Move.toml"] = updatedRootToml;

    // Use new package-grouped format for per-package edition support
    const packageGroups = compilationDeps.toPackageGroupedFormat(
      this.packageFiles
    );


    return {
      files: JSON.stringify(updatedRootFiles),
      dependencies: JSON.stringify(packageGroups),
    };
  }

  /**
   * Build a Package object from Move.toml and files
   */
  private async buildPackage(
    name: string,
    source: DependencySource | null,
    moveTomlContent: string,
    files: Record<string, string>
  ): Promise<Package> {
    const parsed = parseToml(moveTomlContent);

    // Resolve published-at and original-id using CLI logic (Move.lock [env] + Move.toml)
    const moveLockContent = files["Move.lock"];
    const chainId = this.getChainIdForNetwork(this.network);
    const publishedAtResult = this.resolvePublishedAt(
      moveTomlContent,
      moveLockContent,
      chainId,
      this.network
    );
    const latestPublishedId = publishedAtResult.latestId
      ? this.normalizeAddress(publishedAtResult.latestId)
      : undefined;

    // Check for Published.toml (Sui CLI compatibility)
    // The CLI uses this to track published versions per environment.
    const publishedTomlContent = files["Published.toml"];
    let publishedAtFromPublishedToml: string | undefined;
    let originalIdFromPublishedToml: string | undefined;

    if (publishedTomlContent) {
      try {
        const publishedToml = parseToml(publishedTomlContent);
        // Format: [published.<network>]
        const envSection = publishedToml.published?.[this.network];
        if (envSection) {
          if (envSection["published-at"]) {
            publishedAtFromPublishedToml = this.normalizeAddress(
              envSection["published-at"]
            );
          }
          if (envSection["original-id"]) {
            originalIdFromPublishedToml = this.normalizeAddress(
              envSection["original-id"]
            );
          }
        }
      } catch (_e) {
        // console.warn("Failed to parse Published.toml", e);
      }
    }

    if (publishedAtResult.error) {
      // suppress noisy warnings
    }

    const manifest: PackageManifest = {
      name: parsed.package?.name || name,
      version: parsed.package?.version || "0.0.0",
      edition: parsed.package?.edition,
      publishedAt:
        publishedAtFromPublishedToml || publishedAtResult.publishedAt,
      originalId: originalIdFromPublishedToml || publishedAtResult.originalId,
      latestPublishedId,
      addresses: parsed.addresses || {},
      dependencies: parsed.dependencies || {},
      devDependencies: parsed["dev-dependencies"],
    };

    // Check if package defines its own address in [addresses] (case-insensitive)
    // This handles cases where a package explicitly defines its address in `[addresses]` which might differ from `published-at`
    const selfAddressKey = Object.keys(manifest.addresses).find(
      (key) => key.toLowerCase() === manifest.name.toLowerCase()
    );

    if (selfAddressKey && manifest.addresses[selfAddressKey]) {
      const selfAddr = this.normalizeAddress(
        manifest.addresses[selfAddressKey]
      );
      // Treat explicit address as originalId if not 0x0
      if (
        selfAddr !==
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      ) {
        manifest.originalId = selfAddr;
      }
    }

    // Ensure package has an address entry for its own name.
    // ORIGINAL CLI SOURCE:
    // In `external-crates/move/crates/move-package-alt/src/graph/package_info.rs`, `node_to_addr` prioritization
    // determines the address used for a package node. It specifically prioritizes the address defined in the
    // manifest's `[addresses]` table (if it exists and matches the package name) over other sources like `published-at`.
    // This is critical for packages where `published-at` differs from the `[addresses]` entry.
    const addressToUse = manifest.originalId || manifest.publishedAt;
    const normalizedPublished =
      addressToUse && addressToUse !== "0x0"
        ? this.normalizeAddress(addressToUse)
        : undefined;

    const currentAddr = manifest.addresses[manifest.name];
    const normalizedCurrent = currentAddr
      ? this.normalizeAddress(currentAddr)
      : undefined;

    if (normalizedPublished) {
      // Fix: Do not overwrite if the package explicitly defines its own address in [addresses]
      // This handles cases where [addresses] pkg = "0x..." but published-at = "0x..." differs.
      if (!currentAddr) {
        manifest.addresses[manifest.name] = normalizedPublished;
      }
    } else if (!normalizedCurrent) {
      manifest.addresses[manifest.name] = "0x0";
    } else {
      manifest.addresses[manifest.name] = normalizedCurrent;
    }

    const dependencies = new Map<string, Dependency>();
    if (manifest.dependencies) {
      for (const [depName, depInfo] of Object.entries(manifest.dependencies)) {
        const dep = this.parseDependencyInfo(depInfo);
        if (dep) {
          dependencies.set(depName, dep);
        }
      }
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

  /**
   * Parse dependency info from Move.toml
   * Supports: git, local, addr-subst, rename-from (new package manager)
   */
  private parseDependencyInfo(depInfo: any): Dependency | null {
    if (!depInfo) return null;

    const dep: Dependency = {
      source: { type: "local" }, // Will be overwritten
    };

    // Parse source
    if (depInfo.git && depInfo.rev) {
      dep.source = {
        type: "git",
        git: depInfo.git,
        rev: depInfo.rev,
        subdir: depInfo.subdir,
      };
    } else if (depInfo.local) {
      dep.source = {
        type: "local",
        local: depInfo.local,
      };
    } else {
      return null; // No valid source
    }

    // Parse address substitutions/renames (new package manager feature)
    // addr-subst = { SomeAddress = "0x123", OtherAddress = "AnotherName" }
    if (depInfo["addr-subst"] || depInfo.addr_subst) {
      const substTable = depInfo["addr-subst"] || depInfo.addr_subst;
      const subst: Record<
        string,
        import("./dependencyGraph.js").SubstOrRename
      > = {};

      for (const [addrName, value] of Object.entries(substTable)) {
        if (typeof value === "string") {
          // Check if it's an address (starts with 0x) or a name
          if (value.startsWith("0x") || /^[0-9a-fA-F]+$/.test(value)) {
            // It's an address assignment
            subst[addrName] = { type: "assign", address: value };
          } else {
            // It's a rename-from
            subst[addrName] = { type: "renameFrom", name: value };
          }
        }
      }

      if (Object.keys(subst).length > 0) {
        dep.subst = subst;
      }
    }

    return dep;
  }

  /**
   * Recursively build the dependency graph
   */
  private async buildDependencyGraph(
    graph: DependencyGraph,
    pkg: Package
  ): Promise<void> {
    for (const [depName, dep] of pkg.dependencies.entries()) {
      // Convert local dependencies to git dependencies using parent's git info
      if (dep.source.type === "local") {
        if (pkg.id.source.type === "git" && dep.source.local) {
          // Parent is from git, convert local path to git subdir
          const parentSubdir = pkg.id.source.subdir || "";
          const localPath = dep.source.local;

          // Resolve relative path: ../token from packages/deepbook -> packages/token
          const resolvedSubdir = this.resolveRelativePath(
            parentSubdir,
            localPath
          );

          // Replace with git dependency
          dep.source = {
            type: "git",
            git: pkg.id.source.git,
            rev: pkg.id.source.rev,
            subdir: resolvedSubdir,
          };
        } else {
          continue;
        }
      }

      if (dep.source.type !== "git") {
        continue;
      }

      const cacheKey = `${dep.source.git}|${dep.source.rev}|${dep.source.subdir || ""}`;

      if (this.visited.has(cacheKey)) {
        // Already processed, just add edge
        const existingPkg = this.findPackageBySource(graph, dep.source);
        if (existingPkg) {
          graph.addDependency(pkg.id.name, existingPkg.id.name, dep);
        }
        continue;
      }

      this.visited.add(cacheKey);

      // Infer subdir for Sui framework packages
      let subdir = dep.source.subdir;
      if (!subdir && dep.source.git && this.isSuiRepo(dep.source.git)) {
        subdir = this.inferSuiFrameworkSubdir(depName);
        if (subdir) {
          dep.source.subdir = subdir;
        }
      }

      // Fetch dependency files
      const files = await this.fetcher.fetch(
        dep.source.git!,
        dep.source.rev!,
        subdir
      );

      // Find Move.toml
      let moveTomlContent: string | null = null;
      const networkTomlName = `Move.${this.network}.toml`;

      // Try network-specific Move.toml first
      for (const [path, content] of Object.entries(files)) {
        if (path.endsWith(networkTomlName)) {
          moveTomlContent = content;
          break;
        }
      }

      // Fallback to Move.toml
      if (!moveTomlContent) {
        for (const [path, content] of Object.entries(files)) {
          if (path.endsWith("Move.toml")) {
            moveTomlContent = content;
            break;
          }
        }
      }

      if (!moveTomlContent) {
        // If we are in 'build' mode, Move.toml must exist for compilation.
        // If we are in 'build' mode, Move.toml must exist for compilation.
        // Otherwise, we can skip this dependency if it's not critical.
        continue;
      }

      // Build package
      const depPackage = await this.buildPackage(
        depName,
        dep.source,
        moveTomlContent,
        files
      );

      // Check if we already have a package with this name (version conflict)
      // For lockfile v4+, package IDs are already unique (Sui, Sui_1...), so skip name-based dedupe.
      if (!this.lockfileVersion || this.lockfileVersion < 4) {
        const existingSource = this.packageNameCache.get(
          depPackage.manifest.name
        );
        if (existingSource) {
          // CLI behavior: same package name with different source is an error.
          const describe = (src: DependencySource) => JSON.stringify(src);
          throw new Error(
            [
              `Conflicting versions of package '${depPackage.manifest.name}' found`,
              `Existing: ${describe(existingSource)}`,
              `New: ${describe(dep.source)}`,
              `When resolving dependencies for '${pkg.id.name}' -> '${depName}'`,
            ].join("\n")
          );
        }
        // Remember this package name's source for legacy lockfile handling
        this.packageNameCache.set(depPackage.manifest.name, dep.source);
      }

      // published-at is already resolved in buildPackage via resolvePublishedAt
      // We rely on buildPackage to populate manifest.addresses correctly

      // Use edition only from Move.toml (Move.lock editions are unreliable)
      // If Move.toml doesn't specify edition, default to 'legacy' for safety
      if (!depPackage.manifest.edition) {
        depPackage.manifest.edition = "legacy";
      }

      // CLI behavior: Dependency IDs are extracted from:
      // 1. [addresses] section with package's own name (if not 0x0)
      // 2. published-at field from [package] section (resolved via resolvePublishedAt)
      // No hardcoded fallback - WASM code handles extraction

      // Add to graph
      graph.addPackage(depPackage);
      graph.addDependency(pkg.id.name, depPackage.id.name, dep);

      // Use source files directly - compiler needs source, not bytecode
      this.packageFiles.set(depPackage.id.name, files);

      // Recursively resolve this package's dependencies
      await this.buildDependencyGraph(graph, depPackage);
    }
  }

  /**
   * Get chain ID for network (following Sui conventions)
   * These are the actual chain identifiers used by Sui networks
   */
  private getChainIdForNetwork(network: string): string | undefined {
    // Known chain IDs (as seen in Move.lock [env.<chain_id>])
    const chainIdMap: Record<string, string> = {
      mainnet: "35834a8a",
      testnet: "4c78adac",
      devnet: "2", // devnet chain id is not stable; use placeholder
      localnet: "localnet",
    };
    return chainIdMap[network] || network;
  }

  /**
   * Resolve published-at and original-id following CLI logic from sui-package-management/lib.rs
   *
   * Priority:
   * 1. Move.lock [env.<chain_id>].latest-published-id (if chain_id provided)
   * 2. Move.toml [package].published-at
   * 3. Detect conflicts between Move.lock and Move.toml
   * 4. Track original-id for package upgrade chains
   *
   * Distinguish between chainId (e.g. 35834a8a) and network alias (e.g. mainnet)
   */
  private resolvePublishedAt(
    moveTomlContent: string,
    moveLockContent: string | undefined,
    chainId: string | undefined,
    network: string
  ): {
    publishedAt?: string;
    originalId?: string;
    latestId?: string;
    error?: string;
  } {
    const moveToml = parseToml(moveTomlContent);

    // Read published-at from Move.toml
    const publishedAtInManifest =
      moveToml.package?.published_at || moveToml.package?.["published-at"];
    const manifestIdRaw =
      publishedAtInManifest && publishedAtInManifest !== "0x0"
        ? publishedAtInManifest
        : undefined;
    const manifestId = manifestIdRaw
      ? this.normalizeAddress(manifestIdRaw)
      : undefined;

    // Read original-id from Move.toml (if specified manually)
    const originalIdInManifest = moveToml.package?.["original-id"];

    // Read from Move.lock if available
    let lockOriginalId: string | undefined;
    let lockLatestId: string | undefined;

    if (moveLockContent) {
      try {
        const lock = parseToml(moveLockContent);
        // Check both [env.<chainId>] and [env.<network>]
        // Sui CLI writes [env.<chain_id>] but might fall back to alias in some contexts
        const envSection =
          (chainId && lock.env?.[chainId]) || lock.env?.[network];

        if (envSection) {
          if (envSection["original-published-id"]) {
            lockOriginalId = this.normalizeAddress(
              envSection["original-published-id"]
            );
          }
          if (envSection["latest-published-id"]) {
            lockLatestId = this.normalizeAddress(
              envSection["latest-published-id"]
            );
          }
        }
      } catch (e) {
        // failed to parse lock, ignore
      }
    }

    // Logic: Prefer Move.toml if present (it overrides).
    // Fallback to Move.lock for dependencies that don't have published-at in Manifest but have it in Lock.
    // CRITICAL: Prefer original-published-id from lockfile over latest-published-id.
    // This matches Sui CLI behavior where the address used for compilation is the original ID
    // (ensuring stability across upgrades), while the latest ID is tracked for resolution.
    // CRITICAL: Prefer original-published-id from lockfile over latest-published-id.
    // This matches Sui CLI behavior where the address used for compilation is the original ID
    // (ensuring stability across upgrades), while the latest ID is tracked for resolution.
    // CRITICAL: We prioritize ORIGINAL-published-id to match compilationDependencies usage for BUILD.
    const finalPublishedAt = lockOriginalId || manifestId || lockLatestId;

    const result = {
      publishedAt: finalPublishedAt,
      originalId: originalIdInManifest || lockOriginalId,
      latestId: lockLatestId,
    };
    return result;
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
        pkgSource.subdir === source.subdir
      ) {
        return pkg;
      }
    }
    return undefined;
  }

  /**
   * Resolve relative path for local dependencies
   * Example: parentSubdir="packages/deepbook", localPath="../token" -> "packages/token"
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

  /**
   * Compute manifest digest for lockfile validation (Sui CLI compatible)
   */
  private async computeManifestDigest(
    moveTomlContent: string
  ): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(moveTomlContent);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hashHex.toUpperCase();
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
      // Version 3 format: Use [[move.package]] array
      return await this.loadFromLockfileV3(graph, lockfile, rootPackage);
    } else if (lockfileVersion && lockfileVersion >= 4) {
      // Try v4+ format first (pinned)
      if (lockfile.pinned) {
        return await this.loadFromLockfileV4(
          graph,
          lockfile,
          rootFiles,
          rootPackage
        );
      } else {
        // Fallback for pinned property missing in v4+ (unlikely but safe)
        return false;
      }
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
          }
        }
      }
    }

    // Root edges from manifest dependencies
    for (const depName of rootPackage.dependencies.keys()) {
      const depPkg = packageByName.get(depName);
      if (depPkg) {
        const dep = rootPackage.dependencies.get(depName)!;
        graph.addDependency(rootPackage.id.name, depPkg.id.name, dep);
      }
    }

    return packageById.size > 0;
  }

  /**
   * Load from Move.lock version 3 format ([[move.package]] array)
   */
  private async loadFromLockfileV3(
    graph: DependencyGraph,
    lockfile: any,
    rootPackage: Package
  ): Promise<boolean> {
    const packages = lockfile.move?.package;
    if (!packages || !Array.isArray(packages)) {
      return false;
    }

    const packageById = new Map<string, Package>();
    const pkgInfoById = new Map<string, any>();
    const lockfileOrder: string[] = [];

    for (const pkgInfo of packages) {
      if (pkgInfo.id) {
        pkgInfoById.set(pkgInfo.id, pkgInfo);
      }
    }

    // First pass: Fetch and create all packages
    for (const pkgInfo of packages) {
      const pkgId = pkgInfo.id;
      const source = pkgInfo.source;

      // Track the order from [[move.package]] array - this is the order we need to preserve
      lockfileOrder.push(pkgId);

      // Resolve source: prefer git, or convert local to root git if hint available
      let depSource: DependencySource | null = null;
      if (source?.git && source.rev) {
        depSource = {
          type: "git",
          git: source.git,
          rev: source.rev,
          subdir: source.subdir,
        };
      } else if (source?.local && this.rootSource?.type === "git") {
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

      if (!depSource.git || !depSource.rev) {
        continue;
      }

      // Fetch package files
      const files = await this.fetcher.fetch(
        depSource.git,
        depSource.rev,
        depSource.subdir
      );

      if (Object.keys(files).length === 0) {
        continue;
      }

      // Find Move.toml
      const moveToml = files["Move.toml"];
      if (!moveToml) {
        continue;
      }

      // Build package
      const pkg = await this.buildPackage(pkgId, depSource, moveToml, files);
      packageById.set(pkgId, pkg);
      this.packageFiles.set(pkg.manifest.name, files);
      graph.addPackage(pkg);
    }

    // Set lockfile order from [[move.package]] array (this is the order from BuildInfo.yaml)
    graph.setLockfileOrder(lockfileOrder);

    // Second pass: Add dependency edges using lockfile dependencies
    for (const pkgInfo of packages) {
      const pkgId = pkgInfo.id;
      const pkg = packageById.get(pkgId);
      if (!pkg) continue;

      const deps = pkgInfo.dependencies;
      if (!deps || !Array.isArray(deps)) continue;

      for (const depInfo of deps) {
        const depId = depInfo.id;
        let depPkg = packageById.get(depId);

        // If dependency package not yet built (e.g., local source), try to build it now using parent context
        if (!depPkg) {
          const depPkgInfo = pkgInfoById.get(depId);
          if (depPkgInfo?.source?.local && pkg.id.source.type === "git") {
            const resolvedSubdir = this.resolveRelativePath(
              pkg.id.source.subdir || "",
              depPkgInfo.source.local
            );
            const depSource: DependencySource = {
              type: "git",
              git: pkg.id.source.git!,
              rev: pkg.id.source.rev!,
              subdir: resolvedSubdir,
            };
            const files = await this.fetcher.fetch(
              depSource.git!,
              depSource.rev!,
              depSource.subdir
            );
            const moveToml = files["Move.toml"];
            if (moveToml) {
              const built = await this.buildPackage(
                depId,
                depSource,
                moveToml,
                files
              );
              packageById.set(depId, built);
              this.packageFiles.set(built.manifest.name, files);
              graph.addPackage(built);
              depPkg = built;
            }
          }
        }

        if (depPkg) {
          // Create a dependency object
          const dep: Dependency = {
            source: depPkg.id.source,
          };
          graph.addDependency(pkg.id.name, depPkg.id.name, dep);
        }
      }
    }

    // Also add root package dependencies from Move.toml
    for (const depName of rootPackage.dependencies.keys()) {
      const depPkg = packageById.get(depName);
      if (depPkg) {
        const dep = rootPackage.dependencies.get(depName)!;
        graph.addDependency(rootPackage.id.name, depPkg.id.name, dep);
      }
    }

    return true;
  }

  /**
   * Load from Move.lock version 4+ format (pinned section)
   */
  private async loadFromLockfileV4(
    graph: DependencyGraph,
    lockfile: any,
    rootFiles: Record<string, string>,
    rootPackage: Package
  ): Promise<boolean> {
    // Check if lockfile has pinned dependencies for this network
    const pinnedPackages = lockfile.pinned?.[this.network];
    // Version 4+ format: Use pinned section
    if (!pinnedPackages) return false;

    // Root package is already built and passed in (graph already has it from resolve())

    // Check manifest digest
    const rootToml = rootFiles["Move.toml"];
    if (
      rootToml &&
      lockfile.move?.manifest_digest &&
      (await this.computeManifestDigest(rootToml)) !==
      lockfile.move.manifest_digest
    ) {
      return false;
    }

    // Build graph from pinned packages
    const packageById = new Map<string, Package>();
    const packageByName = new Map<string, Package>();
    const lockfileOrder: string[] = [];

    // First pass: Create all packages
    for (const [pkgId, pin] of Object.entries(pinnedPackages)) {
      lockfileOrder.push(pkgId);
      const source = this.lockfileSourceToDependencySource((pin as any).source);
      if (!source) {
        continue;
      }

      // Fetch package files
      const files = await this.fetchFromSource(source);
      if (!files) {
        return false;
      }

      // Find Move.toml
      const moveToml = files["Move.toml"];
      if (!moveToml) {
        return false;
      }

      // Validate manifest digest if available
      if ((pin as any)["manifest-digest"]) {
        const currentDigest = await this.computeManifestDigest(moveToml);
        if (currentDigest !== (pin as any)["manifest-digest"]) {
          return false;
        }
      }

      // Build package
      const pkg = await this.buildPackage(pkgId, source, moveToml, files);
      packageById.set(pkgId, pkg);
      packageByName.set(pkg.manifest.name, pkg);
      this.packageFiles.set(pkg.manifest.name, files);

      // Add to graph (if not root)
      if (source.type !== "local" || !("root" in (pin as any).source)) {
        graph.addPackage(pkg);
      }
    }

    // Preserve lockfile order
    if (lockfileOrder.length > 0) {
      graph.setLockfileOrder(lockfileOrder);
    }

    // Second pass: Add dependency edges
    for (const [pkgId, pin] of Object.entries(pinnedPackages)) {
      const pkg = packageById.get(pkgId);
      if (!pkg) continue;

      if ((pin as any).deps) {
        for (const [depName, depId] of Object.entries((pin as any).deps)) {
          const depPkg = packageById.get(depId as string);
          if (depPkg) {
            const dep = pkg.dependencies.get(depName);
            if (dep) {
              graph.addDependency(pkg.id.name, depPkg.id.name, dep);
            }
          }
        }
      }
    }

    // Add root edges from Move.lock [move] dependencies if available
    if (
      lockfile.move?.dependencies &&
      Array.isArray(lockfile.move.dependencies)
    ) {
      for (const depInfo of lockfile.move.dependencies) {
        const depId = depInfo.id;
        const depPkg = packageById.get(depId);
        if (depPkg) {
          // Create a synthetic dependency object
          const dep: Dependency = {
            source: depPkg.id.source,
          };
          graph.addDependency(rootPackage.id.name, depPkg.id.name, dep);
        }
      }
    } else {
      // Fallback: Add root edges from manifest dependencies to pinned packages
      for (const depName of rootPackage.dependencies.keys()) {
        const depPkg = packageByName.get(depName) || packageById.get(depName);
        if (depPkg) {
          const dep = rootPackage.dependencies.get(depName)!;
          graph.addDependency(rootPackage.id.name, depPkg.id.name, dep);
        }
      }
    }

    return true;
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
    source: DependencySource
  ): Promise<Record<string, string> | null> {
    if (source.type === "git" && source.git && source.rev) {
      try {
        return await this.fetcher.fetch(source.git, source.rev, source.subdir);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Reconstruct Move.toml with unified addresses
   */
  private reconstructMoveToml(
    originalParsed: any,
    addresses: Record<string, string>,
    isRoot: boolean,
    editionOverride?: string
  ): string {
    const packageName = originalParsed.package.name;
    let newToml = `[package]\nname = "${packageName}"\nversion = "${originalParsed.package.version}"\n`;

    // Priority: editionOverride (from Move.lock) > originalParsed.package.edition
    // If neither exists, don't add edition field (let compiler use default)
    const editionToUse = editionOverride || originalParsed.package.edition;
    if (editionToUse) {
      newToml += `edition = "${editionToUse}"\n`;
    }

    newToml += `\n[dependencies]\n`;
    if (originalParsed.dependencies) {
      const sortedDeps = Object.entries(originalParsed.dependencies).sort(
        ([a], [b]) => a.localeCompare(b)
      );
      for (const [name, info] of sortedDeps) {
        const depInfo = info as any;
        if (depInfo.local) {
          newToml += `${name} = { local = "${depInfo.local}" }\n`;
        } else if (depInfo.git && depInfo.rev) {
          if (depInfo.subdir) {
            newToml += `${name} = { git = "${depInfo.git}", subdir = "${depInfo.subdir}", rev = "${depInfo.rev}" }\n`;
          } else {
            newToml += `${name} = { git = "${depInfo.git}", rev = "${depInfo.rev}" }\n`;
          }
        }
      }
    }

    newToml += `\n[addresses]\n`;
    const sortedAddrs = Object.entries(addresses).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [addrName, addrVal] of sortedAddrs) {
      newToml += `${addrName} = "${addrVal}"\n`;
    }

    return newToml;
  }

  /**
   * Normalize address to 0x-prefixed 64-char hex
   */
  private normalizeAddress(addr: string): string {
    if (!addr) return addr;
    let clean = addr.trim();
    if (clean.startsWith("0x")) clean = clean.slice(2);

    if (!/^[0-9a-fA-F]+$/.test(clean)) {
      return addr;
    }

    return "0x" + clean.padStart(64, "0");
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
  rootSource?: DependencySource
): Promise<{ files: string; dependencies: string }> {
  const resolver = new Resolver(fetcher, network, rootSource || null);
  return resolver.resolve(rootMoveTomlContent, rootSourceFiles);
}
