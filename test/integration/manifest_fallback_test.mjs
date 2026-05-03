const { dumpMovePackage, resolveMovePackageDependencies } = await import(
  new URL("../../dist/full/index.js", import.meta.url)
);

const DEP_ORIGINAL =
  "0x00000000000000000000000000000000000000000000000000000000000000aa";
const DEP_PUBLISHED =
  "0x00000000000000000000000000000000000000000000000000000000000000bb";
const BRIDGE_ID =
  "0x000000000000000000000000000000000000000000000000000000000000000b";

function rootFiles({ dependencies = "", networkToml, moveLock } = {}) {
  const files = {
    "Move.toml": `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"
${dependencies}

[addresses]
sui = "0x2"
`,
    "sources/root.move": "module sui::root_fixture {}",
  };
  if (networkToml) {
    files["Move.testnet.toml"] = networkToml;
  }
  if (moveLock) {
    files["Move.lock"] = moveLock;
  }
  return files;
}

function depPackage({
  name = "Dep",
  address = "dep",
  publishedToml = false,
  publishedAt = "0x0",
} = {}) {
  const files = {
    "Move.toml": `
[package]
name = "${name}"
version = "0.0.0"
published-at = "${publishedAt}"
edition = "2024"

[addresses]
${address} = "0x0"
`,
    [`sources/${address}.move`]: `module ${address}::fixture { public fun ok() {} }`,
  };
  if (publishedToml) {
    files["Published.toml"] = `
[published.testnet]
original-id = "${DEP_ORIGINAL}"
published-at = "${DEP_PUBLISHED}"
`;
  }
  return files;
}

const workspace = {
  "../dep": depPackage({ publishedToml: true }),
  "../dep-a": depPackage(),
  "../dep-b": depPackage(),
  "../bridge": depPackage({
    name: "Bridge",
    address: "bridge",
    publishedAt: BRIDGE_ID,
  }),
  "../missing-source": {
    "Move.toml": `
[package]
name = "MissingSource"
version = "0.0.0"
edition = "2024"

[addresses]
missing_source = "0x0"
`,
  },
  "../cycle-a": depPackage({ name: "CycleA", address: "cycle_a" }),
  "../cycle-b": depPackage({ name: "CycleB", address: "cycle_b" }),
};

workspace["../cycle-a"]["Move.toml"] += `

[dependencies]
CycleB = { local = "../cycle-b" }
`;
workspace["../cycle-b"]["Move.toml"] += `

[dependencies]
CycleA = { local = "../cycle-a" }
`;

class LocalFetcher {
  async fetch(gitUrl, rev, subdir = "") {
    throw new Error(`Unexpected git fetch: ${gitUrl} ${rev} ${subdir}`);
  }

  async fetchLocal(localPath) {
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

async function resolve(files, network = "testnet") {
  return resolveMovePackageDependencies({
    files,
    network,
    fetcher: new LocalFetcher(),
  });
}

async function buildForFailure(files, network = "mainnet") {
  return dumpMovePackage({
    files,
    network,
    fetcher: new LocalFetcher(),
  });
}

function parseDeps(resolved) {
  return JSON.parse(resolved.dependencies);
}

const testnetToml = `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"

[dependencies]
Dep = { local = "../dep" }

[addresses]
sui = "0x2"
`;
const envResolved = await resolve(rootFiles({ networkToml: testnetToml }));
const envDeps = parseDeps(envResolved);
const dep = envDeps.find((item) => item.name === "Dep");
if (!dep) {
  throw new Error("Manifest fallback should resolve Move.testnet.toml deps");
}
if (dep.addressMapping.Dep !== DEP_ORIGINAL) {
  throw new Error(
    `Published.toml original-id should be compile address, got ${dep.addressMapping.Dep}`
  );
}
if (dep.publishedIdForOutput !== DEP_PUBLISHED) {
  throw new Error(
    `Published.toml published-at should be output id, got ${dep.publishedIdForOutput}`
  );
}
console.log("[OK] manifest fallback honors Move.<env>.toml and Published.toml");

const sameNameResolved = await resolve(
  rootFiles({
    dependencies: `
[dependencies]
DepA = { local = "../dep-a" }
DepB = { local = "../dep-b" }
`,
  }),
  "mainnet"
);
const sameNameDeps = parseDeps(sameNameResolved).map((item) => item.name);
if (!sameNameDeps.includes("Dep") || !sameNameDeps.includes("Dep_1")) {
  throw new Error(
    `Manifest fallback should preserve same-name package IDs, got ${sameNameDeps.join(", ")}`
  );
}
console.log("[OK] manifest fallback preserves same-name package ids");

const bridgeResolved = await resolve(
  rootFiles({
    dependencies: `
[dependencies]
MyBridge = { local = "../bridge" }
`,
  }),
  "mainnet"
);
const bridge = parseDeps(bridgeResolved).find((item) => item.name === "Bridge");
if (!bridge?.rootDependencyAliases?.includes("MyBridge")) {
  throw new Error("Manifest fallback should preserve explicit root aliases");
}
console.log("[OK] manifest fallback preserves explicit system aliases");

const v3Resolved = await resolve(
  rootFiles({
    dependencies: `
[dependencies]
Dep = { local = "../dep" }
`,
    moveLock: `
[move]
version = 3
`,
  }),
  "mainnet"
);
if (!parseDeps(v3Resolved).some((item) => item.name === "Dep")) {
  throw new Error("Move.lock v3 fallback should resolve from manifests");
}
console.log("[OK] Move.lock v3 falls back to manifest graph resolution");

const v1Resolved = await resolve(
  rootFiles({
    dependencies: `
[dependencies]
Dep = { local = "../dep" }
`,
    moveLock: `
[move]
version = 1
dependencies = [
  { name = "Dep" },
]

[[move.package]]
name = "Dep"
source = { local = "../dep" }
`,
  }),
  "mainnet"
);
if (!parseDeps(v1Resolved).some((item) => item.name === "Dep")) {
  throw new Error("Move.lock v1 fallback should resolve from manifests");
}
console.log("[OK] Move.lock v1 falls back to manifest graph resolution");

await assertRejects(
  () =>
    resolve(
      rootFiles({
        dependencies: `
[dependencies]
MissingSource = { local = "../missing-source" }
`,
      }),
      "mainnet"
    ),
  /bytecode-only dependencies are not supported/,
  "source-only dependency enforcement"
);
await assertMovePackageFailureCode(
  () =>
    buildForFailure(
      rootFiles({
        dependencies: `
[dependencies]
MissingSource = { local = "../missing-source" }
`,
      }),
      "mainnet"
    ),
  "dependency_resolution",
  "bytecode_only_dependency_unsupported",
  "source-only dependency failure code"
);
console.log("[OK] manifest fallback rejects source-less dependencies");

await assertRejects(
  () =>
    resolve(
      rootFiles({
        dependencies: `
[dependencies]
Unsupported = { version = "1.0.0" }
`,
      }),
      "mainnet"
    ),
  /unsupported source form/,
  "unsupported dependency source"
);
await assertMovePackageFailureCode(
  () =>
    buildForFailure(
      rootFiles({
        dependencies: `
[dependencies]
Unsupported = { version = "1.0.0" }
`,
      }),
      "mainnet"
    ),
  "dependency_resolution",
  "unsupported_dependency_source",
  "unsupported dependency source failure code"
);
console.log("[OK] manifest fallback rejects unsupported dependency sources");

await assertRejects(
  () =>
    resolve(
      rootFiles({
        dependencies: `
[dependencies]
CycleA = { local = "../cycle-a" }
`,
      }),
      "mainnet"
    ),
  /Dependency cycle detected/,
  "dependency cycle"
);
console.log("[OK] manifest fallback rejects dependency cycles");

async function assertRejects(fn, pattern, label) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(`${label}: unexpected error '${message}'`);
    }
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

async function assertMovePackageFailureCode(fn, category, code, label) {
  const result = await fn();
  if (!("error" in result)) {
    throw new Error(`${label}: expected build failure`);
  }
  if (result.category !== category) {
    throw new Error(
      `${label}: expected category ${category}, got ${result.category}`
    );
  }
  if (result.code !== code) {
    throw new Error(`${label}: expected code ${code}, got ${result.code}`);
  }
}
