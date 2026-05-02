/* global Response */

const { resolveDependencies, GitHubFetcher, getWasmBindings } = await import(
  new URL("../../dist/full/index.js", import.meta.url)
);

const wasm = await getWasmBindings();

function rootFiles() {
  return {
    "Move.toml": `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[dependencies]
Dep = { local = "../dep" }

[addresses]
sui = "0x2"
`,
    "sources/root.move": "module sui::root_fixture {}",
  };
}

const workspace = {
  "../dep": {
    "Move.toml": `
[package]
name = "Dep"
version = "0.0.0"
edition = "2024"

[dependencies]
Shared = { local = "../shared" }

[addresses]
dep = "0x0"
`,
    "sources/dep.move": "module dep::dep_fixture {}",
  },
  "../shared": {
    "Move.toml": `
[package]
name = "Shared"
version = "0.0.0"
edition = "2024"

[addresses]
shared = "0x0"
`,
    "sources/shared.move": "module shared::shared_fixture {}",
  },
};

class LocalWorkspaceFetcher {
  calls = [];

  async fetch(gitUrl, rev, subdir = "") {
    throw new Error(`Unexpected git fetch: ${gitUrl} ${rev} ${subdir}`);
  }

  async fetchLocal(localPath, context) {
    this.calls.push({ localPath, context });
    const files = workspace[localPath];
    if (!files) {
      throw new Error(`Missing local fixture: ${localPath}`);
    }
    return files;
  }

  getResolvedSha() {
    return undefined;
  }
}

const localFetcher = new LocalWorkspaceFetcher();
const resolved = await resolveDependencies({
  files: rootFiles(),
  network: "mainnet",
  fetcher: localFetcher,
});

const deps = JSON.parse(resolved.dependencies);
const depNames = deps.map((dep) => dep.name);
if (!depNames.includes("Dep") || !depNames.includes("Shared")) {
  throw new Error(
    `Expected local dependency graph, got ${depNames.join(", ")}`
  );
}

const localPaths = localFetcher.calls.map((call) => call.localPath);
assertArrayEqual(
  localPaths,
  ["../dep", "../shared"],
  "local dependency fetch order"
);

if (localFetcher.calls[0].context.parentPackageName !== "Sui") {
  throw new Error("Root local dependency should receive root package context");
}
if (localFetcher.calls[1].context.parentPackageName !== "Dep") {
  throw new Error(
    "Transitive local dependency should receive parent package context"
  );
}

console.log("[OK] local package dependencies are loaded through fetchLocal");

await testGitParentLocalDependency();

const v4Fetcher = new LocalWorkspaceFetcher();
const resolvedFromV4LocalPins = await resolveDependencies({
  files: {
    ...rootFiles(),
    "Move.lock": localV4Lockfile(),
  },
  network: "mainnet",
  fetcher: v4Fetcher,
});

const v4DepNames = JSON.parse(resolvedFromV4LocalPins.dependencies).map(
  (dep) => dep.name
);
if (!v4DepNames.includes("Dep") || !v4DepNames.includes("Shared")) {
  throw new Error(
    `Expected V4 local pins to load local dependencies, got ${v4DepNames.join(", ")}`
  );
}

console.log("[OK] V4 local source pins are loaded through fetchLocal");

await assertRejects(
  () =>
    resolveDependencies({
      files: rootFiles(),
      network: "mainnet",
      fetcher: {
        async fetch() {
          throw new Error("git fetch should not be used");
        },
        getResolvedSha() {
          return undefined;
        },
      },
    }),
  /fetcher\.fetchLocal/,
  "missing fetchLocal should fail clearly"
);

await assertRejects(
  () =>
    resolveDependencies({
      files: rootFiles(),
      network: "mainnet",
      fetcher: {
        async fetch() {
          throw new Error("git fetch should not be used");
        },
        async fetchLocal() {
          return {
            "sources/dep.move": "module dep::missing_manifest_fixture {}",
          };
        },
        getResolvedSha() {
          return undefined;
        },
      },
    }),
  /did not provide Move\.toml/,
  "local dependency without Move.toml should fail clearly"
);

console.log("[OK] local package loading failures are explicit");

await testGitHubFetcherIncludesPublishedToml();

async function testGitHubFetcherIncludesPublishedToml() {
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
    const fetcher = new GitHubFetcher();
    const files = await fetcher.fetch(
      "https://github.com/example/project.git",
      "main",
      "packages/root"
    );

    if (!files["Published.toml"]) {
      throw new Error("GitHubFetcher should include Published.toml");
    }
    if (files["README.md"]) {
      throw new Error("GitHubFetcher should not include unrelated markdown");
    }
    if (
      fetcher.getResolvedSha(
        "https://github.com/example/project.git",
        "main"
      ) !== "resolved-tree-sha"
    ) {
      throw new Error("GitHubFetcher should record resolved tree SHA");
    }
    if (!rawRequests.some((url) => url.endsWith("/Published.toml"))) {
      throw new Error("GitHubFetcher did not request Published.toml");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("[OK] GitHubFetcher includes Published.toml");
}

async function testGitParentLocalDependency() {
  const calls = [];
  const snapshots = {
    "packages/parent": {
      "Move.toml": `
[package]
name = "Parent"
version = "0.0.0"
edition = "2024"

[dependencies]
Child = { local = "../child" }

[addresses]
parent = "0x0"
`,
      "sources/parent.move": "module parent::parent_fixture {}",
    },
    "packages/child": {
      "Move.toml": `
[package]
name = "Child"
version = "0.0.0"
edition = "2024"

[addresses]
child = "0x0"
`,
      "sources/child.move": "module child::child_fixture {}",
    },
  };
  const fetcher = {
    async fetch(gitUrl, rev, subdir = "") {
      calls.push({ gitUrl, rev, subdir });
      const files = snapshots[subdir];
      if (!files) {
        throw new Error(`Missing git fixture: ${subdir}`);
      }
      return files;
    },
    getResolvedSha() {
      return "resolved-git-sha";
    },
  };

  const resolved = await resolveDependencies({
    files: {
      "Move.toml": `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[dependencies]
Parent = { git = "https://github.com/example/project.git", rev = "main", subdir = "packages/parent" }

[addresses]
sui = "0x2"
`,
      "sources/root.move": "module sui::git_local_fixture {}",
    },
    network: "mainnet",
    fetcher,
  });

  const depNames = JSON.parse(resolved.dependencies).map((dep) => dep.name);
  if (!depNames.includes("Parent") || !depNames.includes("Child")) {
    throw new Error(
      `Expected git-local dependency graph, got ${depNames.join(", ")}`
    );
  }
  if (
    !calls.some(
      (call) =>
        call.rev === "resolved-git-sha" && call.subdir === "packages/child"
    )
  ) {
    throw new Error(
      `Expected child local dependency to resolve to same git repo subdir, got ${JSON.stringify(calls)}`
    );
  }

  console.log(
    "[OK] git package local dependencies resolve to same repo subdirs"
  );
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

function localV4Lockfile() {
  const rootMoveToml = rootFiles()["Move.toml"];
  const depMoveToml = workspace["../dep"]["Move.toml"];
  const sharedMoveToml = workspace["../shared"]["Move.toml"];
  return `
[move]
version = 4

[pinned.mainnet.Sui]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${manifestDigest(rootMoveToml, "Sui")}"
deps = { Dep = "Dep" }

[pinned.mainnet.Dep]
source = { local = "../dep" }
use_environment = "mainnet"
manifest_digest = "${manifestDigest(depMoveToml, "Dep")}"
deps = { Shared = "Shared" }

[pinned.mainnet.Shared]
source = { local = "../shared" }
use_environment = "mainnet"
manifest_digest = "${manifestDigest(sharedMoveToml, "Shared")}"
deps = {}
`;
}

function manifestDigest(moveToml, packageName) {
  return wasm.compute_manifest_digest_from_move_toml(
    moveToml,
    packageName,
    "mainnet"
  );
}

function assertArrayEqual(actual, expected, message) {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `${message}: expected ${expected.join(", ")}, got ${actual.join(", ")}`
    );
  }
}

async function assertRejects(operation, pattern, message) {
  try {
    await operation();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!pattern.test(text)) {
      throw new Error(`${message}: unexpected error '${text}'`);
    }
    return;
  }
  throw new Error(`${message}: expected rejection`);
}
