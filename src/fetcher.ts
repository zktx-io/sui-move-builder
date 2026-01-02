/** Abstract interface for fetching package content. */
export class Fetcher {
  /** Fetch a package. Return map of path -> content. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetch(_gitUrl: string, _rev: string, _subdir?: string): Promise<Record<string, string>> {
    throw new Error("Not implemented");
  }

  /** Fetch a single file from a repository. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetchFile(_gitUrl: string, _rev: string, _path: string): Promise<string | null> {
    throw new Error("Not implemented");
  }
}

/** Fetcher that retrieves files from public GitHub repositories via fetch(). */
export class GitHubFetcher extends Fetcher {
  private cache: Map<string, string>;

  constructor() {
    super();
    this.cache = new Map();
  }

  async fetch(gitUrl: string, rev: string, subdir?: string): Promise<Record<string, string>> {
    const { owner, repo } = this.parseGitUrl(gitUrl);
    if (!owner || !repo) {
      throw new Error(`Invalid git URL: ${gitUrl}`);
    }

    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${rev}?recursive=1`;
    let treeData: any;
    try {
      const resp = await fetch(treeUrl);
      if (!resp.ok) {
        if (resp.status === 403 || resp.status === 429) {
          throw new Error("GitHub API rate limit exceeded.");
        }
        throw new Error(`Failed to fetch tree: ${resp.statusText}`);
      }
      treeData = await resp.json();
    } catch (e) {
      return {};
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

      if (!relativePath.endsWith(".move") && relativePath !== "Move.toml") {
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
    return files;
  }

  async fetchFile(gitUrl: string, rev: string, path: string): Promise<string | null> {
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
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const text = await resp.text();
      this.cache.set(url, text);
      return text;
    } catch (e) {
      return null;
    }
  }

  private parseGitUrl(url: string): { owner: string | null; repo: string | null } {
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
    } catch (e) {}
    return { owner: null, repo: null };
  }
}
