/* global Response */

import {
  GitHubMovePackageFetcher,
  assertRejects,
  jsonResponse,
  textResponse,
} from "./package_loading_helpers.mjs";

export async function runGitHubSymlinkCases() {
  await testGitHubMovePackageFetcherFollowsMoveTomlSymlink();
  await testGitHubMovePackageFetcherRejectsEscapingSymlink();
}

async function testGitHubMovePackageFetcherFollowsMoveTomlSymlink() {
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
            mode: "120000",
          },
          {
            type: "blob",
            path: "packages/root/Move.mainnet.toml",
            mode: "100644",
          },
          {
            type: "blob",
            path: "packages/root/sources/root.move",
            mode: "100644",
          },
          {
            type: "blob",
            path: "packages/root/sources/linked.move",
            mode: "120000",
          },
          {
            type: "blob",
            path: "packages/root/tests",
            mode: "120000",
          },
          {
            type: "blob",
            path: "packages/root/sources/generated",
            mode: "120000",
          },
          {
            type: "blob",
            path: "packages/shared/linked.move",
            mode: "100644",
          },
          {
            type: "blob",
            path: "packages/linked-tests/symlinked_test.move",
            mode: "100644",
          },
          {
            type: "blob",
            path: "packages/generated-sources/nested.move",
            mode: "100644",
          },
        ],
      });
    }

    rawRequests.push(url);
    if (url.endsWith("/Move.toml")) {
      return textResponse("Move.mainnet.toml");
    }
    if (url.endsWith("/Move.mainnet.toml")) {
      return textResponse('[package]\nname = "LinkedRoot"\n');
    }
    if (url.endsWith("/sources/root.move")) {
      return textResponse("module linked_root::main {}");
    }
    if (url.endsWith("/sources/linked.move")) {
      return textResponse("../../shared/linked.move");
    }
    if (url.endsWith("/shared/linked.move")) {
      return textResponse("module linked_root::linked_source {}");
    }
    if (url.endsWith("/packages/root/tests")) {
      return textResponse("../linked-tests");
    }
    if (url.endsWith("/packages/root/sources/generated")) {
      return textResponse("../../generated-sources");
    }
    if (url.endsWith("/linked-tests/symlinked_test.move")) {
      return textResponse("module linked_root::linked_test {}");
    }
    if (url.endsWith("/generated-sources/nested.move")) {
      return textResponse("module linked_root::nested_linked_source {}");
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

    if (!files["Move.toml"]?.includes('name = "LinkedRoot"')) {
      throw new Error(
        "GitHubMovePackageFetcher should follow Move.toml symlink"
      );
    }
    if (!rawRequests.some((url) => url.endsWith("/Move.mainnet.toml"))) {
      throw new Error(
        "GitHubMovePackageFetcher did not request symlink target manifest"
      );
    }
    if (!files["sources/linked.move"]?.includes("linked_source")) {
      throw new Error(
        "GitHubMovePackageFetcher should follow Move source file symlinks"
      );
    }
    if (!files["tests/symlinked_test.move"]?.includes("linked_test")) {
      throw new Error(
        "GitHubMovePackageFetcher should follow Move source directory symlinks"
      );
    }
    if (
      !files["sources/generated/nested.move"]?.includes("nested_linked_source")
    ) {
      throw new Error(
        "GitHubMovePackageFetcher should follow nested Move source directory symlinks"
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("[OK] GitHubMovePackageFetcher follows package symlinks");
}

async function testGitHubMovePackageFetcherRejectsEscapingSymlink() {
  const originalFetch = globalThis.fetch;

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
            path: "packages/root/sources/escape.move",
            mode: "120000",
          },
        ],
      });
    }

    if (url.endsWith("/Move.toml")) {
      return textResponse('[package]\nname = "Root"\n');
    }
    if (url.endsWith("/sources/escape.move")) {
      return textResponse("../../../../outside.move");
    }
    return new Response("not found", { status: 404 });
  };

  try {
    await assertRejects(
      () =>
        new GitHubMovePackageFetcher().fetch(
          "https://github.com/example/project.git",
          "main",
          "packages/root"
        ),
      /escapes repository root/,
      "GitHubMovePackageFetcher should reject symlinks escaping the repo"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("[OK] GitHubMovePackageFetcher rejects escaping symlinks");
}
