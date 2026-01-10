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

    // Get all packages in Move.lock order
    const packageOrder = this.resolvedGraph.topologicalOrder();
    // System packages that we exclude when not explicitly needed.
    // Matches observed CLI outputs where Bridge/SuiSystem IDs are omitted.
    const filteredSystemDeps = new Set(["Bridge", "SuiSystem"]);

    // Build DependencyInfo for each package (excluding root)
    for (const pkgName of packageOrder) {
      if (pkgName === this.rootPackageName) {
        continue; // Skip root, it's not a dependency
      }

      const pkg = this.resolvedGraph.getPackage(pkgName);
      if (!pkg) continue;

      // Skip unused system packages that the CLI does not surface in dependency IDs.
      if (filteredSystemDeps.has(pkgName)) {
        continue;
      }

      const files = packageFiles.get(pkgName) || {};
      const sourcePaths = this.extractSourcePaths(pkgName, files);

      // Use each package's own edition (don't force global edition)
      const effectiveEdition = pkg.manifest.edition || "legacy";

      // Dependency ID for output: latest > original > published-at/address mapping
      const publishedIdForOutput =
        pkg.manifest.latestPublishedId ||
        pkg.manifest.originalId ||
        pkg.manifest.publishedAt ||
        pkg.resolvedTable?.[pkgName];

      const depInfo: DependencyInfo = {
        name: pkgName,
        isImmediate: immediateDeps.has(pkgName),
        sourcePaths,
        addressMapping: pkg.resolvedTable || {},
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
   * Extract .move source file paths from a package's files
   */
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
      const ax = encoder.encode(x);
      const ay = encoder.encode(y);
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
    const packageSection: string[] = [];
    const dependenciesSection: string[] = [];
    let inPackage = false;
    let inDependencies = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[package]")) {
        inPackage = true;
        inDependencies = false;
        continue;
      }
      if (trimmed.startsWith("[dependencies]")) {
        inPackage = false;
        inDependencies = true;
        continue;
      }
      if (trimmed.startsWith("[")) {
        inPackage = false;
        inDependencies = false;
        continue;
      }
      if (inPackage && trimmed) packageSection.push(line);
      if (inDependencies && trimmed) dependenciesSection.push(line);
    }

    let result = "[package]\n";
    let hasName = false;
    let hasVersion = false;

    for (const line of packageSection) {
      if (line.includes("name =")) {
        result += line + "\n";
        hasName = true;
      } else if (line.includes("version =")) {
        result += line + "\n";
        hasVersion = true;
      } else if (line.includes("edition =")) {
        continue; // we will add edition below
      } else {
        result += line + "\n";
      }
    }
    if (!hasName) result += `name = "${packageName}"\n`;
    if (!hasVersion) result += 'version = "0.0.0"\n';
    result += `edition = "${edition}"\n`;

    result += "\n[dependencies]\n";
    for (const line of dependenciesSection) {
      result += line + "\n";
    }

    result += "\n[addresses]\n";
    for (const [name, addr] of Object.entries(addresses)) {
      result += `${name} = "${addr}"\n`;
    }
    return result;
  }
}
