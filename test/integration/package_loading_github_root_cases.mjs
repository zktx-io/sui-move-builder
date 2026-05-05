/* global Response */

import {
  fetchMovePackageFromGitHub,
  jsonResponse,
  textResponse,
} from "./package_loading_helpers.mjs";

export async function runGitHubRootFetchCases() {
  await testFetchMovePackageFromGitHubReturnsFilesAndRootGit();
  await testFetchMovePackageFromGitHubDefaultsToRootAndIncludesLock();
}

async function testFetchMovePackageFromGitHubReturnsFilesAndRootGit() {
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
            path: "packages/root/Move.lock",
            mode: "100644",
          },
          {
            type: "blob",
            path: "packages/root/sources/root.move",
            mode: "100644",
          },
        ],
      });
    }

    if (url.endsWith("/Move.toml")) {
      return textResponse('[package]\nname = "Root"\n');
    }
    if (url.endsWith("/Move.lock")) {
      return textResponse("[move]\nversion = 4\n");
    }
    if (url.endsWith("/sources/root.move")) {
      return textResponse("module root::main {}");
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const loaded = await fetchMovePackageFromGitHub(
      "https://github.com/example/project/tree/main/packages/root",
      { includeLock: false }
    );

    if (!loaded.files["Move.toml"] || !loaded.files["sources/root.move"]) {
      throw new Error("fetchMovePackageFromGitHub should return package files");
    }
    if (loaded.files["Move.lock"]) {
      throw new Error("includeLock false should omit Move.lock from files");
    }
    if (
      loaded.rootGit.git !== "https://github.com/example/project.git" ||
      loaded.rootGit.rev !== "main" ||
      loaded.rootGit.subdir !== "packages/root"
    ) {
      throw new Error(
        `fetchMovePackageFromGitHub returned unexpected rootGit ${JSON.stringify(
          loaded.rootGit
        )}`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("[OK] fetchMovePackageFromGitHub returns files and rootGit");
}

async function testFetchMovePackageFromGitHubDefaultsToRootAndIncludesLock() {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://api.github.com/")) {
      return jsonResponse({
        sha: "resolved-tree-sha",
        tree: [
          {
            type: "blob",
            path: "Move.toml",
            mode: "100644",
          },
          {
            type: "blob",
            path: "Move.lock",
            mode: "100644",
          },
          {
            type: "blob",
            path: "sources/root.move",
            mode: "100644",
          },
        ],
      });
    }

    if (url.endsWith("/Move.toml")) {
      return textResponse('[package]\nname = "Root"\n');
    }
    if (url.endsWith("/Move.lock")) {
      return textResponse("[move]\nversion = 4\n");
    }
    if (url.endsWith("/sources/root.move")) {
      return textResponse("module root::main {}");
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const loaded = await fetchMovePackageFromGitHub(
      "https://github.com/example/root-project"
    );

    if (!loaded.files["Move.lock"]) {
      throw new Error(
        "fetchMovePackageFromGitHub should include Move.lock by default"
      );
    }
    if (
      loaded.rootGit.git !== "https://github.com/example/root-project.git" ||
      loaded.rootGit.rev !== "main" ||
      loaded.rootGit.subdir !== undefined
    ) {
      throw new Error(
        `fetchMovePackageFromGitHub returned unexpected root repo rootGit ${JSON.stringify(
          loaded.rootGit
        )}`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(
    "[OK] fetchMovePackageFromGitHub defaults to root and includes Move.lock"
  );
}
