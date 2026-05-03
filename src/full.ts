export { GitHubMovePackageFetcher, MovePackageFetcher } from "./fetcher.js";
export type { MovePackageFetchLocalContext } from "./fetcher.js";

export type {
  MovePackagePublication,
  MovePackagePublicationUpdateInput,
  MovePackagePublicationUpdateResult,
} from "./publishedRecord.js";

export { updateMovePackagePublication } from "./publishedRecord.js";

export type {
  MovePackageDumpSuccess,
  MovePackageFailure,
  MovePackageFailureCategory,
  MovePackageInput,
  MovePackageIntent,
  MovePackageProgressCallback,
  MovePackageProgressEvent,
  MovePackagePublishSuccess,
  MovePackageResolvedDependencies,
  MovePackageResult,
  MovePackageSuccess,
  MovePackageUpgradeInput,
  MovePackageUpgradeSuccess,
} from "./core.js";

export {
  dumpMovePackage,
  getPinnedSuiMoveVersion,
  getPinnedSuiVersion,
  initMovePackageBuilder,
  prepareMovePackagePublish,
  prepareMovePackageUpgrade,
  resolveMovePackageDependencies,
} from "./core.js";
export { fetchMovePackageFromGitHub } from "./packageFetcher.js";

import {
  asFailure,
  compilerModes,
  loadWasm,
  resolveMovePackageDependenciesForTest,
  type MovePackageFailure,
  type MovePackageInput,
  type MovePackageResolvedDependencies,
} from "./core.js";

export type MovePackageTestInput = MovePackageInput;

export interface MovePackageTestSuccess {
  /** Whether all tests passed. */
  passed: boolean;
  /** Output from the Move unit-test runner. */
  output: string;
}

/** Compile and run tests for a Move package in memory. */
export async function testMovePackage(
  input: MovePackageTestInput
): Promise<MovePackageTestSuccess | MovePackageFailure> {
  try {
    let resolved: MovePackageResolvedDependencies;
    try {
      resolved = input.resolvedDependencies
        ? input.resolvedDependencies
        : await resolveMovePackageDependenciesForTest(input);
    } catch (error) {
      return asFailure(error, "dependency_resolution");
    }

    let mod;
    try {
      mod = await loadWasm(input.wasm);
    } catch (error) {
      return asFailure(error, "wasm_init");
    }

    if (typeof (mod as any).test_with_options !== "function") {
      return asFailure(
        "Move unit-test execution requires the full WASM artifact",
        "test_runner"
      );
    }

    const raw = (mod as any).test_with_options(
      resolved.files,
      resolved.dependencies,
      JSON.stringify({
        ansiColor: input.ansiColor ?? true,
        modes: compilerModes(input),
      })
    );

    if (typeof raw.passed === "boolean" && typeof raw.output === "string") {
      return {
        passed: raw.passed,
        output: raw.output,
      };
    }

    const passed = typeof raw.passed === "function" ? raw.passed() : raw.passed;
    const output = typeof raw.output === "function" ? raw.output() : raw.output;

    return { passed, output };
  } catch (error) {
    return asFailure(error, "test_runner");
  }
}
