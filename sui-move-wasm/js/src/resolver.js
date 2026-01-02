import { parseToml } from "./toml_parser.js";

export class Resolver {
  constructor(fetcher) {
    this.fetcher = fetcher;
    // Global address map to be merged from all dependencies
    this.globalAddresses = {};
    // Cache to prevent re-fetching the same dependency
    this.visited = new Set();
    // Flattened list of all dependency files
    this.dependencyFiles = {};
    // Cache to avoid re-loading system deps per repo+rev
    this.systemDepsLoaded = new Set();
  }

  /**
   * Main entry point to resolve current project.
   */
  async resolve(rootMoveToml, rootFiles) {
    // 1. Parse root Move.toml
    const parsedToml = parseToml(rootMoveToml);

    // 2. Initialize address map with root addresses
    if (parsedToml.addresses) {
      this._mergeAddresses(parsedToml.addresses);
    }

    // 3. Resolve dependencies recursively
    if (parsedToml.dependencies) {
      await this._resolveDeps(parsedToml.dependencies);
      await this._injectSystemDepsFromRoot(parsedToml.dependencies);
    }

    // 4. Construct output
    const finalMoveToml = this._reconstructMoveToml(
      parsedToml,
      this.globalAddresses
    );

    const finalFiles = { ...rootFiles };
    finalFiles["Move.toml"] = finalMoveToml;

    return {
      files: JSON.stringify(finalFiles),
      dependencies: JSON.stringify(this.dependencyFiles),
    };
  }

  _mergeAddresses(addresses) {
    for (const [name, val] of Object.entries(addresses)) {
      this.globalAddresses[name] = this._normalizeAddress(val);
    }
  }

  _normalizeAddress(addr) {
    if (!addr) return addr;
    // Keep string logic simple: if it looks like hex, pad to 64 chars (32 bytes)
    // Sui addresses are 32 bytes.
    let clean = addr;
    if (clean.startsWith("0x")) clean = clean.slice(2);

    // If it's a hex string (simple check)
    if (/^[0-9a-fA-F]+$/.test(clean)) {
      // Pad to 64 hex characters (32 bytes)
      return "0x" + clean.padStart(64, "0");
    }
    return addr;
  }

  /**
   * @param {Object} depsObj - Dependencies from Move.toml
   * @param {Object} parentContext - { git, rev, subdir } of the package defining these deps
   */
  async _resolveDeps(depsObj, parentContext = null) {
    for (const [name, depInfo] of Object.entries(depsObj)) {
      let gitUrl, rev, subdir;

      if (depInfo.git) {
        // Remote git dependency
        gitUrl = depInfo.git;
        rev = depInfo.rev;
        subdir = depInfo.subdir;
      } else if (depInfo.local) {
        // Local dependency (relative to parent)
        if (!parentContext) {
          // Skip local dependency when we don't have a git context.
          continue;
        }
        gitUrl = parentContext.git;
        rev = parentContext.rev;

        // Resolve relative path
        // e.g. parent: crates/sui-framework, local: ../move-stdlib
        subdir = this._resolvePath(parentContext.subdir || "", depInfo.local);
      } else {
        // Skip unknown dependency type.
        continue;
      }

      // Identifier for caching: url + rev + subdir
      const cacheKey = `${gitUrl}|${rev}|${subdir || ""}`;

      if (this.visited.has(cacheKey)) {
        continue;
      }
      this.visited.add(cacheKey);

      // Fetch package content
      const files = await this.fetcher.fetch(gitUrl, rev, subdir);

      // Detect Move.toml in the fetched package to learn about IT's dependencies and addresses
      let pkgMoveToml = null;
      // Try to find Move.toml in the fetched files
      // The fetcher should return paths relative to the fetched root.
      for (const [path, content] of Object.entries(files)) {
        if (path.endsWith("Move.toml")) {
          pkgMoveToml = content;
          break;
        }
      }

      if (pkgMoveToml) {
        const parsed = parseToml(pkgMoveToml);

        // Merge addresses
        if (parsed.addresses) {
          this._mergeAddresses(parsed.addresses);
        }

        // Recursive resolve
        if (parsed.dependencies) {
          // Pass current package info as parent context
          await this._resolveDeps(parsed.dependencies, {
            git: gitUrl,
            rev,
            subdir,
          });
        }
      }

      // Add sources to dependencyFiles
      // We prefix them to avoid collisions and simulate a structure
      // e.g., dependencies/<Name>/...
      for (const [path, content] of Object.entries(files)) {
        // Filter for .move files and Move.toml
        if (path.endsWith(".move") || path.endsWith("Move.toml")) {
          const targetPath = `dependencies/${name}/${path}`;
          this.dependencyFiles[targetPath] = content;
        }
      }
    }
  }

  _resolvePath(base, relative) {
    // Simple relative path resolver
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

  _reconstructMoveToml(originalParsed, addresses) {
    // Simple TOML reconstruction for [addresses]
    // In a real app, use a library that preserves comments/structure, or just append needed addresses.
    // Here we will just regenerate the [addresses] section.

    let newToml = `[package]\nname = "${originalParsed.package.name}"\nversion = "${originalParsed.package.version}"\n`;
    if (originalParsed.package.edition) {
      newToml += `edition = "${originalParsed.package.edition}"\n`;
    }

    // Re-add dependencies section from original (for display/completeness, though WASM ignores it)
    newToml += `\n[dependencies]\n`;
    if (originalParsed.dependencies) {
      for (const [name, info] of Object.entries(originalParsed.dependencies)) {
        // simplify output for now
        newToml += `${name} = { git = "${info.git}", rev = "${info.rev}" }\n`;
      }
    }

    newToml += `\n[addresses]\n`;
    for (const [addrName, addrVal] of Object.entries(addresses)) {
      newToml += `${addrName} = "${addrVal}"\n`;
    }

    return newToml;
  }

  async _injectSystemDepsFromRoot(depsObj) {
    for (const depInfo of Object.values(depsObj)) {
      if (!depInfo || !depInfo.git || !depInfo.rev) {
        continue;
      }
      if (!this._isSuiRepo(depInfo.git)) {
        continue;
      }
      await this._addImplicitSystemDepsForRepo(depInfo.git, depInfo.rev);
      return;
    }
  }

  async _addImplicitSystemDepsForRepo(gitUrl, rev) {
    if (!this._isSuiRepo(gitUrl)) {
      return;
    }

    const cacheKey = `${gitUrl}|${rev}`;
    if (this.systemDepsLoaded.has(cacheKey)) {
      return;
    }
    this.systemDepsLoaded.add(cacheKey);

    const manifestPath = "crates/sui-framework-snapshot/manifest.json";
    if (!this.fetcher.fetchFile) {
      return;
    }

    let manifestText = null;
    try {
      manifestText = await this.fetcher.fetchFile(gitUrl, rev, manifestPath);
    } catch (e) {}
    let packages = null;
    if (manifestText) {
      try {
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
      } catch (e) {}
    }

    if (!packages) {
      packages = [
        {
          name: "MoveStdlib",
          id: "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
        {
          name: "Sui",
          id: "0x0000000000000000000000000000000000000000000000000000000000000002",
        },
        {
          name: "SuiSystem",
          id: "0x0000000000000000000000000000000000000000000000000000000000000003",
        },
        {
          name: "Bridge",
          id: "0x000000000000000000000000000000000000000000000000000000000000000b",
        },
      ];
    }

    for (const pkg of packages) {
      if (!pkg || !pkg.name || !pkg.id) continue;
      if (pkg.name === "DeepBook") {
        continue;
      }
      const targetPath = `dependencies/${pkg.name}/Move.toml`;
      if (this.dependencyFiles[targetPath]) {
        continue;
      }
      const moveToml = [
        "[package]",
        `name = "${pkg.name}"`,
        'version = "0.0.0"',
        `published-at = "${pkg.id}"`,
        "",
      ].join("\n");
      this.dependencyFiles[targetPath] = moveToml;
    }
  }

  _isSuiRepo(gitUrl) {
    return gitUrl.includes("github.com/MystenLabs/sui");
  }
}
