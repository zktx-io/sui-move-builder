export interface MovePackageFetchLocalContext {
  dependencyName: string;
  parentPackageName: string;
  parentSource?: {
    type: string;
    git?: string;
    rev?: string;
    subdir?: string;
    local?: string;
  };
  network: "mainnet" | "testnet" | "devnet";
}

/** Abstract interface for fetching package content. */
export class MovePackageFetcher {
  /**
   * Optional host-provided local package loader.
   *
   * Browser callers should implement this with a supplied snapshot,
   * File System Access API, or a server endpoint. The library does not read the
   * host filesystem directly.
   */
  fetchLocal?: (
    localPath: string,
    context: MovePackageFetchLocalContext
  ) => Promise<Record<string, string>>;

  /** Fetch a package. Return map of path -> content. */
  async fetch(
    _gitUrl: string,
    _rev: string,
    _subdir?: string
  ): Promise<Record<string, string>> {
    throw new Error("Not implemented");
  }

  /** Fetch a single file from a repository. */
  async fetchFile(
    _gitUrl: string,
    _rev: string,
    _path: string
  ): Promise<string | null> {
    throw new Error("Not implemented");
  }

  /** Get the resolved commit SHA for a git URL and rev (after fetch). */
  getResolvedSha(_gitUrl: string, _rev: string): string | undefined {
    return undefined;
  }
}

/** MovePackageFetcher that retrieves files from public GitHub repositories via fetch(). */
export class GitHubMovePackageFetcher extends MovePackageFetcher {
  private cache: Map<string, string>;
  private treeCache: Map<string, any>; // Cache tree API responses
  private resolvedShaCache: Map<string, string>; // Cache resolved commit SHAs
  private rateLimitRemaining: number = 60; // GitHub unauthenticated limit: 60/hour
  private rateLimitReset: number = 0;
  private token: string | undefined;

  constructor(token?: string) {
    super();
    this.cache = new Map();
    this.treeCache = new Map();
    this.resolvedShaCache = new Map();
    this.token = token;
  }

  /**
   * Get the resolved commit SHA for a git URL and rev.
   * This returns the actual commit SHA that was fetched, resolving tags/branches.
   * Must be called after fetch() to get the resolved SHA.
   */
  getResolvedSha(gitUrl: string, rev: string): string | undefined {
    const { owner, repo } = this.parseGitUrl(gitUrl);
    if (!owner || !repo) return undefined;
    const key = `${owner}/${repo}@${rev}`;
    return this.resolvedShaCache.get(key);
  }

  /**
   * Update rate limit info from response headers
   */
  private updateRateLimit(response: Response) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");

    if (remaining) {
      this.rateLimitRemaining = parseInt(remaining, 10);
    }
    if (reset) {
      this.rateLimitReset = parseInt(reset, 10) * 1000; // Convert to ms
    }

    // no console noise; rate limiting handled silently
  }

  async fetch(
    gitUrl: string,
    rev: string,
    subdir?: string,
    _context?: any
  ): Promise<Record<string, string>> {
    const { owner, repo } = this.parseGitUrl(gitUrl);
    if (!owner || !repo) {
      throw new Error(`Invalid git URL: ${gitUrl}`);
    }

    // Cache key for tree API (same repo/rev shares tree data)
    const treeKey = `${owner}/${repo}@${rev}`;
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${rev}?recursive=1`;

    let treeData: any;

    // Check tree cache first - OPTIMIZATION: Avoid duplicate API calls
    if (this.treeCache.has(treeKey)) {
      treeData = this.treeCache.get(treeKey);
    } else {
      // Retry logic for transient errors (Gateway Timeout, etc.)
      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 1) {
            // Exponential backoff: 1s, 2s, 4s
            const delay = Math.pow(2, attempt - 1) * 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          const headers: HeadersInit = {};
          if (this.token) {
            headers["Authorization"] = `Bearer ${this.token}`;
          }
          const resp = await fetch(treeUrl, { headers });

          // Update rate limit tracking
          this.updateRateLimit(resp);

          if (!resp.ok) {
            if (resp.status === 403 || resp.status === 429) {
              const resetTime = new Date(this.rateLimitReset);
              throw new Error(
                `GitHub API rate limit exceeded. Resets at ${resetTime.toLocaleTimeString()}`
              );
            }
            // For 5xx errors (500-599), retry
            if (
              resp.status >= 500 &&
              resp.status < 600 &&
              attempt < maxRetries
            ) {
              lastError = new Error(`Failed to fetch tree: ${resp.statusText}`);
              continue; // Retry
            }
            throw new Error(`Failed to fetch tree: ${resp.statusText}`);
          }
          treeData = await resp.json();

          // Cache the tree data
          this.treeCache.set(treeKey, treeData);

          // Cache the resolved commit SHA (from treeData.sha or tree response)
          // GitHub tree API returns the actual commit SHA in the response
          if (treeData.sha) {
            this.resolvedShaCache.set(treeKey, treeData.sha);
          }
          break; // Success, exit retry loop
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt === maxRetries) {
            throw lastError;
          }
        }
      }

      if (lastError) {
        throw lastError;
      }
    }

    const files: Record<string, string> = {};
    const fetchPromises: Promise<void>[] = [];
    const treeItems = treeData.tree as any[];
    const directorySymlinks: Array<{ repoPath: string; relativePath: string }> =
      [];

    for (const item of treeItems) {
      if (item.type !== "blob") continue;

      const relativePath = this.relativePathForSubdir(item.path, subdir);
      if (relativePath === null) continue;

      if (
        this.isGitSymlinkMode(item.mode) &&
        this.isPackageSourcePath(relativePath) &&
        !this.isIncludedPackageFile(relativePath)
      ) {
        directorySymlinks.push({ repoPath: item.path, relativePath });
        continue;
      }

      if (!this.isIncludedPackageFile(relativePath)) {
        continue;
      }

      const p = this.fetchGitTreeFile(
        owner,
        repo,
        rev,
        item.path,
        item.mode
      ).then((content) => {
        files[relativePath] = content;
      });
      fetchPromises.push(p);
    }

    await Promise.all(fetchPromises);

    for (const symlink of directorySymlinks) {
      const target = await this.fetchRawGitPathContent(
        owner,
        repo,
        rev,
        symlink.repoPath
      );
      const targetPath = this.resolveGitSymlinkTarget(symlink.repoPath, target);
      const targetPrefix = targetPath.endsWith("/")
        ? targetPath
        : `${targetPath}/`;
      const directoryPromises: Promise<void>[] = [];

      for (const item of treeItems) {
        if (item.type !== "blob" || !item.path.startsWith(targetPrefix)) {
          continue;
        }
        const targetRelativePath = item.path.slice(targetPrefix.length);
        const relativePath = `${symlink.relativePath}/${targetRelativePath}`;
        if (!this.isIncludedPackageFile(relativePath)) {
          continue;
        }

        const p = this.fetchGitTreeFile(
          owner,
          repo,
          rev,
          item.path,
          item.mode
        ).then((content) => {
          files[relativePath] = content;
        });
        directoryPromises.push(p);
      }

      await Promise.all(directoryPromises);
    }

    return files;
  }

  private isIncludedPackageFile(relativePath: string): boolean {
    return (
      relativePath.endsWith(".move") ||
      relativePath === "Move.toml" ||
      relativePath === "Move.lock" ||
      relativePath === "Published.toml" ||
      /^Move\.[^.\\/]+\.toml$/.test(relativePath)
    );
  }

  private isPackageSourcePath(relativePath: string): boolean {
    const normalized = relativePath.replace(/\/+$/, "");
    return ["sources", "scripts", "examples", "tests"].some(
      (sourceRoot) =>
        normalized === sourceRoot || normalized.startsWith(`${sourceRoot}/`)
    );
  }

  private isGitSymlinkMode(mode: unknown): boolean {
    return mode === "120000";
  }

  private relativePathForSubdir(
    repoPath: string,
    subdir?: string
  ): string | null {
    if (!subdir) return repoPath;
    const subdirWithSlash = subdir.endsWith("/") ? subdir : subdir + "/";
    if (!repoPath.startsWith(subdirWithSlash)) {
      return null;
    }
    return repoPath.slice(subdirWithSlash.length);
  }

  private async fetchGitTreeFile(
    owner: string,
    repo: string,
    rev: string,
    repoPath: string,
    mode?: string
  ): Promise<string> {
    if (!this.isGitSymlinkMode(mode)) {
      return this.fetchRawGitPathContent(owner, repo, rev, repoPath);
    }

    const target = await this.fetchRawGitPathContent(
      owner,
      repo,
      rev,
      repoPath
    );
    const targetPath = this.resolveGitSymlinkTarget(repoPath, target);
    return this.fetchRawGitPathContent(owner, repo, rev, targetPath);
  }

  private fetchRawGitPathContent(
    owner: string,
    repo: string,
    rev: string,
    repoPath: string
  ): Promise<string> {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${rev}/${repoPath}`;
    return this.fetchRequiredContent(rawUrl);
  }

  private resolveGitSymlinkTarget(linkPath: string, target: string): string {
    const trimmedTarget = target.trim();
    if (trimmedTarget.startsWith("/")) {
      return this.normalizeGitPath(trimmedTarget.slice(1));
    }
    const basePath = this.dirnameGitPath(linkPath);
    return this.normalizeGitPath(
      basePath ? `${basePath}/${trimmedTarget}` : trimmedTarget
    );
  }

  private dirnameGitPath(repoPath: string): string {
    const index = repoPath.lastIndexOf("/");
    return index === -1 ? "" : repoPath.slice(0, index);
  }

  private normalizeGitPath(repoPath: string): string {
    const parts: string[] = [];
    for (const part of repoPath.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (parts.length === 0) {
          throw new Error(
            `Git symlink target escapes repository root: ${repoPath}`
          );
        }
        parts.pop();
      } else {
        parts.push(part);
      }
    }
    return parts.join("/");
  }

  async fetchFile(
    gitUrl: string,
    rev: string,
    path: string
  ): Promise<string | null> {
    const { owner, repo } = this.parseGitUrl(gitUrl);
    if (!owner || !repo) {
      throw new Error(`Invalid git URL: ${gitUrl}`);
    }
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${rev}/${path}`;
    return this.fetchContent(rawUrl);
  }

  private async fetchContent(url: string): Promise<string | null> {
    if (this.cache.has(url)) {
      return this.cache.get(url) ?? null;
    }
    try {
      const headers: HeadersInit = {};
      // Avoid Authorization on raw.githubusercontent.com in browser to prevent CORS preflight failures.
      const isBrowser = typeof window !== "undefined";
      const isApiRequest = url.startsWith("https://api.github.com/");
      if (this.token && (!isBrowser || isApiRequest)) {
        headers["Authorization"] = `Bearer ${this.token}`;
      }
      const resp = await fetch(url, { headers });
      if (!resp.ok) return null;
      const text = await resp.text();
      this.cache.set(url, text);
      return text;
    } catch {
      return null;
    }
  }

  private async fetchRequiredContent(url: string): Promise<string> {
    const content = await this.fetchContent(url);
    if (content === null) {
      throw new Error(`Failed to fetch file: ${url}`);
    }
    return content;
  }

  private parseGitUrl(url: string): {
    owner: string | null;
    repo: string | null;
  } {
    try {
      const urlObj = new URL(url);
      const parts = urlObj.pathname.split("/").filter((p) => p);
      if (parts.length >= 2) {
        let repo = parts[1];
        if (repo.endsWith(".git")) {
          repo = repo.slice(0, -4);
        }
        return { owner: parts[0], repo };
      }
    } catch {
      // Invalid URL
    }
    return { owner: null, repo: null };
  }
}
