/* global Response */

import {
  GitHubMovePackageFetcher,
  jsonResponse,
  textResponse,
} from "./package_loading_helpers.mjs";

export async function runGitHubPublishedTomlCase() {
  const originalFetch = globalThis.fetch;
  const rawRequests = [];

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://api.github.com/")) {
      return jsonResponse({
        sha: "resolved-tree-sha",
        tree: [
          {
            type: "blob",
            path: "packages/root/Move.toml",
            mode: "100644",
          },
          {
            type: "blob",
            path: "packages/root/Published.toml",
            mode: "100644",
          },
          {
            type: "blob",
            path: "packages/root/sources/root.move",
            mode: "100644",
          },
          {
            type: "blob",
            path: "packages/root/README.md",
            mode: "100644",
          },
        ],
      });
    }

    rawRequests.push(url);
    if (url.endsWith("/Move.toml")) {
      return textResponse('[package]\nname = "Root"\n');
    }
    if (url.endsWith("/Published.toml")) {
      return textResponse('[published.mainnet]\npublished-at = "0x2"\n');
    }
    if (url.endsWith("/sources/root.move")) {
      return textResponse("module root::main {}");
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const fetcher = new GitHubMovePackageFetcher();
    const files = await fetcher.fetch(
      "https://github.com/example/project.git",
      "main",
      "packages/root"
    );

    if (!files["Published.toml"]) {
      throw new Error("GitHubMovePackageFetcher should include Published.toml");
    }
    if (files["README.md"]) {
      throw new Error(
        "GitHubMovePackageFetcher should not include unrelated markdown"
      );
    }
    if (
      fetcher.getResolvedSha(
        "https://github.com/example/project.git",
        "main"
      ) !== "resolved-tree-sha"
    ) {
      throw new Error(
        "GitHubMovePackageFetcher should record resolved tree SHA"
      );
    }
    if (!rawRequests.some((url) => url.endsWith("/Published.toml"))) {
      throw new Error(
        "GitHubMovePackageFetcher did not request Published.toml"
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("[OK] GitHubMovePackageFetcher includes Published.toml");
}
