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

    depGraph.addPackage(rootPackage);
    this.packageFiles.set(rootPackageName, rootFiles);

    // Try to load from lockfile first (Sui CLI behavior)
    const loadedFromLockfile = await this.loadFromLockfile(
      depGraph,
      rootPackage,
      rootFiles
    );

    if (!loadedFromLockfile) {
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
    _files: Record<string, string>
  ): Promise<Package> {
    const parsed = parseToml(moveTomlContent);

    const manifest: PackageManifest = {
      name: parsed.package?.name || name,
      version: parsed.package?.version || "0.0.0",
      edition: parsed.package?.edition,
      publishedAt: parsed.package?.published_at,
      addresses: parsed.addresses || {},
      dependencies: parsed.dependencies || {},
      devDependencies: parsed["dev-dependencies"],
    };

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
   */
  private parseDependencyInfo(depInfo: any): Dependency | null {
    if (!depInfo) return null;

    if (depInfo.git && depInfo.rev) {
      return {
        source: {
          type: "git",
          git: depInfo.git,
          rev: depInfo.rev,
          subdir: depInfo.subdir,
        },
      };
    }

    if (depInfo.local) {
      return {
        source: {
          type: "local",
          local: depInfo.local,
        },
      };
    }

    return null;
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

      // Update manifest with published-at from Move.lock if available
      const moveLockContent = files["Move.lock"];
      if (moveLockContent) {
        const moveLock = parseToml(moveLockContent) as any;
        if (moveLock.env?.[this.network]) {
          const publishedId =
            moveLock.env[this.network]["latest-published-id"] ||
            moveLock.env[this.network]["original-published-id"];
          if (publishedId) {
            depPackage.manifest.publishedAt = publishedId;
            depPackage.manifest.addresses[depPackage.manifest.name] =
              this.normalizeAddress(publishedId);
          }
        }

        // Use edition only from Move.toml (Move.lock editions are unreliable)
        // If Move.toml doesn't specify edition, default to 'legacy' for safety
        if (!depPackage.manifest.edition) {
          depPackage.manifest.edition = "legacy";
        }
      }

      // If no published-at found, use known system package addresses
      if (!depPackage.manifest.publishedAt) {
        const systemPackages: Record<string, string> = {
          Sui: "0x2",
          MoveStdlib: "0x1",
          SuiSystem: "0x3",
          Bridge: "0xb",
        };

        if (systemPackages[depName]) {
          depPackage.manifest.publishedAt = systemPackages[depName];
        }
      }

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

    const lockfile = parseToml(moveLockContent) as ParsedLockfile;

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
      const source = this.lockfileSourceToDependencySource(pin.source);
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
      if (pin["manifest-digest"]) {
        const currentDigest = await this.computeManifestDigest(moveToml);
        if (currentDigest !== pin["manifest-digest"]) {
          return false;
        }
      }

      // Build package
      const pkg = await this.buildPackage(pkgId, source, moveToml, files);
      packageById.set(pkgId, pkg);
      this.packageFiles.set(pkg.manifest.name, files);

      // Add to graph (if not root)
      if (source.type !== "local" || !("root" in pin.source)) {
        graph.addPackage(pkg);
      }
    }

    // Second pass: Add dependency edges
    for (const [pkgId, pin] of Object.entries(pinnedPackages)) {
      const pkg = packageById.get(pkgId);
      if (!pkg) continue;

      if (pin.deps) {
        for (const [depName, depId] of Object.entries(pin.deps)) {
          const depPkg = packageById.get(depId);
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
