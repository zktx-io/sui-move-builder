/**
 * Move.lock V4 Generator
 *
 * Wraps the Rust/WASM V4 lockfile generator used by dumpMovePackage.
 *
 * ORIGINAL SOURCE REFERENCES:
 * - move-package-alt/src/graph/to_lockfile.rs - PackageGraph::to_pins() generates lockfile pins
 * - move-package-alt/src/schema/lockfile.rs - Pin struct definition (source, manifest_digest, deps)
 * - move-package-alt/src/package/root_package.rs:279-283 - save_lockfile_to_disk() writes lockfile
 *
 * The build path uses lockfile_v4_generate from the WASM module.
 */

import {
  StructuredBuildError,
  structuredErrorCode,
} from "./structuredError.js";

export type LockfileV4GenerateFn = (inputJson: string) => string;

type LockfileV4GenerateResponse =
  | { status: "ok"; lockfile: string }
  | { status: "error"; error?: string; code?: string };

function parseLockfileV4GenerateResponse(
  raw: string
): LockfileV4GenerateResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Rust lockfile V4 generation returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { status?: unknown }).status !== "string"
  ) {
    throw new Error(
      "Rust lockfile V4 generation returned an invalid response shape"
    );
  }

  return parsed as LockfileV4GenerateResponse;
}

/**
 * Generate Move.lock V4 from resolved dependencies JSON
 * This wrapper passes package snapshots to the Rust/WASM generator.
 */
export function generateMoveLockV4FromJson(
  depsJson: string,
  rootPackageName: string,
  environment: string,
  rootDepAliasToPackageName?: Record<string, string>,
  existingLockfile?: string, // ORIGINAL: root_package.rs:269-283 - CLI reads existing lockfile and preserves other environments
  rustGenerateFn?: LockfileV4GenerateFn,
  rootFiles?: Record<string, string>,
  modes: string[] = []
): string {
  if (!rustGenerateFn) {
    throw new Error("Rust lockfile_v4_generate helper is required");
  }

  try {
    const deps = JSON.parse(depsJson) as Array<{
      name: string;
      files: Record<string, string>;
      manifest?: {
        name?: string;
        dependencies?: Record<string, unknown>;
      };
      source?: {
        type: string;
        git?: string;
        rev?: string;
        subdir?: string;
        local?: string;
      };
      manifestDeps?: string[];
      /** Maps Move.toml deps key (alias) → resolved package name */
      depAliasToPackageName?: Record<string, string>;
    }>;

    const input = {
      environment,
      existingLockfile,
      modes,
      root: {
        id: rootPackageName,
        source: { type: "root" },
        files: rootFiles || {},
        depAliasToPackageName: rootDepAliasToPackageName || {},
      },
      packages: deps.map((dep) => ({
        id: dep.name,
        source: dep.source || { type: "unsupported" },
        files: dep.files || {},
        depAliasToPackageName: dep.depAliasToPackageName || {},
      })),
    };

    const response = parseLockfileV4GenerateResponse(
      rustGenerateFn(JSON.stringify(input))
    );
    if (response.status !== "ok") {
      throw new StructuredBuildError(
        response.error || "Rust lockfile V4 generation failed",
        response.code
      );
    }
    return response.lockfile;
  } catch (error: any) {
    throw new StructuredBuildError(
      `Lockfile generation error: ${error?.message || error}`,
      structuredErrorCode(error),
      error
    );
  }
}
