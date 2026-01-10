/** Abstract interface for fetching package content. */
export class Fetcher {
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
}

/** Fetcher that retrieves files from public GitHub repositories via fetch(). */
export class GitHubFetcher extends Fetcher {
  private cache: Map<string, string>;
  private treeCache: Map<string, any>; // Cache tree API responses
  private rateLimitRemaining: number = 60; // GitHub unauthenticated limit: 60/hour
  private rateLimitReset: number = 0;
  private token: string | undefined;

  constructor(token?: string) {
    super();
    this.cache = new Map();
    this.treeCache = new Map();
    this.token = token;
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
    context?: string
  ): Promise<Record<string, string>> {
    // Log fetch with dependency context
    const ctx = context ? ` | context: ${context}` : "";
    console.log(
      `Fetching git ${gitUrl} @ ${rev}${subdir ? ` (subdir: ${subdir})` : ""}${ctx}`
    );
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
          break; // Success, exit retry loop
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt === maxRetries) {
            return {};
          }
        }
      }

      if (lastError) {
        return {};
      }
    }

    const files: Record<string, string> = {};
    const fetchPromises: Promise<void>[] = [];

    for (const item of treeData.tree as any[]) {
      if (item.type !== "blob") continue;

      let relativePath: string = item.path;
      if (subdir) {
        if (!item.path.startsWith(subdir)) continue;
        relativePath = item.path.slice(subdir.length);
        if (relativePath.startsWith("/")) {
          relativePath = relativePath.slice(1);
        }
      }

      if (
        !relativePath.endsWith(".move") &&
        relativePath !== "Move.toml" &&
        relativePath !== "Move.lock" &&
        !relativePath.match(/^Move\.(mainnet|testnet|devnet)\.toml$/)
      ) {
        continue;
      }

      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${rev}/${item.path}`;
      const p = this.fetchContent(rawUrl).then((content) => {
        if (content) {
          files[relativePath] = content;
        }
      });
      fetchPromises.push(p);
    }

    await Promise.all(fetchPromises);

    // Handle symlinks: If Move.toml content is just a filename, fetch that file
    if (files["Move.toml"]) {
      const content = files["Move.toml"].trim();
      // Check if it looks like a symlink (single line, ends with .toml, no [ or =)
      if (
        content.match(/^Move\.(mainnet|testnet|devnet)\.toml$/) &&
        !content.includes("[") &&
        !content.includes("=")
      ) {
        // This is a symlink, fetch the actual file
        const targetFile = content;
        const targetPath = subdir
          ? `${subdir}/${targetFile}`.replace(/\/+/g, "/")
          : targetFile;
        const targetUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${rev}/${targetPath}`;
        const actualContent = await this.fetchContent(targetUrl);
        if (actualContent) {
          // Replace Move.toml with actual content, and also add the target file
          files["Move.toml"] = actualContent;
          files[targetFile] = actualContent;
        }
      }
    }

    // Log fetch result summary
    console.log(
      `Fetched ${Object.keys(files).length} files` +
        (context ? ` for ${context}` : "") +
        ` from ${gitUrl} @ ${rev}` +
        (subdir ? ` (subdir: ${subdir})` : "")
    );

    return files;
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
