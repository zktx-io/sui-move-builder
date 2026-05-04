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
  {
    name: "verification esm",
    verification: true,
    load: () =>
      import(new URL("../../dist/verification/index.js", import.meta.url)),
  },
  {
    name: "verification cjs",
    verification: true,
    load: () => require("../../dist/verification/index.cjs"),
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
    variant.verification
      ? [
          "getPinnedSuiMoveVersion",
          "getPinnedSuiVersion",
          "initMovePackageVerifier",
          "verifyMovePackageProvenance",
        ]
      : variant.full
        ? [...buildApi, "testMovePackage"]
        : buildApi
  );

  for (const exportedName of Object.keys(mod)) {
    if (!supportedApi.has(exportedName)) {
      throw new Error(
        `${variant.name}: unexpected public export ${exportedName}`
      );
    }
  }

  if (variant.verification) {
    if (typeof mod.initMovePackageVerifier !== "function") {
      throw new Error(
        `${variant.name}: missing initMovePackageVerifier export`
      );
    }
    if (typeof mod.verifyMovePackageProvenance !== "function") {
      throw new Error(
        `${variant.name}: missing verifyMovePackageProvenance export`
      );
    }
    if ("dumpMovePackage" in mod || "testMovePackage" in mod) {
      throw new Error(`${variant.name}: builder APIs must not be exported`);
    }
    await mod.initMovePackageVerifier();
    const version = await mod.getPinnedSuiVersion();
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error(`${variant.name}: unexpected Sui version '${version}'`);
    }
    console.log(`[OK] ${variant.name}: sui ${version}`);
    continue;
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
if ("verify_against_reference" in liteRaw) {
  throw new Error(
    "lite raw WASM bindings must not expose verification entrypoints"
  );
}
if ("verification_resolve_package_groups" in liteRaw) {
  throw new Error(
    "lite raw WASM bindings must not expose verification resolver entrypoints"
  );
}

const fullRaw = await import(
  new URL("../../dist/full/sui_move_wasm.js", import.meta.url)
);
if (typeof fullRaw.test_with_options !== "function") {
  throw new Error(
    "full raw WASM bindings should expose the internal test runner binding"
  );
}
if ("verify_against_reference" in fullRaw) {
  throw new Error(
    "full raw WASM bindings must not expose verification entrypoints"
  );
}
if ("verification_resolve_package_groups" in fullRaw) {
  throw new Error(
    "full raw WASM bindings must not expose verification resolver entrypoints"
  );
}

const verificationRaw = await import(
  new URL("../../dist/verification/sui_move_wasm.js", import.meta.url)
);
if (typeof verificationRaw.verify_against_reference !== "function") {
  throw new Error(
    "verification raw WASM bindings should expose verify_against_reference"
  );
}
if ("test_with_options" in verificationRaw) {
  throw new Error("verification raw WASM bindings must not expose test runner");
}
if (typeof verificationRaw.verification_resolve_package_groups !== "function") {
  throw new Error(
    "verification raw WASM bindings should expose verification_resolve_package_groups"
  );
}
for (const forbiddenName of [
  "compile",
  "compute_manifest_digest",
  "compute_manifest_digest_from_move_toml",
  "lockfile_v4_fetch_plan",
  "lockfile_v4_validate_graph",
  "lockfile_v4_resolve_package_groups",
  "manifest_graph_resolve_package_groups",
  "lockfile_v4_generate",
  "publication_update",
  "root_publication_metadata",
  "legacy_publication_migration",
]) {
  if (forbiddenName in verificationRaw) {
    throw new Error(
      `verification raw WASM bindings must not expose ${forbiddenName}`
    );
  }
}
