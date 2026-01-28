/**
 * DependencyGraph Layer (Layer 1)
 *
 * Builds a directed acyclic graph (DAG) of all packages and their relationships.
 *
 * ORIGINAL SOURCE REFERENCES:
 * - move-package-alt/src/graph/mod.rs - PackageGraph struct and operations
 *   Uses petgraph::DiGraph<Arc<Package<F>>, PinnedDependencyInfo>
 * - move-package-alt/src/graph/mod.rs:120-124 - sorted_packages() uses petgraph::algo::toposort
 * - move-package-alt/src/graph/builder.rs - PackageGraphBuilder for construction
 * - move-package-alt/src/dependency/mod.rs - Dependency types
 */

export interface PackageIdentifier {
  name: string;
  version?: string;
  source: DependencySource;
}

export interface DependencySource {
  type: "git" | "local" | "onchain";
  git?: string;
  rev?: string;
  subdir?: string;
  local?: string;
  address?: string;
}

export type SubstOrRename =
  | { type: "assign"; address: string }
  | { type: "renameFrom"; name: string };

export interface Dependency {
  source: DependencySource;
  digest?: string;
  subst?: Record<string, SubstOrRename>; // address substitutions/renames
}

export type DiamondDependencyInfo = DependencySource & { name: string };

export interface Package {
  id: PackageIdentifier;
  manifest: PackageManifest;
  dependencies: Map<string, Dependency>;
  devDependencies: Map<string, Dependency>;
  resolvedTable?: Record<string, string>; // Will be filled in ResolvedGraph
  /** Maps Move.toml deps key (alias) → resolved package name */
  depAliasToPackageName?: Record<string, string>;
  /** Maps Move.toml deps key (alias) → dependency source info (for lockfile generation) */
  depAliasToSource?: Record<string, DiamondDependencyInfo>;
}

export interface PackageManifest {
  name: string;
  version?: string;
  edition?: string;
  publishedAt?: string;
  originalId?: string; // Original published ID (first version)
  latestPublishedId?: string; // Latest published ID from Move.lock (for logging/output)
  addresses: Record<string, string>;
  dependencies: Record<string, any>;
  devDependencies?: Record<string, any>;
}

/**
 * Lockfile structure (Move.lock)
 */
export interface ParsedLockfile {
  move?: {
    version?: number;
    manifest_digest?: string;
    deps_digest?: string;
    dependencies?: Array<{ name: string }>;
    "toolchain-version"?: {
      "compiler-version"?: string;
      edition?: string;
      flavor?: string;
    };
    package?: Array<LockfilePackage>;
  };
  env?: Record<
    string,
    {
      "latest-published-id"?: string;
      "original-published-id"?: string;
    }
  >;
  pinned?: Record<string, Record<string, LockfilePin>>;
}

export interface LockfilePackage {
  name: string;
  source?: LockfileDependencyInfo;
  dependencies?: Array<{ name: string }>;
}

export interface LockfilePin {
  source: LockfileDependencyInfo;
  "manifest-digest"?: string;
  deps?: Record<string, string>; // dep name -> package ID
}

export type LockfileDependencyInfo =
  | { local: string }
  | { git: string; subdir?: string; rev: string }
  | { root: boolean };

/**
 * DependencyGraph represents the complete package dependency DAG
 * ORIGINAL: builder.rs - uses DiGraph<Package, PinnedDependencyInfo> with NodeIndex
 *
 * Key changes for diamond dependency support:
 * - packages: array (index-based like NodeIndex)
 * - edges: Map<number, Set<number>> (index-based like DiGraph)
 * - nameToFirstIndex: for lookup by name
 */
export class DependencyGraph {
  // Packages array (index-based, like CLI's DiGraph nodes)
  // ORIGINAL: builder.rs:53 - inner: DiGraph<Arc<Package>, PinnedDependencyInfo>
  private packages: Package[] = [];

  // Adjacency list: package index -> set of dependency indices
  // ORIGINAL: builder.rs:330 - graph.add_edge(index, dep_index, dep)
  private edges: Map<number, Set<number>> = new Map();

  // Name to first index mapping (for getPackage lookup)
  private nameToFirstIndex: Map<string, number> = new Map();

  // Root package name
  private root: string;

  // Lockfile package order (for DFS ordering to match Sui CLI)
  private lockfileOrder: string[] = [];

  constructor(rootPackageName: string) {
    this.root = rootPackageName;
  }

  /**
   * Set lockfile package order (from Move.lock [[move.package]] order)
   */
  setLockfileOrder(order: string[]): void {
    this.lockfileOrder = order;
  }

  /**
   * Add a package to the graph
   * ORIGINAL: builder.rs:289 - graph.add_node(None) returns NodeIndex
   * @returns index of the added package (like NodeIndex)
   */
  addPackage(pkg: Package): number {
    const index = this.packages.length;
    this.packages.push(pkg);
    this.edges.set(index, new Set());
    // Only store first occurrence for lookup (like CLI's name collision handling)
    if (!this.nameToFirstIndex.has(pkg.id.name)) {
      this.nameToFirstIndex.set(pkg.id.name, index);
    }
    return index;
  }

  /**
   * Add a dependency edge from source package to dependency package (by name)
   * ORIGINAL: builder.rs:330 - graph.add_edge(index, dep_index, dep)
   */
  addDependency(from: string, to: string, _dep: Dependency): void {
    const fromIdx = this.nameToFirstIndex.get(from);
    const toIdx = this.nameToFirstIndex.get(to);
    if (fromIdx !== undefined && toIdx !== undefined) {
      this.edges.get(fromIdx)?.add(toIdx);
    }
  }

  /**
   * Add a dependency edge by index (internal use)
   */
  addDependencyByIndex(fromIndex: number, toIndex: number): void {
    this.edges.get(fromIndex)?.add(toIndex);
  }

  /**
   * Get a package by name
   */
  getPackage(name: string): Package | undefined {
    const index = this.nameToFirstIndex.get(name);
    return index !== undefined ? this.packages[index] : undefined;
  }

  /**
   * Get all packages (including same-name duplicates for diamond deps)
   * ORIGINAL: builder.rs - DiGraph.node_indices() returns all nodes
   */
  getAllPackages(): Package[] {
    return this.packages;
  }

  /**
   * Create unique IDs for all packages (suffix for same-name packages)
   * ORIGINAL: builder.rs:232-265 - create_ids()
   * Returns Map from index to unique ID (like BiBTreeMap<PackageID, NodeIndex>)
   */
  createIds(): Map<number, string> {
    const nameToSuffix = new Map<string, number>();
    const indexToId = new Map<number, string>();

    // Iterate all nodes in order
    // ORIGINAL: for node in graph.node_indices()
    for (let index = 0; index < this.packages.length; index++) {
      const pkg = this.packages[index];
      if (!pkg) continue;

      const name = pkg.id.name;
      const suffix = nameToSuffix.get(name) ?? 0;

      // ORIGINAL: if *suffix == 0 { name.to_string() } else { format!("{}_{suffix}", name) }
      const id = suffix === 0 ? name : `${name}_${suffix}`;

      indexToId.set(index, id);
      nameToSuffix.set(name, suffix + 1);
    }

    return indexToId;
  }

  /**
   * Get package by index (for diamond dependency support)
   * ORIGINAL: builder.rs:289 - Packages are accessed by NodeIndex
   */
  getPackageByIndex(index: number): Package | undefined {
    return this.packages[index];
  }

  /**
   * Get immediate dependencies of a package by index
   */
  getImmediateDependenciesOf(index: number): Set<number> {
    return this.edges.get(index) || new Set();
  }

  /**
   * Get immediate dependencies of a package by name (legacy compatibility)
   */
  getImmediateDependencies(packageName: string): Set<string> {
    const index = this.nameToFirstIndex.get(packageName);
    if (index === undefined) return new Set();
    const depIndices = this.edges.get(index) || new Set();
    const result = new Set<string>();
    for (const idx of depIndices) {
      if (this.packages[idx]) {
        result.add(this.packages[idx].id.name);
      }
    }
    return result;
  }

  /**
   * Collect all transitive dependencies using depth-first search
   */
  getTransitiveDependencies(packageName: string): Set<string> {
    const result = new Set<string>();
    const visited = new Set<string>();

    const dfs = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      result.add(name);

      const index = this.nameToFirstIndex.get(name);
      if (index !== undefined) {
        const deps = this.edges.get(index);
        if (deps) {
          for (const depIdx of deps) {
            if (this.packages[depIdx]) {
              dfs(this.packages[depIdx].id.name);
            }
          }
        }
      }
    };

    dfs(packageName);
    result.delete(packageName); // Don't include self

    return result;
  }

  /**
   * Get packages in strict topological dependency order
   *
   * ORIGINAL SOURCE REFERENCE: move-package-alt/src/graph/mod.rs:120-124
   *
   * Implementation:
   * - Uses petgraph::algo::toposort() which produces DFS post-order
   * - Dependencies are visited BEFORE dependents
   * - Tie-breaking: alphabetical order (from BTreeMap insertion order)
   *
   * Input: Dependency graph rooted at this.root
   * Output: Array of package names in topological order (root excluded)
   *
   * CRITICAL: This MUST match Sui CLI's compilation order.
   */
  topologicalOrder(): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    // Helper for Post-Order DFS
    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);

      const index = this.nameToFirstIndex.get(name);
      if (index !== undefined) {
        const depIndices = this.edges.get(index);
        if (depIndices) {
          const depNames = Array.from(depIndices)
            .map((idx) => this.packages[idx]?.id.name)
            .filter((n): n is string => n !== undefined)
            .sort();
          for (const dep of depNames) {
            visit(dep);
          }
        }
      }

      // Post-order: Add self after dependencies
      result.push(name);
    };

    // We only care about packages reachable from root
    visit(this.root);

    // Filter out root itself if it's in the list (usually we want deps for root)
    return result.filter((n) => n !== this.root);
  }

  /**
   * Get packages in Compiler Input Order
   *
   * ORIGINAL SOURCE REFERENCE:
   * - move-package-alt/src/graph/mod.rs:120-124 - sorted_packages() uses toposort
   * - move-package-alt/src/graph/builder.rs - BTreeMap gives alphabetical insertion
   * - move-package-alt-compilation/src/compilation.rs - Uses sorted_packages for compile
   *
   * Implementation:
   * - Post-order DFS (same as petgraph::algo::toposort)
   * - Dependencies visited BEFORE dependents (dependency-first order)
   * - Siblings sorted alphabetically (matches BTreeMap insertion order)
   *
   * Input: Dependency graph rooted at this.root
   * Output: Array of unique package IDs including root, in compilation order
   * ORIGINAL: Uses create_ids() result for unique IDs (builder.rs:222)
   */
  compilerInputOrder(): string[] {
    const visited = new Set<number>(); // Use indices, not names
    const resultIndices: number[] = [];

    // Helper for Post-Order DFS by index
    const visitByIndex = (index: number) => {
      if (visited.has(index)) return;
      visited.add(index);

      const depIndices = this.edges.get(index);
      if (depIndices) {
        // Sort dependencies alphabetically for deterministic order
        const sortedDeps = Array.from(depIndices).sort((a, b) => {
          const nameA = this.packages[a]?.id.name || "";
          const nameB = this.packages[b]?.id.name || "";
          return nameA.localeCompare(nameB);
        });
        for (const depIdx of sortedDeps) {
          visitByIndex(depIdx);
        }
      }

      // Post-order: Add index AFTER dependencies
      resultIndices.push(index);
    };

    // Start from root (index 0)
    const rootIndex = this.nameToFirstIndex.get(this.root) ?? 0;
    visitByIndex(rootIndex);

    // Convert indices to unique IDs using createIds
    // ORIGINAL: builder.rs:222 - let package_ids = Self::create_ids(&inner);
    const indexToId = this.createIds();
    const ids = resultIndices.map(
      (idx) => indexToId.get(idx) || this.packages[idx]?.id.name || ""
    );
    return ids;
  }

  /**
   * Get compiler input order with both unique IDs and indices
   * For CompilationDependencies to properly handle diamond deps
   *
   * ORIGINAL: linkage.rs:58-82 - linkage() creates linked PackageGraph
   * ORIGINAL: linkage.rs:169-228 - linkage_ignoring_overrides() with depth tracking
   *
   * CLI linkage behavior:
   * - Traverse dependency tree tracking depth at each node
   * - For same originalId packages, select the one with SMALLEST depth (closest to root)
   * - Create new graph with only the selected packages
   */
  compilerInputOrderWithIndices(): { ids: string[]; indices: number[] } {
    // Phase 1: Build linkage table with depth-based selection
    // ORIGINAL: linkage.rs:169-228 - linkage_ignoring_overrides()
    // Maps originalId -> { depth, index } where smallest depth wins
    const linkageTable = new Map<string, { depth: number; idx: number }>();

    // Recursive DFS with explicit depth parameter
    // ORIGINAL: linkage.rs:188 - pkg.linkage_ignoring_overrides(&local_overrides, depth + 1)
    // NOTE: CLI doesn't use visited set - it compares depth to decide if update needed
    const visitWithDepth = (index: number, depth: number) => {
      const pkg = this.packages[index];
      if (!pkg) return;

      const originalId =
        pkg.manifest.originalId || pkg.manifest.publishedAt || pkg.id.name;

      // Check if we've seen this originalId at a smaller or equal depth
      // If so, no need to continue (already have better or equal path)
      const existing = linkageTable.get(originalId);
      if (existing && existing.depth <= depth) {
        return; // Already have a shorter path to this originalId
      }

      // Update linkage table with current package at this depth
      // ORIGINAL: linkage.rs:222-225 - include self
      linkageTable.set(originalId, { depth, idx: index });

      // Visit dependencies with depth + 1
      // ORIGINAL: linkage.rs:182-188 - for (_, pkg) in self.direct_deps()
      const depIndices = this.edges.get(index);
      if (depIndices) {
        for (const depIdx of depIndices) {
          visitWithDepth(depIdx, depth + 1);
        }
      }
    };

    const rootIndex = this.nameToFirstIndex.get(this.root) ?? 0;
    visitWithDepth(rootIndex, 0);

    // Phase 2: Collect packages in topological order from linkage table
    // ORIGINAL: linkage.rs:86-133 - copy_linked() creates new graph from linkage
    const visitedForOrder = new Set<number>();
    const resultIndices: number[] = [];

    // DFS post-order for topological sort
    const collectInOrder = (index: number) => {
      if (visitedForOrder.has(index)) return;
      visitedForOrder.add(index);

      const pkg = this.packages[index];
      if (!pkg) return;

      // Visit dependencies first
      const depIndices = this.edges.get(index);
      if (depIndices) {
        const sortedDeps = Array.from(depIndices).sort((a, b) => {
          const nameA = this.packages[a]?.id.name || "";
          const nameB = this.packages[b]?.id.name || "";
          return nameA.localeCompare(nameB);
        });

        for (const depIdx of sortedDeps) {
          // For each dependency, follow the linkage (may redirect to different package)
          const depPkg = this.packages[depIdx];
          if (!depPkg) continue;

          const depOriginalId =
            depPkg.manifest.originalId ||
            depPkg.manifest.publishedAt ||
            depPkg.id.name;
          const linkedEntry = linkageTable.get(depOriginalId);
          if (linkedEntry) {
            collectInOrder(linkedEntry.idx);
          }
        }
      }

      // Post-order: add after dependencies
      resultIndices.push(index);
    };

    // Start from root (always included)
    collectInOrder(rootIndex);

    // Remove duplicates (same package may be visited via different paths)
    const uniqueIndices: number[] = [];
    const seenIndices = new Set<number>();
    for (const idx of resultIndices) {
      if (!seenIndices.has(idx)) {
        seenIndices.add(idx);
        uniqueIndices.push(idx);
      }
    }

    const indexToId = this.createIds();
    const ids = uniqueIndices.map(
      (idx) => indexToId.get(idx) || this.packages[idx]?.id.name || ""
    );
    return { ids, indices: uniqueIndices };
  }

  /**
   * Get ALL packages in topological order with indices (NO linkage filtering)
   * Used for lockfile generation which needs all packages including diamond duplicates.
   * ORIGINAL: builder.rs - Lockfile includes all packages, linkage is only for compilation.
   */
  allPackagesOrderWithIndices(): { ids: string[]; indices: number[] } {
    const visitedIndices = new Set<number>();
    const resultIndices: number[] = [];

    // DFS post-order (same as compilerInputOrder, but without linkage filtering)
    const visitByIndex = (index: number) => {
      if (visitedIndices.has(index)) return;
      visitedIndices.add(index);

      const pkg = this.packages[index];
      if (!pkg) return;

      // Visit dependencies first (post-order)
      const depIndices = this.edges.get(index);
      if (depIndices) {
        for (const depIdx of depIndices) {
          visitByIndex(depIdx);
        }
      }
      resultIndices.push(index);
    };

    const rootIndex = this.nameToFirstIndex.get(this.root) ?? 0;
    visitByIndex(rootIndex);

    // Convert indices to unique IDs (no linkage filtering)
    const indexToId = this.createIds();
    const ids = resultIndices.map(
      (idx) => indexToId.get(idx) || this.packages[idx]?.id.name || ""
    );
    return { ids, indices: resultIndices };
  }

  /**
   * DFS-based topological sort (fallback)
   */
  private topologicalOrderDFS(): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);

      const index = this.nameToFirstIndex.get(name);
      if (index !== undefined) {
        const depIndices = this.edges.get(index);
        if (depIndices) {
          for (const depIdx of depIndices) {
            if (this.packages[depIdx]) {
              visit(this.packages[depIdx].id.name);
            }
          }
        }
      }

      result.push(name);
    };

    // Start from root
    visit(this.root);

    // Visit any unvisited packages
    for (const pkg of this.packages) {
      visit(pkg.id.name);
    }

    return result;
  }

  /**
   * Detect cycles in the dependency graph using DFS
   * Returns the cycle path if found, or null if no cycle
   */
  detectCycle(): string[] | null {
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const parent = new Map<string, string>();

    const dfs = (name: string): string[] | null => {
      visited.add(name);
      recStack.add(name);

      const index = this.nameToFirstIndex.get(name);
      if (index !== undefined) {
        const depIndices = this.edges.get(index);
        if (depIndices) {
          for (const depIdx of depIndices) {
            const dep = this.packages[depIdx]?.id.name;
            if (!dep) continue;
            if (!visited.has(dep)) {
              parent.set(dep, name);
              const cycle = dfs(dep);
              if (cycle) return cycle;
            } else if (recStack.has(dep)) {
              const cyclePath = [dep];
              let current = name;
              while (current !== dep) {
                cyclePath.unshift(current);
                current = parent.get(current)!;
              }
              cyclePath.unshift(dep);
              return cyclePath;
            }
          }
        }
      }

      recStack.delete(name);
      return null;
    };

    for (const pkg of this.packages) {
      if (!visited.has(pkg.id.name)) {
        const cycle = dfs(pkg.id.name);
        if (cycle) return cycle;
      }
    }

    return null;
  }

  /**
   * Get the root package
   */
  getRootPackage(): Package | undefined {
    return this.getPackage(this.root);
  }

  /**
   * Get the root package name
   */
  getRootName(): string {
    return this.root;
  }
}
