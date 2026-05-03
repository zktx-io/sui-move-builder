import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const variants = [
  {
    name: "root esm",
    full: false,
    load: () => import(new URL("../../dist/lite/index.js", import.meta.url)),
  },
  {
    name: "root cjs",
    full: false,
    load: () => require("../../dist/lite/index.cjs"),
  },
  {
    name: "full esm",
    full: true,
    load: () => import(new URL("../../dist/full/index.js", import.meta.url)),
  },
  {
    name: "full cjs",
    full: true,
    load: () => require("../../dist/full/index.cjs"),
  },
];

const buildApi = [
  "MovePackageFetcher",
  "GitHubMovePackageFetcher",
  "dumpMovePackage",
  "fetchMovePackageFromGitHub",
  "getPinnedSuiMoveVersion",
  "getPinnedSuiVersion",
  "initMovePackageBuilder",
  "prepareMovePackagePublish",
  "prepareMovePackageUpgrade",
  "resolveMovePackageDependencies",
  "updateMovePackagePublication",
];

for (const variant of variants) {
  const mod = await variant.load();
  const supportedApi = new Set(
    variant.full ? [...buildApi, "testMovePackage"] : buildApi
  );

  for (const exportedName of Object.keys(mod)) {
    if (!supportedApi.has(exportedName)) {
      throw new Error(
        `${variant.name}: unexpected public export ${exportedName}`
      );
    }
  }

  if (typeof mod.initMovePackageBuilder !== "function") {
    throw new Error(`${variant.name}: missing initMovePackageBuilder export`);
  }
  if (typeof mod.getPinnedSuiVersion !== "function") {
    throw new Error(`${variant.name}: missing getPinnedSuiVersion export`);
  }
  if (typeof mod.dumpMovePackage !== "function") {
    throw new Error(`${variant.name}: missing dumpMovePackage export`);
  }
  if (typeof mod.prepareMovePackagePublish !== "function") {
    throw new Error(
      `${variant.name}: missing prepareMovePackagePublish export`
    );
  }
  if (typeof mod.prepareMovePackageUpgrade !== "function") {
    throw new Error(
      `${variant.name}: missing prepareMovePackageUpgrade export`
    );
  }
  if (variant.full && typeof mod.testMovePackage !== "function") {
    throw new Error(`${variant.name}: missing testMovePackage export`);
  }
  if (!variant.full && "testMovePackage" in mod) {
    throw new Error(`${variant.name}: testMovePackage must be full-only`);
  }

  await mod.initMovePackageBuilder();
  const version = await mod.getPinnedSuiVersion();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`${variant.name}: unexpected Sui version '${version}'`);
  }

  console.log(`[OK] ${variant.name}: sui ${version}`);
}

const liteRaw = await import(
  new URL("../../dist/lite/sui_move_wasm.js", import.meta.url)
);
if ("test" in liteRaw || "test_with_options" in liteRaw) {
  throw new Error("lite raw WASM bindings must not expose test entrypoints");
}

const fullRaw = await import(
  new URL("../../dist/full/sui_move_wasm.js", import.meta.url)
);
if (typeof fullRaw.test_with_options !== "function") {
  throw new Error(
    "full raw WASM bindings should expose the internal test runner binding"
  );
}
