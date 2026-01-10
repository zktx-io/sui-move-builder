/**
 * Utility functions for fetching Move packages from GitHub
 */

import { GitHubFetcher } from "./fetcher.js";

/**
 * Parse GitHub URL to extract owner, repo, branch/tag, and subdir
 *
 * Supported formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/tree/branch
 * - https://github.com/owner/repo/tree/branch/path/to/package
 * - https://github.com/owner/repo/tree/tag/path/to/package
 */
export function parseGitHubUrl(url: string): {
  owner: string;
  repo: string;
  ref: string;
  subdir?: string;
} | null {
  try {
    const urlObj = new URL(url);

    if (urlObj.hostname !== "github.com") {
      return null;
    }

    const pathParts = urlObj.pathname.split("/").filter(Boolean);

    if (pathParts.length < 2) {
      return null;
    }

    const owner = pathParts[0];
    const repo = pathParts[1];

    // Default to main branch
    let ref = "main";
    let subdir: string | undefined;

    // Check for /tree/branch/path format
    if (pathParts.length >= 4 && pathParts[2] === "tree") {
      ref = pathParts[3];

      // If there are more parts, it's a subdir
      if (pathParts.length > 4) {
        subdir = pathParts.slice(4).join("/");
      }
    }

    return { owner, repo, ref, subdir };
  } catch {
    return null;
  }
}

/**
 * Fetch a Move package from GitHub URL
 *
 * @param url - GitHub repository URL (e.g., "https://github.com/MystenLabs/sui/tree/main/crates/sui-framework/packages/sui-framework")
 * @param options - Optional configuration
 * @returns Object with Move.toml and source files
 *
 * @example
 * ```ts
 * const files = await fetchPackageFromGitHub(
 *   'https://github.com/MystenLabs/deepbookv3/tree/main/packages/deepbook'
 * );
 *
 * // files = {
 * //   'Move.toml': '...',
 * //   'Move.lock': '...',
 * //   'sources/pool.move': '...',
 * //   ...
 * // }
 * ```
 */
export async function fetchPackageFromGitHub(
  url: string,
  options?: {
    /** Custom fetcher instance (default: GitHubFetcher) */
    fetcher?: GitHubFetcher;
    /** Optional GitHub token to raise API limits (used when fetcher not provided). */
    githubToken?: string;
    /** Include Move.lock file (default: true) */
    includeLock?: boolean;
  }
): Promise<Record<string, string>> {
  const parsed = parseGitHubUrl(url);

  if (!parsed) {
    throw new Error(`Invalid GitHub URL: ${url}`);
  }

  const fetcher = options?.fetcher || new GitHubFetcher(options?.githubToken);
  const includeLock = options?.includeLock !== false;

  const gitUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;

  const files = await fetcher.fetch(
    gitUrl,
    parsed.ref,
    parsed.subdir,
    `root:${parsed.owner}/${parsed.repo}`
  );

  // Attach root git metadata (non-enumerable) for downstream relative path resolution
  Object.defineProperty(files, "__rootGit", {
    value: {
      git: gitUrl,
      rev: parsed.ref,
      subdir: parsed.subdir,
    },
    enumerable: false,
  });

  // Filter out Move.lock if requested
  if (!includeLock && files["Move.lock"]) {
    const { "Move.lock": _unused, ...rest } = files;
    void _unused; // Mark as intentionally unused
    return rest;
  }

  return files;
}

/**
 * Fetch multiple packages from GitHub URLs
 *
 * @param urls - Array of GitHub URLs or URL-to-alias mappings
 * @returns Object mapping package names to their files
 *
 * @example
 * ```ts
 * const packages = await fetchPackagesFromGitHub([
 *   'https://github.com/MystenLabs/sui/tree/framework/mainnet/crates/sui-framework/packages/sui-framework',
 *   'https://github.com/MystenLabs/deepbookv3/tree/main/packages/deepbook'
 * ]);
 *
 * // packages = {
 * //   'Sui': { 'Move.toml': '...', ... },
 * //   'deepbook': { 'Move.toml': '...', ... }
 * // }
 * ```
 */
export async function fetchPackagesFromGitHub(
  urls: string[] | Record<string, string>,
  options?: {
    fetcher?: GitHubFetcher;
    githubToken?: string;
    includeLock?: boolean;
  }
): Promise<Record<string, Record<string, string>>> {
  const urlMap: Record<string, string> = Array.isArray(urls)
    ? Object.fromEntries(urls.map((url, i) => [`package_${i}`, url]))
    : urls;

  const results: Record<string, Record<string, string>> = {};

  for (const [name, url] of Object.entries(urlMap)) {
    results[name] = await fetchPackageFromGitHub(url, options);
  }

  return results;
}

/**
 * Create a shorthand GitHub URL for common repositories
 *
 * @example
 * ```ts
 * githubUrl('MystenLabs/sui', 'framework/mainnet', 'crates/sui-framework/packages/sui-framework')
 * // Returns: https://github.com/MystenLabs/sui/tree/framework/mainnet/crates/sui-framework/packages/sui-framework
 * ```
 */
export function githubUrl(
  repo: string, // 'owner/repo'
  ref: string = "main",
  subdir?: string
): string {
  let url = `https://github.com/${repo}`;

  if (ref || subdir) {
    url += `/tree/${ref}`;
  }

  if (subdir) {
    url += `/${subdir}`;
  }

  return url;
}
