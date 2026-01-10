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
  ParsedLockfile,
  LockfileDependencyInfo,
} from "./dependencyGraph.js";
import { ResolvedGraph } from "./resolvedGraph.js";
import { CompilationDependencies } from "./compilationDependencies.js";

export class Resolver {
  private fetcher: Fetcher;
  private network: "mainnet" | "testnet" | "devnet";

  // Track visited dependencies by git source to avoid duplicates
  private visited: Set<string> = new Set();

  // Track visited package names to handle version conflicts
  // Maps package name -> first seen source
  private packageNameCache: Map<string, DependencySource> = new Map();

  // Store fetched package files: packageName -> files
  private packageFiles: Map<string, Record<string, string>> = new Map();

  constructor(
    fetcher: Fetcher,
    network: "mainnet" | "testnet" | "devnet" = "mainnet"
  ) {
    this.fetcher = fetcher;
    this.network = network;
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
    let rootEdition: string | undefined = rootParsed.package?.edition;
    if (rootFiles["Move.lock"]) {
      const rootMoveLock = parseToml(rootFiles["Move.lock"]) as any;
      if (rootMoveLock.move?.["toolchain-version"]?.edition) {
        rootEdition = rootMoveLock.move["toolchain-version"].edition;
      }
    }

    const globalEdition: string = rootEdition || "2024.beta";

    // === LAYER 1: Build DependencyGraph ===
    const depGraph = new DependencyGraph(rootPackageName);

    // Build root package
    const rootPackage = await this.buildPackage(
      rootPackageName,
      null,
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
        console.log(
          `📋 Replacing root package 0x0 address with original-published-id: ${rootPackage.manifest.originalId}`
        );
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
    console.log("📋 Loaded from lockfile:", loadedFromLockfile);

    if (!loadedFromLockfile) {
      console.log("📋 Falling back to manifest-based resolution");
      console.log(
        "📋 Root package dependencies from manifest:",
        Object.keys(rootPackage.manifest.dependencies || {})
      );
      console.log(
        "📋 Root package dependencies Map size:",
        rootPackage.dependencies.size
      );
      console.log(
        "📋 Root package dependencies Map keys:",
        Array.from(rootPackage.dependencies.keys())
      );
      // Fallback: Recursively resolve all dependencies from manifests
      try {
        await this.buildDependencyGraph(depGraph, rootPackage);
        console.log(
          "📋 After buildDependencyGraph, packages:",
          depGraph.getAllPackages().map((p) => p?.name)
        );
      } catch (err) {
        console.error("📋 Error in buildDependencyGraph:", err.message);
        throw err;
      }
    }

    // Check for cycles
    const cycle = depGraph.detectCycle();
    if (cycle) {
      throw new Error(`Dependency cycle detected: ${cycle.join(" → ")}`);
    }

    // === LAYER 2: Resolve Addresses ===
    const resolvedGraph = new ResolvedGraph(depGraph, {});
    await resolvedGraph.resolve();

    // === LAYER 3: Prepare Compilation Dependencies ===
    const compilationDeps = new CompilationDependencies(resolvedGraph);
    await compilationDeps.compute(this.packageFiles);

    // === Convert to Compiler Input Format ===
    const updatedRootToml = this.reconstructMoveToml(
      rootParsed,
      resolvedGraph.getUnifiedAddressTable(),
      true,
      globalEdition
    );

    console.log("📋 Reconstructed root Move.toml:\n" + updatedRootToml);

    const updatedRootFiles = { ...rootFiles };
    delete updatedRootFiles["Move.lock"];
    updatedRootFiles["Move.toml"] = updatedRootToml;

    // Use new package-grouped format for per-package edition support
    const packageGroups = compilationDeps.toPackageGroupedFormat(
      this.packageFiles
    );

    console.log("📋 Number of dependency packages:", packageGroups.length);
    console.log(
      "📋 Dependency package names:",
      packageGroups.map((p) => p.name).join(", ")
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
      chainId
    );

    if (publishedAtResult.error) {
      console.warn(`⚠️  ${name}: ${publishedAtResult.error}`);
    }

    const manifest: PackageManifest = {
      name: parsed.package?.name || name,
      version: parsed.package?.version || "0.0.0",
      edition: parsed.package?.edition,
      publishedAt: publishedAtResult.publishedAt,
      originalId: publishedAtResult.originalId,
      addresses: parsed.addresses || {},
      dependencies: parsed.dependencies || {},
      devDependencies: parsed["dev-dependencies"],
    };

    // Ensure package has an address entry for its own name.
    // If published-at is known, use it; otherwise default to 0x0 as placeholder.
    if (!manifest.addresses[manifest.name]) {
      manifest.addresses[manifest.name] = manifest.publishedAt
        ? this.normalizeAddress(manifest.publishedAt)
        : "0x0";
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
    console.log(
      `📋 buildDependencyGraph for ${pkg.id.name}, deps count:`,
      pkg.dependencies.size
    );
    for (const [depName, dep] of pkg.dependencies.entries()) {
      console.log(
        `📋 Processing dependency: ${depName}, source type:`,
        dep.source.type
      );
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
      console.log(
        `📋 Fetching ${depName} from ${dep.source.git} @ ${dep.source.rev} (subdir: ${subdir})`
      );
      const files = await this.fetcher.fetch(
        dep.source.git!,
        dep.source.rev!,
        subdir
      );
      console.log(
        `📋 Fetched ${Object.keys(files).length} files for ${depName}`
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
        console.log(`📋 No Move.toml found for ${depName}, skipping`);
        continue;
      }
      console.log(`📋 Found Move.toml for ${depName}`);

      // Build package
      const depPackage = await this.buildPackage(
        depName,
        dep.source,
        moveTomlContent,
        files
      );

      // Check if we already have a package with this name (version conflict)
      const existingSource = this.packageNameCache.get(
        depPackage.manifest.name
      );
      if (existingSource) {
        // Find existing package and add edge to it
        const existingPkg = this.findPackageBySource(graph, existingSource);
        if (existingPkg) {
          graph.addDependency(pkg.id.name, existingPkg.id.name, dep);
        }
        continue; // Skip adding this version
      }

      // Remember this package name's source
      this.packageNameCache.set(depPackage.manifest.name, dep.source);

      // published-at is already resolved in buildPackage via resolvePublishedAt
      // But we need to update addresses table if publishedAt exists
      if (depPackage.manifest.publishedAt) {
        console.log(
          `📋 Setting ${depPackage.manifest.name} address from published-at: ${depPackage.manifest.publishedAt}`
        );
        depPackage.manifest.addresses[depPackage.manifest.name] =
          this.normalizeAddress(depPackage.manifest.publishedAt);
      } else {
        console.log(`📋 No published-at for ${depPackage.manifest.name}`);
      }

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
    // Chain IDs are managed by Sui and can be queried via RPC
    // For now, we use common environment names that match Move.lock [env] keys
    const chainIdMap: Record<string, string> = {
      mainnet: "mainnet",
      testnet: "testnet",
      devnet: "devnet",
      localnet: "localnet",
    };
    return chainIdMap[network];
  }

  /**
   * Resolve published-at and original-id following CLI logic from sui-package-management/lib.rs
   *
   * Priority:
   * 1. Move.lock [env.<chain_id>].latest-published-id (if chain_id provided)
   * 2. Move.toml [package].published-at
   * 3. Detect conflicts between Move.lock and Move.toml
   * 4. Track original-id for package upgrade chains
   */
  private resolvePublishedAt(
    moveTomlContent: string,
    moveLockContent: string | undefined,
    chainId: string | undefined
  ): { publishedAt?: string; originalId?: string; error?: string } {
    const moveToml = parseToml(moveTomlContent);

    // Read published-at from Move.toml
    const publishedAtInManifest =
      moveToml.package?.published_at || moveToml.package?.["published-at"];
    const manifestId =
      publishedAtInManifest && publishedAtInManifest !== "0x0"
        ? publishedAtInManifest
        : undefined;

    // Read original-id from Move.toml (if specified manually)
    const originalIdInManifest = moveToml.package?.["original-id"];

    // If no Move.lock or no chain_id, return manifest values
    if (!moveLockContent || !chainId) {
      return {
        publishedAt: manifestId,
        originalId: originalIdInManifest,
      };
    }

    // Read published-at and original-id from Move.lock [env.<chain_id>]
    const moveLock = parseToml(moveLockContent) as any;
    let lockId: string | undefined;
    let lockOriginalId: string | undefined;

    if (moveLock.env) {
      // Find environment matching chain_id
      for (const [envName, envData] of Object.entries(
        moveLock.env as Record<string, any>
      )) {
        const latestId = envData["latest-published-id"];
        const originalId = envData["original-published-id"];
        const envChainId = envData["chain-id"];

        // Match by chain-id if available, otherwise use first environment
        if (envChainId === chainId || !envChainId) {
          const id = latestId || originalId;
          if (id && id !== "0x0") {
            lockId = id;
          }
          if (originalId && originalId !== "0x0") {
            lockOriginalId = originalId;
          }
          break;
        }
      }
    }

    // Detect conflicts (CLI behavior: lib.rs:195-209)
    if (lockId && manifestId && lockId !== manifestId) {
      return {
        error: `Conflicting 'published-at' addresses between Move.toml (${manifestId}) and Move.lock (${lockId})`,
      };
    }

    // Return lock values if available, otherwise manifest
    return {
      publishedAt: lockId || manifestId,
      originalId: lockOriginalId || originalIdInManifest,
    };
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

    // Support both version 3 ([[move.package]]) and version 4 (pinned) formats
    const lockfileVersion = lockfile.move?.version;
    console.log("📋 Move.lock version:", lockfileVersion);

    if (lockfileVersion === 3) {
      // Version 3 format: Use [[move.package]] array
      return await this.loadFromLockfileV3(
        graph,
        lockfile,
        rootPackage,
        rootFiles
      );
    } else if (lockfileVersion && lockfileVersion >= 4) {
      // Version 4+ format: Use pinned section
      return await this.loadFromLockfileV4(graph, lockfile, rootFiles);
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
    const lockfileOrder =
      (Array.isArray(lockfile.move?.dependencies)
        ? lockfile.move.dependencies
            .map((d: any) => d.name || d.id || d)
            .filter(Boolean)
        : null) || packages.map((p: any) => p.name || p.id).filter(Boolean);

    const packageById = new Map<string, Package>();
    const packageByName = new Map<string, Package>();

    // First pass: fetch and build packages
    for (const pkgInfo of packages) {
      const pkgId = pkgInfo.id || pkgInfo.name;
      const source = pkgInfo.source;
      if (!pkgId || !source || !source.git || !source.rev) {
        continue;
      }

      const depSource: DependencySource = {
        type: "git",
        git: source.git,
        rev: source.rev,
        subdir: source.subdir,
      };

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
    rootPackage: Package,
    rootFiles: Record<string, string>
  ): Promise<boolean> {
    const packages = lockfile.move?.package;
    if (!packages || !Array.isArray(packages)) {
      console.log("📋 No move.package array found in lockfile v3");
      return false;
    }

    console.log("📋 Loading from lockfile v3, packages:", packages.length);

    const packageById = new Map<string, Package>();
    const lockfileOrder: string[] = [];

    // First pass: Fetch and create all packages
    for (const pkgInfo of packages) {
      const pkgId = pkgInfo.id;
      const source = pkgInfo.source;

      // Track the order from [[move.package]] array - this is the order we need to preserve
      lockfileOrder.push(pkgId);

      if (!source || !source.git) {
        console.log(`📋 Skipping ${pkgId}: no git source`);
        continue;
      }

      const depSource: DependencySource = {
        type: "git",
        git: source.git,
        rev: source.rev,
        subdir: source.subdir,
      };

      console.log(
        `📋 Fetching ${pkgId} from lockfile v3:`,
        source.git,
        "@",
        source.rev
      );

      // Fetch package files
      const files = await this.fetcher.fetch(
        source.git,
        source.rev,
        source.subdir
      );
      if (Object.keys(files).length === 0) {
        console.log(`📋 No files fetched for ${pkgId}`);
        continue;
      }

      // Find Move.toml
      const moveToml = files["Move.toml"];
      if (!moveToml) {
        console.log(`📋 No Move.toml for ${pkgId}`);
        continue;
      }

      // Build package
      const pkg = await this.buildPackage(pkgId, depSource, moveToml, files);
      packageById.set(pkgId, pkg);
      this.packageFiles.set(pkg.manifest.name, files);
      graph.addPackage(pkg);

      console.log(`📋 Added package ${pkgId} (${pkg.manifest.name}) to graph`);
    }

    // Set lockfile order from [[move.package]] array (this is the order from BuildInfo.yaml)
    console.log(
      "📋 Setting lockfile order from [[move.package]]:",
      lockfileOrder
    );
    graph.setLockfileOrder(lockfileOrder);

    // Second pass: Add dependency edges using lockfile dependencies
    for (const pkgInfo of packages) {
      const pkgId = pkgInfo.id;
      const pkg = packageById.get(pkgId);
      if (!pkg) continue;

      const deps = pkgInfo.dependencies;
      if (!deps || !Array.isArray(deps)) continue;

      console.log(`📋 Processing dependencies for ${pkgId}:`, deps.length);

      for (const depInfo of deps) {
        const depId = depInfo.id;
        const depName = depInfo.name;
        const depPkg = packageById.get(depId);

        if (depPkg) {
          // Create a dependency object
          const dep: Dependency = {
            source: depPkg.id.source,
          };
          graph.addDependency(pkg.id.name, depPkg.id.name, dep);
          console.log(`📋 Added edge: ${pkg.id.name} -> ${depPkg.id.name}`);
        } else {
          console.log(`📋 Dependency ${depId} not found for ${pkgId}`);
        }
      }
    }

    // Also add root package dependencies
    for (const depName of rootPackage.dependencies.keys()) {
      const depPkg = packageById.get(depName);
      if (depPkg) {
        const dep = rootPackage.dependencies.get(depName)!;
        graph.addDependency(rootPackage.id.name, depPkg.id.name, dep);
        console.log(
          `📋 Added root edge: ${rootPackage.id.name} -> ${depPkg.id.name}`
        );
      }
    }

    console.log(
      "📋 Lockfile v3 loading complete, packages in graph:",
      graph.getAllPackages().length
    );
    return true;
  }

  /**
   * Load from Move.lock version 4+ format (pinned section)
   */
  private async loadFromLockfileV4(
    graph: DependencyGraph,
    lockfile: any,
    rootFiles: Record<string, string>
  ): Promise<boolean> {
    // Check if lockfile has pinned dependencies for this network
    const pinnedPackages = lockfile.pinned?.[this.network];
    if (!pinnedPackages) {
      return false;
    }

    // Validate root manifest digest
    const rootMoveToml = rootFiles["Move.toml"];
    if (rootMoveToml && lockfile.move?.manifest_digest) {
      const currentDigest = await this.computeManifestDigest(rootMoveToml);
      if (currentDigest !== lockfile.move.manifest_digest) {
        return false;
      }
    }

    // Build graph from pinned packages
    const packageById = new Map<string, Package>();

    // First pass: Create all packages
    for (const [pkgId, pin] of Object.entries(pinnedPackages)) {
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
      this.packageFiles.set(pkg.manifest.name, files);

      // Add to graph (if not root)
      if (source.type !== "local" || !("root" in (pin as any).source)) {
        graph.addPackage(pkg);
      }
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
      for (const [name, info] of Object.entries(originalParsed.dependencies)) {
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
    for (const [addrName, addrVal] of Object.entries(addresses)) {
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
      DeepBook: "crates/sui-framework/packages/deepbook",
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
  network: "mainnet" | "testnet" | "devnet" = "mainnet"
): Promise<{ files: string; dependencies: string }> {
  const resolver = new Resolver(fetcher, network);
  return resolver.resolve(rootMoveTomlContent, rootSourceFiles);
}
