const {
  dumpMovePackage,
  initMovePackageBuilder,
  resolveMovePackageDependencies,
} = await import(new URL("../../dist/full/index.js", import.meta.url));

await initMovePackageBuilder();

const files = {
  "Move.toml": `
[package]
name = "TraceRoot"
edition = "2024"
implicit-dependencies = false

[addresses]
trace_root = "0x0"
`,
  "sources/main.move": `
module trace_root::main {
    public fun value(): u64 { 1 }
}
`,
};

function expectSuccess(result, label) {
  if ("error" in result) {
    throw new Error(`${label} should succeed: ${result.error}`);
  }
}

function stageEvents(events) {
  return events.filter((event) => event.type === "stage_trace");
}

function expectStages(events, expectedStages, label) {
  const stages = new Set(stageEvents(events).map((event) => event.stage));
  for (const expected of expectedStages) {
    if (!stages.has(expected)) {
      throw new Error(`${label} did not emit ${expected}`);
    }
  }
}

function expectTraceShape(events, label) {
  for (const event of stageEvents(events)) {
    if (event.environment !== "mainnet" && event.environment !== "testnet") {
      throw new Error(`${label} emitted stage with unexpected environment`);
    }
    if (!Array.isArray(event.modes)) {
      throw new Error(`${label} emitted stage without modes array`);
    }
    for (const key of [
      "nodeCount",
      "edgeCount",
      "activeEdgeCount",
      "linkedNodeCount",
    ]) {
      if (key in event && typeof event[key] !== "number") {
        throw new Error(`${label} emitted non-numeric ${key}`);
      }
    }
  }
}

function stageEvent(events, stage, label) {
  const event = stageEvents(events).find(
    (candidate) => candidate.stage === stage
  );
  if (!event) {
    throw new Error(`${label} did not emit ${stage}`);
  }
  return event;
}

const manifestEvents = [];
const resolveEvents = [];
const resolved = await resolveMovePackageDependencies({
  files,
  onProgress: (event) => resolveEvents.push(event),
});
if ("stageReports" in resolved) {
  throw new Error("stage reports should not be part of public resolve results");
}
expectStages(
  resolveEvents,
  ["manifest_graph", "manifest_mode_filter", "manifest_linkage"],
  "public resolve trace"
);

const manifestResult = await dumpMovePackage({
  files,
  onProgress: (event) => manifestEvents.push(event),
});
expectSuccess(manifestResult, "manifest graph trace build");
if ("stageReports" in manifestResult) {
  throw new Error("stage reports should not be part of build results");
}
expectStages(
  manifestEvents,
  ["manifest_graph", "manifest_mode_filter", "manifest_linkage"],
  "manifest graph trace build"
);
expectTraceShape(manifestEvents, "manifest graph trace build");

const noProgressResult = await dumpMovePackage({ files });
expectSuccess(noProgressResult, "build without progress callback");
if ("stageReports" in noProgressResult) {
  throw new Error("stage reports should not be emitted without progress");
}

const lockfileEvents = [];
const lockfileResult = await dumpMovePackage({
  files: {
    ...files,
    "Move.lock": manifestResult.moveLock,
  },
  onProgress: (event) => lockfileEvents.push(event),
});
expectSuccess(lockfileResult, "Move.lock graph trace build");
expectStages(
  lockfileEvents,
  ["move_lock_fetch_plan", "move_lock_graph", "move_lock_linkage"],
  "Move.lock graph trace build"
);
expectTraceShape(lockfileEvents, "Move.lock graph trace build");

const modeDepFiles = {
  "Move.toml": `
[package]
name = "mode_dep"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false
published-at = "0x42"
`,
  "sources/dep.move": `
module 0x42::fixture {
    public fun value(): u64 { 42 }
}
`,
};

const modeRootFiles = {
  "Move.toml": `
[package]
name = "TraceModeRoot"
version = "0.0.0"
edition = "2024"
implicit-dependencies = false

[dependencies]
mode_dep = { local = "../mode-dep", modes = ["custom"] }
`,
  "sources/main.move": `
module 0x0::main {
    public fun base(): u64 { 1 }

    #[mode(custom)]
    public fun selected(): u64 { mode_dep::fixture::value() }
}
`,
};

const modeFetcher = {
  async fetch() {
    throw new Error("unexpected git fetch");
  },
  async fetchLocal(localPath) {
    if (localPath === "../mode-dep") {
      return modeDepFiles;
    }
    throw new Error(`unexpected local fetch: ${localPath}`);
  },
  async fetchFile() {
    return null;
  },
  getResolvedSha() {
    return undefined;
  },
};

const inactiveModeEvents = [];
const inactiveModeResult = await dumpMovePackage({
  files: modeRootFiles,
  fetcher: modeFetcher,
  onProgress: (event) => inactiveModeEvents.push(event),
});
expectSuccess(inactiveModeResult, "inactive mode manifest trace build");
if (!inactiveModeResult.moveLock.includes('mode_dep = "mode_dep"')) {
  throw new Error(
    "inactive mode dependency should remain in generated Move.lock"
  );
}
expectStages(
  inactiveModeEvents,
  ["manifest_graph", "manifest_mode_filter", "manifest_linkage"],
  "inactive mode manifest trace build"
);
const inactiveManifestFilter = stageEvent(
  inactiveModeEvents,
  "manifest_mode_filter",
  "inactive mode manifest trace build"
);
if (
  !(inactiveManifestFilter.edgeCount > inactiveManifestFilter.activeEdgeCount)
) {
  throw new Error(
    "inactive manifest mode dependency should reduce active edges"
  );
}

const inactiveModeLockfileEvents = [];
const inactiveModeLockfileResult = await dumpMovePackage({
  files: {
    ...modeRootFiles,
    "Move.lock": inactiveModeResult.moveLock,
  },
  fetcher: modeFetcher,
  onProgress: (event) => inactiveModeLockfileEvents.push(event),
});
expectSuccess(
  inactiveModeLockfileResult,
  "inactive mode Move.lock trace build"
);
const inactiveLockfileGraph = stageEvent(
  inactiveModeLockfileEvents,
  "move_lock_graph",
  "inactive mode Move.lock trace build"
);
if (
  inactiveLockfileGraph.edgeCount !== 0 ||
  inactiveLockfileGraph.activeEdgeCount !== 0
) {
  throw new Error(
    "inactive Move.lock mode dependency should not enter active graph edges"
  );
}

const testnetModeEvents = [];
const testnetModeResult = await dumpMovePackage({
  files: modeRootFiles,
  fetcher: modeFetcher,
  network: "testnet",
  onProgress: (event) => testnetModeEvents.push(event),
});
expectSuccess(testnetModeResult, "testnet manifest trace build");
const testnetManifestGraph = stageEvent(
  testnetModeEvents,
  "manifest_graph",
  "testnet manifest trace build"
);
if (testnetManifestGraph.environment !== "testnet") {
  throw new Error("testnet manifest trace should preserve requested network");
}

const activeModeLockfileEvents = [];
const activeModeLockfileResult = await dumpMovePackage({
  files: {
    ...modeRootFiles,
    "Move.lock": testnetModeResult.moveLock,
  },
  fetcher: modeFetcher,
  modes: ["custom"],
  network: "testnet",
  onProgress: (event) => activeModeLockfileEvents.push(event),
});
expectSuccess(activeModeLockfileResult, "active mode Move.lock trace build");
for (const stage of [
  "move_lock_fetch_plan",
  "move_lock_graph",
  "move_lock_linkage",
]) {
  const event = stageEvent(
    activeModeLockfileEvents,
    stage,
    "active mode Move.lock trace build"
  );
  if (event.modes.join(",") !== "custom") {
    throw new Error(`${stage} should preserve selected modes`);
  }
}
const activeLockfileGraph = stageEvent(
  activeModeLockfileEvents,
  "move_lock_graph",
  "active mode Move.lock trace build"
);
if (activeLockfileGraph.environment !== "testnet") {
  throw new Error("active Move.lock trace should preserve requested network");
}
if (
  activeLockfileGraph.edgeCount === 0 ||
  activeLockfileGraph.activeEdgeCount !== activeLockfileGraph.edgeCount
) {
  throw new Error(
    "active Move.lock mode dependency should keep all edges active"
  );
}

console.log(
  "[OK] stage trace progress events cover manifest and Move.lock paths"
);
