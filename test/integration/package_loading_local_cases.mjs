import {
  LocalWorkspaceFetcher,
  assertArrayEqual,
  assertRejects,
  localV4Lockfile,
  resolveMovePackageDependencies,
  rootFiles,
} from "./package_loading_helpers.mjs";

export async function runLocalPackageLoadingCases() {
  const localFetcher = new LocalWorkspaceFetcher();
  const resolved = await resolveMovePackageDependencies({
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
    throw new Error(
      "Root local dependency should receive root package context"
    );
  }
  if (localFetcher.calls[1].context.parentPackageName !== "Dep") {
    throw new Error(
      "Transitive local dependency should receive parent package context"
    );
  }

  console.log("[OK] local package dependencies are loaded through fetchLocal");

  await testGitParentLocalDependency();

  const v4Fetcher = new LocalWorkspaceFetcher();
  const resolvedFromV4LocalPins = await resolveMovePackageDependencies({
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
      resolveMovePackageDependencies({
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
      resolveMovePackageDependencies({
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
implicit-dependencies = false

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
implicit-dependencies = false

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

  const resolved = await resolveMovePackageDependencies({
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
