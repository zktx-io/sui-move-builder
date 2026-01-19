/**
 * DependencyGraph Layer (Layer 1)
 *
 * Builds a directed acyclic graph (DAG) of all packages and their relationships.
 * Corresponds to Sui's `resolution/dependency_graph.rs`
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

export interface Package {
  id: PackageIdentifier;
  manifest: PackageManifest;
  dependencies: Map<string, Dependency>;
  devDependencies: Map<string, Dependency>;
  resolvedTable?: Record<string, string>; // Will be filled in ResolvedGraph
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
 */
export class DependencyGraph {
  // Map from package name to Package
  private packageTable: Map<string, Package> = new Map();

  // Adjacency list: package name -> set of dependency names
  private graph: Map<string, Set<string>> = new Map();

  // Packages that should always be included (system packages)
  private alwaysDeps: Set<string> = new Set(["Sui", "MoveStdlib"]);

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
   */
  addPackage(pkg: Package): void {
    this.packageTable.set(pkg.id.name, pkg);
    if (!this.graph.has(pkg.id.name)) {
      this.graph.set(pkg.id.name, new Set());
    }
  }

  /**
   * Add a dependency edge from source package to dependency package
   */
  addDependency(from: string, to: string, _dep: Dependency): void {
    if (!this.graph.has(from)) {
      this.graph.set(from, new Set());
    }
    this.graph.get(from)!.add(to);
  }

  /**
   * Get a package by name
   */
  getPackage(name: string): Package | undefined {
    return this.packageTable.get(name);
  }

  /**
   * Get all packages
   */
  getAllPackages(): Package[] {
    return Array.from(this.packageTable.values());
  }

  /**
   * Get immediate dependencies of a package
   */
  getImmediateDependencies(packageName: string): Set<string> {
    return this.graph.get(packageName) || new Set();
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

      const deps = this.graph.get(name);
      if (deps) {
        for (const dep of deps) {
          dfs(dep);
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
   * CRITICAL: This MUST match Sui CLI's compilation order.
   * Logic:
   * 1. Dependencies MUST come before their dependents (Post-Order DFS).
   * 2. Tie-breaking: Sort siblings by Package Name (alphabetical) before traversing.
   * 3. Move.lock list order is arbitrary/alphabetical and CANNOT be used as topological order.
   */
  topologicalOrder(): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    // Helper for Post-Order DFS
    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);

      const deps = this.graph.get(name);
      if (deps) {
        // Sort dependencies alphabetically to ensure deterministic transversal
        const sortedDeps = Array.from(deps).sort();
        for (const dep of sortedDeps) {
          visit(dep);
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
   * Get packages in Compiler Input Order (Pre-order DFS)
   * CORRESPONDS TO: `move-package-alt` FilteredGraph construction.
   * Logic:
   * 1. Root is visited first.
   * 2. Dependencies (neighbors) are visited recursively.
   * 3. Neighbors are visited in Alphabetical Order.
   *
   * This structure (Root -> A -> B...) is what `move-package-alt-compilation` expects.
   */
  compilerInputOrder(): string[] {
    // ORIGINAL CLI SOURCE:
    // Analysis of test failure shows that `Move.lock` order (Alphabetical) violates topological dependencies.
    // In `external-crates/move/crates/move-package-alt/src/graph/mod.rs`, the construction of the `filtered_graph`
    // utilizes `petgraph::algo::toposort` (via `check_cycles` and eventual linearization), which ensures that
    // compilation proceeds in a topological order (Dependencies first).
    // Given the alphabetical insertion order in `builder.rs`, `petgraph`'s toposort (DFS-based) naturally follows
    // a Post-order traversal where neighbors are visited in insertion (alphabetical) order.

    const visited = new Set<string>();
    const result: string[] = [];

    // Helper for Post-Order DFS
    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name); // Mark as visited to prevent cycles/re-visits

      const deps = this.graph.get(name);
      if (deps) {
        // Sort dependencies alphabetically to ensure deterministic neighbor traversal
        // matching the alphabetical insertion order in `builder.rs`.
        const sortedDeps = Array.from(deps).sort();
        for (const dep of sortedDeps) {
          visit(dep);
        }
      }

      // Post-order: Add self AFTER dependencies have been visited
      result.push(name);
    };

    visit(this.root);
    return result;
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

      const deps = this.graph.get(name);
      if (deps) {
        for (const dep of Array.from(deps)) {
          visit(dep);
        }
      }

      result.push(name);
    };

    // Start from root
    visit(this.root);

    // Visit any unvisited packages
    for (const name of this.packageTable.keys()) {
      visit(name);
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

      const deps = this.graph.get(name);
      if (deps) {
        for (const dep of deps) {
          if (!visited.has(dep)) {
            parent.set(dep, name);
            const cycle = dfs(dep);
            if (cycle) return cycle;
          } else if (recStack.has(dep)) {
            // Found a cycle, reconstruct the path
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

      recStack.delete(name);
      return null;
    };

    for (const name of this.packageTable.keys()) {
      if (!visited.has(name)) {
        const cycle = dfs(name);
        if (cycle) return cycle;
      }
    }

    return null;
  }

  /**
   * Get the root package
   */
  getRootPackage(): Package | undefined {
    return this.packageTable.get(this.root);
  }

  /**
   * Get the root package name
   */
  getRootName(): string {
    return this.root;
  }

  /**
   * Check if a package is a system package that should always be included
   */
  isAlwaysDep(name: string): boolean {
    return this.alwaysDeps.has(name);
  }
}
