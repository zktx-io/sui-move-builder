import { parseToml } from "./tomlParser.js";
import type { Fetcher } from "./fetcher.js";

export class Resolver {
  private fetcher: Fetcher;
  private globalAddresses: Record<string, string>;
  private visited: Set<string>;
  private dependencyFiles: Record<string, string>;
  private systemDepsLoaded: Set<string>;

  constructor(fetcher: Fetcher) {
    this.fetcher = fetcher;
    this.globalAddresses = {};
    this.visited = new Set();
    this.dependencyFiles = {};
    this.systemDepsLoaded = new Set();
  }

  async resolve(
    rootMoveToml: string,
    rootFiles: Record<string, string>
  ): Promise<{ files: string; dependencies: string }> {
    const parsedToml = parseToml(rootMoveToml);

    if (parsedToml.addresses) {
      this.mergeAddresses(parsedToml.addresses);
    }

    if (parsedToml.dependencies) {
      await this.resolveDeps(parsedToml.dependencies);
    }
    await this.injectSystemDeps(parsedToml.dependencies);

    const finalMoveToml = this.reconstructMoveToml(parsedToml, this.globalAddresses);
    const finalFiles = { ...rootFiles, "Move.toml": finalMoveToml };

    return {
      files: JSON.stringify(finalFiles),
      dependencies: JSON.stringify(this.dependencyFiles),
    };
  }

  private mergeAddresses(addresses: Record<string, string>) {
    for (const [name, val] of Object.entries(addresses)) {
      this.globalAddresses[name] = this.normalizeAddress(val);
    }
  }

  private normalizeAddress(addr: string) {
    if (!addr) return addr;
    let clean = addr;
    if (clean.startsWith("0x")) clean = clean.slice(2);
    if (/^[0-9a-fA-F]+$/.test(clean)) {
      return "0x" + clean.padStart(64, "0");
    }
    return addr;
  }

  private async resolveDeps(
    depsObj: Record<string, any>,
    parentContext: { git?: string; rev?: string; subdir?: string } | null = null
  ) {
    for (const [name, depInfo] of Object.entries(depsObj)) {
      let gitUrl: string | undefined;
      let rev: string | undefined;
      let subdir: string | undefined;

      if ((depInfo as any).git) {
        gitUrl = (depInfo as any).git;
        rev = (depInfo as any).rev;
        subdir = (depInfo as any).subdir;
      } else if ((depInfo as any).local) {
        if (!parentContext) continue;
        gitUrl = parentContext.git;
        rev = parentContext.rev;
        subdir = this.resolvePath(parentContext.subdir || "", (depInfo as any).local);
      } else {
        continue;
      }

      const cacheKey = `${gitUrl}|${rev}|${subdir || ""}`;
      if (this.visited.has(cacheKey)) continue;
      this.visited.add(cacheKey);

      const files = await this.fetcher.fetch(gitUrl!, rev!, subdir);

      let pkgMoveToml: string | null = null;
      for (const [path, content] of Object.entries(files)) {
        if (path.endsWith("Move.toml")) {
          pkgMoveToml = content;
          break;
        }
      }

      if (pkgMoveToml) {
        const parsed = parseToml(pkgMoveToml);
        if (parsed.addresses) {
          this.mergeAddresses(parsed.addresses);
        }
        if (parsed.dependencies) {
          await this.resolveDeps(parsed.dependencies, { git: gitUrl, rev, subdir });
        }
      }

      for (const [path, content] of Object.entries(files)) {
        if (path.endsWith(".move") || path.endsWith("Move.toml")) {
          const targetPath = `dependencies/${name}/${path}`;
          this.dependencyFiles[targetPath] = content;
        }
      }
    }
  }

  private resolvePath(base: string, relative: string): string {
    const stack = base.split("/").filter((p) => p && p !== ".");
    const parts = relative.split("/").filter((p) => p && p !== ".");
    for (const part of parts) {
      if (part === "..") {
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    return stack.join("/");
  }

  private reconstructMoveToml(originalParsed: any, addresses: Record<string, string>) {
    let newToml = `[package]\nname = "${originalParsed.package.name}"\nversion = "${originalParsed.package.version}"\n`;
    if (originalParsed.package.edition) {
      newToml += `edition = "${originalParsed.package.edition}"\n`;
    }

    newToml += `\n[dependencies]\n`;
    if (originalParsed.dependencies) {
      for (const [name, info] of Object.entries(originalParsed.dependencies)) {
        newToml += `${name} = { git = "${(info as any).git}", rev = "${(info as any).rev}" }\n`;
      }
    }

    newToml += `\n[addresses]\n`;
    for (const [addrName, addrVal] of Object.entries(addresses)) {
      newToml += `${addrName} = "${addrVal}"\n`;
    }
    return newToml;
  }

  private async injectSystemDeps(depsObj?: Record<string, any>) {
    if (depsObj) {
      for (const depInfo of Object.values(depsObj)) {
        if (!depInfo || !(depInfo as any).git || !(depInfo as any).rev) continue;
        if (!this.isSuiRepo((depInfo as any).git)) continue;
        await this.addImplicitSystemDepsForRepo((depInfo as any).git, (depInfo as any).rev);
        break;
      }
    }

    const hasMoveStdlib = Boolean(this.dependencyFiles["dependencies/MoveStdlib/Move.toml"]);
    if (!hasMoveStdlib) {
      this.addFallbackSystemDeps();
    }
  }

  private async addImplicitSystemDepsForRepo(gitUrl: string, rev: string) {
    if (!this.isSuiRepo(gitUrl)) return;
    const cacheKey = `${gitUrl}|${rev}`;
    if (this.systemDepsLoaded.has(cacheKey)) return;
    this.systemDepsLoaded.add(cacheKey);

    const manifestPath = "crates/sui-framework-snapshot/manifest.json";
    if (!(this.fetcher as any).fetchFile) return;

    let packages: { name: string; id: string }[] | null = null;
    try {
      const manifestText = await (this.fetcher as any).fetchFile(gitUrl, rev, manifestPath);
      if (manifestText) {
        const manifest = JSON.parse(manifestText);
        const versions = Object.keys(manifest)
          .map((v) => Number(v))
          .filter((v) => !Number.isNaN(v))
          .sort((a, b) => a - b);
        const latestVersion = versions[versions.length - 1];
        const latest = manifest[String(latestVersion)];
        if (latest && latest.packages) {
          packages = latest.packages;
        }
      }
    } catch (e) {}

    if (!packages) {
      packages = this.fallbackSystemPackages();
    }

    for (const pkg of packages) {
      if (!pkg || !pkg.name || !pkg.id) continue;
      if (pkg.name === "DeepBook") continue;
      this.addSystemDep(pkg.name, pkg.id);
    }
  }

  private addFallbackSystemDeps() {
    for (const pkg of this.fallbackSystemPackages()) {
      if (!pkg || !pkg.name || !pkg.id) continue;
      if (pkg.name === "DeepBook") continue;
      this.addSystemDep(pkg.name, pkg.id);
    }
  }

  private addSystemDep(name: string, id: string) {
    const targetPath = `dependencies/${name}/Move.toml`;
    if (this.dependencyFiles[targetPath]) return;
    const moveToml = [
      "[package]",
      `name = "${name}"`,
      'version = "0.0.0"',
      `published-at = "${this.normalizeAddress(id)}"`,
      "",
    ].join("\n");
    this.dependencyFiles[targetPath] = moveToml;
  }

  private fallbackSystemPackages(): { name: string; id: string }[] {
    return [
      { name: "MoveStdlib", id: "0x1" },
      { name: "Sui", id: "0x2" },
      { name: "SuiSystem", id: "0x3" },
      { name: "Bridge", id: "0xb" },
    ];
  }

  private isSuiRepo(gitUrl: string): boolean {
    return gitUrl.includes("github.com/MystenLabs/sui");
  }
}

export async function resolve(
  rootMoveTomlContent: string,
  rootSourceFiles: Record<string, string>,
  fetcher: Fetcher
): Promise<{ files: string; dependencies: string }> {
  const resolver = new Resolver(fetcher);
  return resolver.resolve(rootMoveTomlContent, rootSourceFiles);
}
