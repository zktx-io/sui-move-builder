/**
 * Utility functions for fetching Move packages from GitHub
 */

import { GitHubMovePackageFetcher } from "./fetcher.js";
import type { MovePackageGitSource } from "./core.js";

export interface FetchedMovePackage {
  files: Record<string, string>;
  rootGit: MovePackageGitSource;
}

/**
 * Parse GitHub URL to extract owner, repo, branch/tag, and subdir
 *
 * Supported formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/tree/branch
 * - https://github.com/owner/repo/tree/branch/path/to/package
 * - https://github.com/owner/repo/tree/tag/path/to/package
 */
function parseMovePackageGitHubUrl(url: string): {
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
 * @returns Object with package files and root Git source metadata
 *
 * @example
 * ```ts
 * const input = await fetchMovePackageFromGitHub(
 *   'https://github.com/org/repo/tree/main/packages/example_package'
 * );
 *
 * const result = await dumpMovePackage(input);
 * ```
 */
export async function fetchMovePackageFromGitHub(
  url: string,
  options?: {
    /** Custom fetcher instance (default: GitHubMovePackageFetcher) */
    fetcher?: GitHubMovePackageFetcher;
    /** Optional GitHub token to raise API limits (used when fetcher not provided). */
    githubToken?: string;
    /** Include Move.lock file (default: true) */
    includeLock?: boolean;
  }
): Promise<FetchedMovePackage> {
  const parsed = parseMovePackageGitHubUrl(url);

  if (!parsed) {
    throw new Error(`Invalid GitHub URL: ${url}`);
  }

  const fetcher =
    options?.fetcher || new GitHubMovePackageFetcher(options?.githubToken);
  const includeLock = options?.includeLock !== false;

  const gitUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;

  const files = await fetcher.fetch(
    gitUrl,
    parsed.ref,
    parsed.subdir,
    `root:${parsed.owner}/${parsed.repo}`
  );

  const rootGit: MovePackageGitSource = {
    git: gitUrl,
    rev: parsed.ref,
    subdir: parsed.subdir,
  };

  // Filter out Move.lock if requested
  if (!includeLock && files["Move.lock"]) {
    const { "Move.lock": _unused, ...rest } = files;
    void _unused; // Mark as intentionally unused
    return { files: rest, rootGit };
  }

  return { files, rootGit };
}
