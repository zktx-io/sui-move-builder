/**
 * ResolvedGraph Layer (Layer 2)
 *
 * Assigns concrete addresses to all named addresses and creates a unified resolution table.
 * Corresponds to Sui's `resolution/resolution_graph.rs`
 */

import { DependencyGraph, Package } from "./dependencyGraph.js";

export interface BuildConfig {
  devMode?: boolean;
  testMode?: boolean;
  generateDocs?: boolean;
  installDir?: string;
}

/**
 * ResolvedGraph contains the dependency graph with all addresses resolved
 */
export class ResolvedGraph {
  private graph: DependencyGraph;
  private buildConfig: BuildConfig;

  // Unified address resolution table
  // All packages in the dependency tree see the same address mappings
  private unifiedAddressTable: Map<string, string> = new Map();

  // Per-package resolved tables (points to unified table)
  private packageResolvedTables: Map<string, Record<string, string>> =
    new Map();

  constructor(graph: DependencyGraph, buildConfig: BuildConfig = {}) {
    this.graph = graph;
    this.buildConfig = buildConfig;
  }

  /**
   * Resolve all addresses in the dependency graph
   * This creates a unified address mapping that all packages will use
   */
  async resolve(): Promise<void> {
    // Step 1: Collect all address definitions from root + dependencies in topological order
    // dependencyGraph.topologicalOrder() intentionally skips root, so prepend it.
    const rootName = this.graph.getRootName();
    const topoOrder = [rootName, ...this.graph.topologicalOrder()];

    // Step 2: Build unified address table
    // Process in reverse topological order (dependencies first)
    for (const pkgName of topoOrder) {
      const pkg = this.graph.getPackage(pkgName);
      if (!pkg) continue;

      // Merge this package's addresses into the unified table
      for (const [name, addr] of Object.entries(pkg.manifest.addresses)) {
        const normalized = this.normalizeAddress(addr);

        // Check for conflicts
        if (this.unifiedAddressTable.has(name)) {
          const existing = this.unifiedAddressTable.get(name)!;
          if (existing !== normalized) {
            continue;
          }
        }

        this.unifiedAddressTable.set(name, normalized);
      }
    }

    // Step 3: Create per-package resolved tables (all pointing to unified table)
    for (const pkg of this.graph.getAllPackages()) {
      const resolved: Record<string, string> = {};

      // Each package gets the full unified address table
      for (const [name, addr] of this.unifiedAddressTable.entries()) {
        resolved[name] = addr;
      }

      this.packageResolvedTables.set(pkg.id.name, resolved);

      // Also update the package object's resolvedTable
      pkg.resolvedTable = resolved;
    }
  }

  /**
   * Normalize an address to the standard format (0x-prefixed, 64 hex chars)
   */
  private normalizeAddress(addr: string): string {
    if (!addr) return addr;
    let clean = addr.trim();
    if (clean.startsWith("0x")) clean = clean.slice(2);

    // Check if it's a valid hex string
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
      return addr; // Return as-is if not hex (might be a named address reference)
    }

    return "0x" + clean.padStart(64, "0");
  }

  /**
   * Get the unified address table
   */
  getUnifiedAddressTable(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, addr] of this.unifiedAddressTable.entries()) {
      result[name] = addr;
    }
    return result;
  }

  /**
   * Get the resolved address table for a specific package
   */
  getPackageResolvedTable(
    packageName: string
  ): Record<string, string> | undefined {
    return this.packageResolvedTables.get(packageName);
  }

  /**
   * Get the dependency graph
   */
  getGraph(): DependencyGraph {
    return this.graph;
  }

  /**
   * Get topological order of packages
   */
  topologicalOrder(): string[] {
    return this.graph.topologicalOrder();
  }

  /**
   * Get the root package name
   */
  getRootName(): string {
    return this.graph.getRootName();
  }

  /**
   * Get a package by name
   */
  getPackage(name: string): Package | undefined {
    return this.graph.getPackage(name);
  }

  /**
   * Get immediate dependencies of a package
   */
  getImmediateDependencies(packageName: string): Set<string> {
    return this.graph.getImmediateDependencies(packageName);
  }
}
