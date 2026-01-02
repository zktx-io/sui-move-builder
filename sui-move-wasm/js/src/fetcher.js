/**
 * Abstract interface for fetching package content.
 */
export class Fetcher {
  /**
   * Fetch a package.
   * @param {string} gitUrl - The git URL defined in Move.toml
   * @param {string} rev - The revision/tag/branch
   * @param {string} subdir - The subdirectory to fetch (optional)
   * @returns {Promise<Object>} Map of "path/to/file" -> "content"
   */
  async fetch(gitUrl, rev, subdir) {
    throw new Error("Not implemented");
  }

  /**
   * Fetch a single file from a repository.
   * @param {string} gitUrl
   * @param {string} rev
   * @param {string} path
   * @returns {Promise<string|null>}
   */
  async fetchFile(gitUrl, rev, path) {
    throw new Error("Not implemented");
  }
}

/**
 * Fetcher that retrieves files from public GitHub repositories.
 * Uses GitHub API for tree traversal and raw.githubusercontent.com for content.
 */
export class GitHubFetcher extends Fetcher {
  constructor() {
    super();
    this.cache = new Map();
  }

  async fetch(gitUrl, rev, subdir) {
    const { owner, repo } = this._parseGitUrl(gitUrl);
    if (!owner || !repo) {
      throw new Error(`Invalid git URL: ${gitUrl}`);
    }

    // 1. Get the file tree
    // Note: This API call is rate-limited (60/hr for unauthenticated IP)
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${rev}?recursive=1`;

    let treeData;
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

    if (treeData.truncated) {
      // Continue with possibly partial results.
    }

    // 2. Filter files by subdir and fetch content
    const files = {};
    const fetchPromises = [];

    for (const item of treeData.tree) {
      if (item.type !== "blob") continue; // Skip directories

      // Check if file is within the requested subdir
      // subdir usually comes without leading slash, e.g. "crates/sui-framework"
      // item.path is e.g. "crates/sui-framework/Move.toml"
      let relativePath = item.path;

      if (subdir) {
        // specific subdir requested
        if (!item.path.startsWith(subdir)) {
          continue;
        }
        // Strip subdir prefix to make it relative to the package root
        // e.g. subdir="foo", path="foo/bar.move" -> "bar.move"
        relativePath = item.path.slice(subdir.length);
        if (relativePath.startsWith("/")) {
          relativePath = relativePath.slice(1);
        }
      }

      // We only care about Move.toml and .move files for compilation
      if (!relativePath.endsWith(".move") && relativePath !== "Move.toml") {
        continue;
      }

      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${rev}/${item.path}`;

      const p = this._fetchContent(rawUrl).then((content) => {
        if (content) {
          files[relativePath] = content;
        }
      });
      fetchPromises.push(p);
    }

    await Promise.all(fetchPromises);
    return files;
  }

  async fetchFile(gitUrl, rev, path) {
    const { owner, repo } = this._parseGitUrl(gitUrl);
    if (!owner || !repo) {
      throw new Error(`Invalid git URL: ${gitUrl}`);
    }
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${rev}/${path}`;
    return this._fetchContent(rawUrl);
  }

  async _fetchContent(url) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      return await resp.text();
    } catch (e) {
      return null;
    }
  }

  _parseGitUrl(url) {
    // Simple parser for https://github.com/owner/repo.git or similar
    try {
      const urlObj = new URL(url);
      const parts = urlObj.pathname.split("/").filter((p) => p);
      // parts[0] is owner, parts[1] is repo (maybe with .git)
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
