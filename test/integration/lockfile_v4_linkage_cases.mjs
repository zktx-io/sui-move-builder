import {
  digest,
  dumpMovePackage,
  resolveMovePackageDependencies,
} from "./lockfile_v4_helpers.mjs";

const linkSuiMoveToml = `
[package]
name = "Sui"
version = "0.0.0"
edition = "2024"
published-at = "0x2"

[addresses]
sui = "0x2"
`;
const linkWrapperMoveToml = `
[package]
name = "Wrapper"
version = "0.0.0"
edition = "2024"
published-at = "0x43"

[dependencies]
Sui = { local = "../sui-copy" }

[addresses]
wrapper = "0x43"
`;
const linkRootMoveToml = `
[package]
name = "App"
version = "0.0.0"
edition = "2024"

[dependencies]
Sui = { local = "../sui", override = true }
Wrapper = { local = "../wrapper" }

[addresses]
app = "0x0"
`;
const linkMoveLock = `
[move]
version = 4

[pinned.mainnet.App]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${digest(linkRootMoveToml, "App")}"
deps = { Sui = "Sui", Wrapper = "Wrapper" }

[pinned.mainnet.Sui]
source = { local = "../sui" }
use_environment = "mainnet"
manifest_digest = "${digest(linkSuiMoveToml, "Sui")}"
deps = {}

[pinned.mainnet.Wrapper]
source = { local = "../wrapper" }
use_environment = "mainnet"
manifest_digest = "${digest(linkWrapperMoveToml, "Wrapper")}"
deps = { Sui = "Sui_1" }

[pinned.mainnet.Sui_1]
source = { local = "../sui-copy" }
use_environment = "mainnet"
manifest_digest = "${digest(linkSuiMoveToml, "Sui")}"
deps = {}
`;

class LinkageFetcher {
  async fetch() {
    throw new Error("unexpected git fetch");
  }

  async fetchLocal(localPath) {
    if (localPath === "../sui" || localPath === "../sui-copy") {
      return {
        "Move.toml": linkSuiMoveToml,
        "sources/sui.move": "module sui::fixture {}",
      };
    }
    if (localPath === "../wrapper") {
      return {
        "Move.toml": linkWrapperMoveToml,
        "sources/wrapper.move": "module wrapper::fixture {}",
      };
    }
    throw new Error(`Unexpected local path: ${localPath}`);
  }
}

export async function runLinkageFiltering() {
  const linkedResolved = await resolveMovePackageDependencies({
    files: {
      "Move.toml": linkRootMoveToml,
      "Move.lock": linkMoveLock,
      "sources/root.move": "module app::root {}",
    },
    network: "mainnet",
    fetcher: new LinkageFetcher(),
  });
  const linkedCompileDeps = JSON.parse(linkedResolved.dependencies);
  const linkedLockfileDeps = JSON.parse(linkedResolved.lockfileDependencies);
  if (linkedCompileDeps.some((dep) => dep.name === "Sui_1")) {
    throw new Error(
      "linked compiler graph should not include duplicate Sui pin"
    );
  }
  if (!linkedLockfileDeps.some((dep) => dep.name === "Sui_1")) {
    throw new Error(
      "unfiltered lockfile graph should preserve duplicate Sui pin"
    );
  }

  console.log(
    "[OK] v4 linkage keeps compiler graph linked and lockfile graph unfiltered"
  );
}

const pythMoveToml = `
[package]
name = "Pyth"
version = "0.0.0"
edition = "2024"
published-at = "0x42"
implicit-dependencies = false

[addresses]
pyth = "0x42"
`;
const legacyWrapperMoveToml = `
[package]
name = "Wrapper"
version = "0.0.0"
edition = "2024"
published-at = "0x43"
implicit-dependencies = false

[dependencies]
Pyth = { local = "../pyth" }

[addresses]
wrapper = "0x43"
`;
const legacyRootMoveToml = `
[package]
name = "LegacyRoot"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[dependencies]
Wrapper = { local = "../wrapper" }

[addresses]
legacy_root = "0x0"
`;
const legacyTransitiveMoveLock = `
[move]
version = 4

[pinned.mainnet.LegacyRoot]
source = { root = true }
use_environment = "mainnet"
manifest_digest = "${digest(legacyRootMoveToml, "LegacyRoot")}"
deps = { Wrapper = "Wrapper" }

[pinned.mainnet.Wrapper]
source = { local = "../wrapper" }
use_environment = "mainnet"
manifest_digest = "${digest(legacyWrapperMoveToml, "Wrapper")}"
deps = { Pyth = "Pyth" }

[pinned.mainnet.Pyth]
source = { local = "../pyth" }
use_environment = "mainnet"
manifest_digest = "${digest(pythMoveToml, "Pyth")}"
deps = {}
`;

class LegacyTransitiveFetcher {
  async fetch() {
    throw new Error("unexpected git fetch");
  }

  async fetchLocal(localPath) {
    if (localPath === "../wrapper") {
      return {
        "Move.toml": legacyWrapperMoveToml,
        "sources/wrapper.move": `
module wrapper::fixture {
    public fun value(): u64 { pyth::fixture::value() }
}
`,
      };
    }
    if (localPath === "../pyth") {
      return {
        "Move.toml": pythMoveToml,
        "sources/pyth.move": `
module pyth::fixture {
    public fun value(): u64 { 42 }
}
`,
      };
    }
    throw new Error(`Unexpected local path: ${localPath}`);
  }
}

export async function runLegacyTransitiveNamedAddresses() {
  const legacyRootFiles = {
    "Move.toml": legacyRootMoveToml,
    "Move.lock": legacyTransitiveMoveLock,
    "sources/root.move": `
module legacy_root::root {
    public fun value(): u64 { pyth::fixture::value() }
}
`,
  };
  const legacyBuild = await dumpMovePackage({
    files: legacyRootFiles,
    fetcher: new LegacyTransitiveFetcher(),
    network: "mainnet",
  });
  if ("error" in legacyBuild) {
    throw new Error(
      `legacy transitive named addresses should compile: ${legacyBuild.error}`
    );
  }
  if (
    legacyBuild.dependencies.map((dep) => dep.toLowerCase()).join(",") !==
    [
      "0x0000000000000000000000000000000000000000000000000000000000000042",
      "0x0000000000000000000000000000000000000000000000000000000000000043",
    ].join(",")
  ) {
    throw new Error(
      "legacy transitive dependency IDs should use CLI package-name order"
    );
  }

  console.log(
    "[OK] legacy package named addresses include transitive dependencies"
  );
}
