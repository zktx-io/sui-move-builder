/**
 * CompilationDependencies Layer (Layer 3)
 *
 * Converts the resolved graph into compiler-ready dependency information.
 * Corresponds to Sui's `compilation/build_plan.rs`
 */

import { ResolvedGraph } from "./resolvedGraph.js";

interface PackageConfig {
  edition: string;
  flavor: "sui" | "move";
}

export interface PackageGroupedFormat {
  name: string;
  files: Record<string, string>;
  edition?: string;
  addressMapping?: Record<string, string>;
  /** Dependency ID for output (prefer latest published ID) */
  publishedIdForOutput?: string;
}

type ModuleFormat = "Source" | "Bytecode";

/**
 * DependencyInfo contains all information needed to compile a single dependency
 */
interface DependencyInfo {
  /** Package name */
  name: string;

  /** Whether this is an immediate dependency (vs transitive) */
  isImmediate: boolean;

  /** All .move source file paths for this package */
  sourcePaths: string[];

  /** Resolved address mapping (points to unified table) */
  addressMapping: Record<string, string>;

  /** Compiler configuration for this package */
  compilerConfig: PackageConfig;

  /** Whether this dependency is available as source or bytecode */
  moduleFormat: ModuleFormat;

  /** Package edition */
  edition: string;

  /** ID to emit in dependencies list (latest preferred) */
  publishedIdForOutput?: string;
}

/**
 * CompilationDependencies contains the list of all dependencies ready for compilation
 */
export class CompilationDependencies {
  private resolvedGraph: ResolvedGraph;
  private rootPackageName: string;
  private dependencies: DependencyInfo[] = [];

  constructor(resolvedGraph: ResolvedGraph) {
    this.resolvedGraph = resolvedGraph;
    this.rootPackageName = resolvedGraph.getRootName();
  }

  /**
   * Compute all dependencies in compilation order
   */
  async compute(
    packageFiles: Map<string, Record<string, string>>
  ): Promise<void> {
    const rootPkg = this.resolvedGraph.getPackage(this.rootPackageName);
    if (!rootPkg) {
      throw new Error(`Root package '${this.rootPackageName}' not found`);
    }

    // Get immediate dependencies of root
    const immediateDeps = this.resolvedGraph.getImmediateDependencies(
      this.rootPackageName
    );

    const packageOrder = this.resolvedGraph.compilerInputOrder();

    // Registry of build IDs (addresses) assigned to each package.
    // This allows us to propagate dummy addresses (assigned to unpublished dependencies)
    // to their dependents, ensuring consistent address resolution across the graph.
    const packageBuildIds = new Map<string, string>();

    // System packages that we exclude when not explicitly needed.
    // Matches observed CLI outputs where Bridge/SuiSystem IDs are omitted.
    // Build DependencyInfo for each package (excluding root)
    for (const pkgName of packageOrder) {
      if (pkgName === this.rootPackageName) {
        continue; // Skip root, it's not a dependency
      }

      const pkg = this.resolvedGraph.getPackage(pkgName);
      if (!pkg) continue;

      const files = packageFiles.get(pkgName) || {};
      const sourcePaths = this.extractSourcePaths(pkgName, files);

      // Use each package's own edition (don't force global edition)
      const effectiveEdition = pkg.manifest.edition || "legacy";

      // Dependency ID for output: latest > original > published-at/address mapping
      // Dependency ID for output: latest > original > published-at/address mapping
      let publishedIdForOutput =
        pkg.manifest.latestPublishedId ||
        pkg.manifest.originalId ||
        pkg.manifest.publishedAt ||
        pkg.resolvedTable?.[pkgName];

      // Address for build (compilation): original > published-at > latest
      // ORIGINAL CLI SOURCE:
      // In `external-crates/move/crates/move-package-alt-compilation/src/compilation.rs`, the compilation logic
      // constructs the `PackagePaths` using `PackageInfo` which prioritizes the explicit address in the manifest
      // (the "original" address) over other sources to ensuring deterministic builds across environments.
      let buildId =
        pkg.manifest.originalId ||
        pkg.manifest.publishedAt ||
        pkg.manifest.latestPublishedId ||
        publishedIdForOutput;

      // FIX: If buildId is 0x0 (unpublished), we strictly pass 0x0 to the compiler,
      // matching the CLI behavior which uses AccountAddress::ZERO for unpublished deps.
      if (!buildId) {
        buildId = "0x0000000000000000000000000000000000000000000000000000000000000000";
        publishedIdForOutput = buildId;
      }

      // Store the definitive build ID for this package
      packageBuildIds.set(pkgName, buildId);
      packageBuildIds.set(pkgName.toLowerCase(), buildId);

      const addressMapping = { ...(pkg.resolvedTable || {}) };

      // Update addressMapping with the definitive build IDs of known dependencies.
      // This ensures that if a dependency was assigned a dummy address, its dependents see it.
      for (const [depName, depAddr] of Object.entries(addressMapping)) {
        // Check if we have a calculated build ID for this dependency (case-insensitive lookup)
        // Prioritize exact match, then lowercase
        const knownBuildId =
          packageBuildIds.get(depName) ||
          packageBuildIds.get(depName.toLowerCase());
        if (knownBuildId) {
          addressMapping[depName] = knownBuildId;
        }
      }

      // Ensure specific linkage - SKIP system packages to avoid regressions
      if (buildId && pkgName !== "Sui" && pkgName !== "MoveStdlib") {
        // Force set the package name and alias to the build ID
        // This ensures that even if Move.toml doesn't list itself in [addresses],
        // it gets defined in the reconstructed TOML.
        addressMapping[pkgName] = buildId;
        addressMapping[pkgName.toLowerCase()] = buildId;
      }

      const depInfo: DependencyInfo = {
        name: pkgName,
        isImmediate: immediateDeps.has(pkgName),
        sourcePaths,
        addressMapping,
        compilerConfig: {
          edition: effectiveEdition,
          flavor: "sui",
        },
        moduleFormat: sourcePaths.length > 0 ? "Source" : "Bytecode",
        edition: effectiveEdition,
        publishedIdForOutput,
      };

      this.dependencies.push(depInfo);
    }
  }
  /**
   * Get the published ID for a specific dependency by name.
   */
  getDependencyAddress(name: string): string | undefined {
    return this.dependencies.find((d) => d.name === name)?.publishedIdForOutput;
  }

  private extractSourcePaths(
    packageName: string,
    files: Record<string, string>
  ): string[] {
    const sourcePaths = Object.keys(files).filter((path) => {
      if (path.endsWith("Move.toml") || path.endsWith("Move.lock"))
        return false;
      return path.endsWith(".move");
    });

    // Match CLI behavior: deterministic bytewise lexicographic ordering (like BTreeSet).
    const encoder = new TextEncoder();
    const byteCompare = (x: string, y: string): number => {
      // Prefix with a pseudo-root so relative paths sort like CLI absolute paths.
      const ax = encoder.encode(`/vfs/deps/${packageName}/${x}`);
      const ay = encoder.encode(`/vfs/deps/${packageName}/${y}`);
      const len = Math.min(ax.length, ay.length);
      for (let i = 0; i < len; i++) {
        if (ax[i] !== ay[i]) return ax[i] - ay[i];
      }
      return ax.length - ay.length;
    };

    sourcePaths.sort(byteCompare);

    return sourcePaths;
  }

  /**
   * Convert to new package-grouped format for WASM compiler
   */
  toPackageGroupedFormat(
    allPackageFiles: Map<string, Record<string, string>>
  ): Array<PackageGroupedFormat> {
    const packageGroups: Array<PackageGroupedFormat> = [];

    for (const dep of this.dependencies) {
      const pkgFiles = allPackageFiles.get(dep.name) || {};
      const groupedFiles: Record<string, string> = {};

      for (const [path, content] of Object.entries(pkgFiles)) {
        // Skip Move.lock files
        if (path.endsWith("Move.lock")) {
          continue;
        }

        const depPath = `dependencies/${dep.name}/${path}`;

        if (path.endsWith("Move.toml")) {
          // Reconstruct Move.toml with unified addresses and edition
          groupedFiles[depPath] = this.reconstructDependencyMoveToml(
            dep.name,
            content,
            dep.edition,
            dep.addressMapping
          );
        } else {
          groupedFiles[depPath] = content;
        }
      }

      packageGroups.push({
        name: dep.name,
        files: groupedFiles,
        edition: dep.edition,
        addressMapping: dep.addressMapping,
        publishedIdForOutput: dep.publishedIdForOutput,
      });
    }

    // Sort package groups by name to match Sui CLI behavior (alphabetical order for compiler input)
    // packageGroups.sort((a, b) => a.name.localeCompare(b.name));

    return packageGroups;
  }

  /**
   * Reconstruct a dependency's Move.toml with unified addresses and edition
   */
  private reconstructDependencyMoveToml(
    packageName: string,
    originalMoveToml: string | undefined,
    edition: string,
    addresses: Record<string, string>
  ): string {
    const lines = (originalMoveToml || "").split("\n");
    const preservedLines: string[] = [];

    // Simple state machine
    let currentSection = "none"; // package, addresses, dependencies, other

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("[")) {
        // Detect section
        if (trimmed.startsWith("[package]")) {
          currentSection = "package";
        } else if (trimmed.startsWith("[addresses]")) {
          currentSection = "addresses";
        } else if (
          trimmed.startsWith("[dependencies") ||
          trimmed.startsWith("[dev-dependencies")
        ) {
          currentSection = "dependencies";
          // Skip dependencies in reconstructed TOML.
          // The compiler receives the full dependency graph via the `dependencies` argument (compiled from Move.lock).
          // Keeping incorrect or local paths here causes resolution errors in the VFS.
        } else {
          // Keep other sections (e.g. [env])
          currentSection = "other";
          preservedLines.push(line);
        }
        continue;
      }

      // Handle content based on section
      if (currentSection === "package") {
        if (trimmed.includes("name =") || trimmed.includes("version =")) {
          // We'll reconstruct these
        }
        // Skip valid properties we want to override/control
      } else if (currentSection === "addresses") {
        // Skip existing addresses
        continue;
      } else {
        // Keep everything else (dependencies, comments, empty lines)
        if (currentSection !== "none") {
          preservedLines.push(line);
        }
      }
    }

    // Reconstruct
    let result = "[package]\n";
    result += `name = "${packageName}"\n`;
    result += 'version = "0.0.0"\n'; // Placeholder, irrelevant for local builds usually
    result += `edition = "${edition}"\n`;

    result += "\n";
    result += preservedLines.join("\n");

    result += "\n[addresses]\n";
    result += "\n[addresses]\n";
    const sortedDetails = Object.entries(addresses).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    for (const [name, addr] of sortedDetails) {
      result += `${name} = "${addr}"\n`;
    }

    return result;
  }
}
