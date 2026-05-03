import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const variants = [
  {
    name: "full esm",
    load: () => import(new URL("../../dist/full/index.js", import.meta.url)),
  },
  {
    name: "full cjs",
    load: () => require("../../dist/full/index.cjs"),
  },
  {
    name: "lite esm",
    load: () => import(new URL("../../dist/lite/index.js", import.meta.url)),
  },
  {
    name: "lite cjs",
    load: () => require("../../dist/lite/index.cjs"),
  },
];

const supportedApi = new Set([
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
  "testMovePackage",
]);

for (const variant of variants) {
  const mod = await variant.load();

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

  await mod.initMovePackageBuilder();
  const version = await mod.getPinnedSuiVersion();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`${variant.name}: unexpected Sui version '${version}'`);
  }

  console.log(`[OK] ${variant.name}: sui ${version}`);
}
