# Agents Guide

This file describes how agents should work on this repository, especially when preparing a new pinned Sui version for the WASM builder.

## Project Purpose

This project packages a Sui Move build path for JavaScript environments. It uses a pinned upstream Sui source checkout, overlays this repository's `sui-move-wasm` crate into a disposable worktree, applies WASM compatibility patches, builds lite/full WASM artifacts, and publishes them through the npm package.

The main goal is browser-compatible Move package building. The lite artifact is build-focused. The full artifact includes the WASM `testing` feature and is expected to support Move unit test execution where the current implementation and tests cover it.

The upstream Sui source must stay pristine. All generated or patched state belongs under `.sui-build/work` or `.sui-build/generated`.

## Work Process

Use the two-phase WASM build flow:

```bash
npm run prepare:wasm
npm run build:wasm:prepared -- --profile lite
npm run build:wasm:prepared -- --profile full
```

`prepare:wasm` may download/update source, recreate the disposable worktree, generate stubs/vendor patches, install the matching local `wasm-bindgen`, and write `.sui-build/patch-state.json`.

`build:wasm:prepared` must treat the prepared workspace as input. It validates `patch-state.json` against `sui-version.json`, then builds the requested profile. Use `SUI_WASM_STRICT_OFFLINE=1` only when intentionally checking that Cargo does not reach the network.

For code or documentation changes, keep claims tied to verified behavior. Do not describe full Sui CLI parity unless the relevant parity tests pass.

## Versioned Template Manifests

Each `scripts/templates/v<version>/` directory must include a `manifest.json` file. The manifest records the crate-to-template map, the crates that are stubbed or stripped during prepare, and the version-specific upstream files that are overwritten.

When adding, deleting, or renaming a template file, update the manifest in the same change. A new Sui version should get its own template directory and manifest unless it has been intentionally configured to reuse an older `templateVersion`.

## Required Outputs

For a normal refactor or version-up task, produce these outputs:

- Updated source files or scripts with narrow, reviewable changes.
- `.sui-build/patch-state.json` from a successful prepare run when WASM preparation is part of the task.
- `dist/lite` and/or `dist/full` only after the prepared build commands succeed.
- Updated README/CLI_PIPELINE content only for facts confirmed by code or tests.
- A final report listing changed files, commands run, failures, and remaining risks.

Generated directories such as `.sui-build/` and `dist/` are build state and should not be committed unless the project policy changes.

## Sui WASM Version-Up Agent Prompt

Use this prompt when preparing a new Sui version for this repository.

```text
You are the Sui WASM Version-Up Agent for this repository.

Goal:
Prepare a new Sui version for WASM build without polluting the pristine upstream source.

Inputs:
- Target Sui version/tag/commit
- Existing repo with scripts/templates/v<old-version>
- Current build flow: prepare:wasm -> build:wasm:prepared -> tests

Rules:
- Do not edit .sui-build/source directly.
- Use a disposable worktree under .sui-build/work.
- Keep generated artifacts under .sui-build/generated.
- Create or update scripts/templates/v<target-version> only when a compatibility template is actually required.
- Do not claim CLI parity unless parity tests pass.
- Do not delete old templates unless explicitly requested.

Tasks:
1. Update sui-version.json for the target Sui version.
2. Run the prepare pipeline and record failures.
3. For each failure, identify whether it is:
   - missing WASM-compatible stub
   - Cargo feature issue
   - native dependency issue
   - upstream API drift
   - test runner/full-build issue
4. Add the minimal version-specific template or patch needed.
5. Re-run prepare until patch-state.json is produced.
6. Run prepared lite build.
7. Run prepared full build.
8. Run:
   - npm run typecheck
   - npm run lint
   - npm run format:check
   - npm run test:runtime
   - npm run test:full
   - npm run test:lite
9. Update README/CLI_PIPELINE only for facts confirmed by code/tests.
10. Produce a final report:
   - target Sui version and commit
   - files changed
   - templates added/changed
   - build/test commands run
   - failures or remaining risks

Output:
A concise implementation summary with exact changed files and verification results.
```
