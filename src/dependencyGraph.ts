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
  private alwaysDeps: Set<string> = new Set([
    "Sui",
    "MoveStdlib",
    "SuiSystem",
    "Bridge",
  ]);

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
   * Get packages in dependency order from Move.lock
   *
   * CRITICAL: This MUST return the exact order from Move.lock's [[move.package]] array!
   * DO NOT sort alphabetically! See CRITICAL_RULES.md
   */
  topologicalOrder(): string[] {
    // If we don't have lockfile order (e.g., Move.lock v0 or missing), fall back to DFS ordering.
    if (!this.lockfileOrder.length) {
      const dfsOrder = this.topologicalOrderDFS();
      return dfsOrder.filter((n) => n !== this.root);
    }

    // Return Move.lock order for reachable packages only

    // Get all packages that are reachable from root (i.e., actually used)
    const reachable = new Set<string>();
    const visited = new Set<string>();

    const dfs = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      reachable.add(name);

      const deps = this.graph.get(name);
      if (deps) {
        for (const dep of deps) {
          dfs(dep);
        }
      }
    };

    // Start from root to find all reachable packages
    dfs(this.root);
    const result: string[] = [];
    for (const pkgName of this.lockfileOrder) {
      if (pkgName === this.root) continue; // Skip root package
      if (reachable.has(pkgName)) {
        result.push(pkgName);
      }
    }
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
