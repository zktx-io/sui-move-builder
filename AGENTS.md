# Agents Guide

This file gives operating instructions for agents that update the pinned Sui version, port WASM compatibility patches, or refactor parity-sensitive code in this repository.

## Project Purpose

This project packages a Sui Move build path for JavaScript environments. It uses a pinned upstream Sui source checkout, overlays this repository's `sui-move-wasm` crate into a disposable worktree, applies WASM compatibility patches, builds lite/full WASM artifacts, and publishes them through the npm package.

The main goal is browser-compatible Move package building. The lite artifact is build-focused. The full artifact includes the WASM `testing` feature and is expected to support Move unit test execution where the current implementation and tests cover it.

The upstream Sui source must stay pristine. All generated or patched state belongs under `.sui-build/work` or `.sui-build/generated`.

## Core Invariants

- Keep the upstream Sui source pristine. Do not edit `.sui-build/source` directly.
- Treat `prepare:wasm` as the only step that may fetch, update, patch, or prepare upstream/compat state.
- Treat TypeScript as host/API/snapshot glue, not as the owner of Sui package-manager semantics.
- Treat Rust/WASM as the source of truth for graph, linkage, digest, lockfile, compiler setup, output dependencies, and test ownership.
- Treat CLI parity as stage-level behavioral parity with the pinned Sui flow, not fixture-shaped output matching.
- Do not make parity-sensitive decisions from intuition, expected behavior, or fixture output alone. First verify how the selected Sui CLI or pinned upstream Sui source actually behaves, then implement the WASM behavior from that evidence.
- Do not commit generated build state unless explicitly allowed.

## Preflight

Before changing a pinned Sui version, compatibility overlay, or parity-sensitive implementation, verify the working context:

- Before planning or editing, do not rely on task descriptions alone; verify the current repository structure and script behavior first.
- Read `AGENTS.md`, `sui-version.json`, `package.json` scripts, `CLI_PIPELINE.md`, `scripts/compat/manifest.json`, and the task-relevant Rust/TypeScript files.
- Before parity-sensitive changes, open the `CLI Structure vs WASM Structure` table in `CLI_PIPELINE.md`. If the affected stage is not represented there, update the table before changing code.
- When changing `AGENTS.md`, `README.md`, or `CLI_PIPELINE.md`, run `node test/integration/run.mjs cli-pipeline-table` and `node test/integration/run.mjs doc-freshness` before submitting.
- Identify the target Sui `version`, `tag`, and `commit`. Decide whether the change updates `sui-version.json` or uses an explicit script/env override.
- Identify the current version exposure paths for CLI and WASM. Check `sui --version` for the selected CLI, and check the Rust/WASM exports plus public JS APIs that report the pinned Sui version.
- Confirm that `scripts/compat/manifest.json` exists before running prepare. Missing manifests are porting blockers.
- Check the installed `sui` CLI or the binary selected by `SUI_CLI` before parity tests. Missing CLI is an error. If its version differs from `sui-version.json`, record the mismatch as a warning and parity risk in the final report.
- Check the git worktree. Preserve unrelated user changes and do not revert files outside the task scope.
- Use `AGENTS.md` as the single agent guide. Do not add another competing instruction document.
- Treat `prepare:wasm` as the only step that may fetch/update upstream source or prepare compatibility patches. Prepared build scripts consume existing prepared state only.

## Work Process

Use the two-phase WASM build flow:

```bash
npm run prepare:wasm
npm run build:wasm:prepared:lite
npm run build:wasm:prepared:full
```

`prepare:wasm` may download/update source, recreate the disposable worktree, generate stubs/vendor patches, install the matching local `wasm-bindgen`, and write `.sui-build/patch-state.json`.

Prepared build scripts must treat the prepared workspace as input. `build:wasm:prepared:lite`, `build:wasm:prepared:full`, and `build:wasm:prepared` validate `patch-state.json` against `sui-version.json`, then build the requested profile. If calling the low-level script directly, use `node scripts/build-prepared-wasm.mjs --profile lite`, `--profile full`, or `--profile all`; do not pass profile overrides through the npm alias. Use `SUI_WASM_STRICT_OFFLINE=1` only when intentionally checking that Cargo does not reach the network.

After WASM and JS builds, verify that full and lite public version APIs report the pinned Sui version selected by `sui-version.json` or the explicit override.

For code or documentation changes, keep claims tied to verified behavior. Do not describe full Sui CLI parity unless the relevant stage-level behavior is covered by parity tests.

When adding a parity-sensitive integration test, update `test/integration/run.mjs`, the representative package scripts when needed, and this guide's required verification list in the same change.

`testMovePackage` is a full-artifact API. Do not add public test-runner options or lite/root exports only to satisfy integration tests. The unit-test output parity case covers the currently exposed full API behavior.

Publication update helpers consume successful external execution results and prepared build outputs. Do not add DApp Kit, wallet, signer, gas, sender, PTB execution, transaction-construction helpers, or non-CLI synthetic file creation to satisfy browser deployment examples.

Run build, parity, audit, and browser verification serially. These commands share `.sui-build`, `dist`, and Sui CLI cache state, so the default process does not use background jobs or parallel npm runners.

## Version-Up Review Checklist

Before implementing a Sui version-up, map the full dependency and artifact flow: `sui-version.json` -> pinned upstream source -> active compat manifest -> prepare patch targets -> Cargo workspace dependencies -> WASM profiles -> verification routes -> generated runtime config -> tests and docs. Use that map to decide the order of changes and the verification commands, not only the first failing command.

For every upstream native module, source file, cost parameter, or registration path newly added or newly imported by the pinned Sui source, inspect the selected upstream source before adding a compat patch. If the file is replaced by `scripts/compat`, compare exported public functions, required structs, native registrations, and `lib.rs` cost-parameter wiring. Add or update an automated compat-surface check when a missing manifest entry or stale stub would otherwise be discovered only during a later Cargo build.

Treat `prepare:wasm` Cargo failures as whole-workspace manifest and dependency-graph failures until proven narrower. Inspect the crate named in the error, its direct and transitive local path dependencies, and the selected upstream workspace root before deciding whether the fix belongs in the active compat manifest, a verifier-specific compat manifest, a source variant, or the local crate dependency list.

Any change to the local `sui-move-wasm` crate dependencies, build features, compat stubs, or prepared overlay can affect legacy verifier builds. After such a change, rebuild the affected legacy verifier recipes through `npm run build:bytecode-verifier -- --verifier <verifier-id>` or the aggregate verifier build. If a legacy verifier needs adaptation, add an isolated verifier-specific compat recipe; do not rely on the current compat overlay or allow a fallback to current patches.

For security-sensitive stubs, compare the error behavior with the nearest existing compat replacement before choosing abort codes, exported symbols, or reachability text. Crypto and signature stubs should fail closed, document their runtime reachability and security impact, and have a manifest entry that makes the replacement auditable.

When a parity fixture changes during version-up, first confirm the selected Sui CLI or pinned upstream source behavior that forces the fixture change. Preserve the property under test, rename or restructure the fixture only as needed to avoid unrelated state coupling, and avoid normalizing output just to keep an older expected value.

After changing verifier routing or generated verification config, rerun the generator and review the generated diff. `src/generated/verificationRuntimeConfig.ts` is evidence of the manifest state, not an independent editing surface.

Release workflows must not discover third-party build tools through unauthenticated "latest release" API calls. Pin external tool versions and archive checksums in the workflow or a tracked config file, then update them deliberately with source evidence when the tool must change.

## Parity and Hardcoding Rules

CLI parity is not just a passing test result. Treat it as a stage-by-stage match with the pinned Sui flow: `RootPackage` -> `PackageGraph` -> `BuildPlan` -> compiler/test runner -> output, digest, and lockfile.

Parity checks must use the installed `sui` CLI, or the explicit binary selected by `SUI_CLI`. Do not build a separate Sui CLI inside this repository for parity comparison. A CLI version mismatch is a warning and risk, not a reason to accept mismatched output.

Before changing routing, fallback, address handling, edition handling, dependency loading, lockfile behavior, compiler options, or verifier comparison semantics, confirm the selected CLI or pinned upstream Sui source behavior first. If that behavior cannot be confirmed, stop and report the missing evidence instead of choosing the behavior by assumption.

When preparing a new Sui version or changing parity-sensitive code, do not add:

- Silent empty-stub fallback for a missing compatibility overlay.
- New skipped dependency digest checks.
- Address or package-name filters that only match the current fixture output.
- Patch success checks based on debug print text.
- Output corrections using `0x1`, `0x2`, `0x3`, `0xb`, or similar constants without a pinned upstream Sui source reference.
- Auto-completed package metadata, generated dependency snapshots, or fallback package groups that exist only to make tests pass.

Unavoidable WASM differences are allowed, but they must be explicit. Record the reason, upstream reference, and test coverage in the compat manifest, `CLI_PIPELINE.md`, or both. If a new heuristic is needed, first identify the matching Sui CLI stage and add a parity fixture that would fail without the change.
Fallback behavior is acceptable only when the pinned Sui CLI would make the same stage-level decision. Missing package files, missing `Move.toml`, unsupported dependency sources, digest mismatches, and dependency cycles must resolve to the same CLI-equivalent fallback or a clear error, not to synthetic data.

For version-up parity, compare the visible final JSON and the stage outputs that create it. At minimum, inspect module count/order, bytecode header/version, dependency list/order, package digest, and generated `Move.lock` behavior. Classify differences as installed CLI mismatch, upstream API drift, compiler option drift, bytecode format drift, or compat patch drift. Do not hide a difference with fixture-specific normalization.

Verification version routing is bytecode-first. Use `scripts/verification/bytecode-version-sources.json` as the machine-readable list of Sui repo/tag/commit source records for scripts to fetch. Use `BYTECODE_VERSION_HISTORY.md` as the human and AI readable history of decoded bytecode versions and representative Sui tags/commits. Use `scripts/verification/bytecode-verifiers.json` as the supported verifier manifest and `npm run inventory:sui-tags` for upstream Sui tag inventory. The manifest `current` field names the current verifier ID; decoded bytecode version routing lives under `bytecodeVersions`. Before adding a legacy verifier, inspect Sui upstream release tags without assuming a known version is sufficient, select the representative verifier from decoded bytecode version and compiler output evidence, record the JSON source entry and Markdown history, and pin the Sui tag and commit in the manifest.

Verifier IDs are package-compatible handles for Sui source versions. Use `sui-<suiVersion>` when that Sui version uniquely identifies the selected tag/commit. If multiple relevant tags share a Sui version but produce different bytecode evidence, include the tag/network discriminator in the verifier ID and keep the exact tag and commit in the manifest.

Legacy verification builds must stay isolated under `.sui-build/bytecode-verifiers/<verifier-id>/`. Do not use `.sui-build/legacy-investigation/`, old npm package contents, or old builder source as build inputs; those are analysis artifacts only. Supported legacy verifier artifacts are bundled in this package under `dist/verification/v<decoded-bytecode-version>/` and loaded lazily by the `verification` entrypoint after it reads the reference module bytecode version. If a legacy build reports that it is falling back to the current compat overlay, treat that as a porting signal and add a verifier-specific `scripts/compat/bytecode-verifiers/<verifier-id>/manifest.json` before trusting later Cargo errors.

If a legacy verifier needs source API adaptation, keep the frozen verifier source under `sui-move-wasm/variants/<verifier-id>/src` and point the manifest `sourceVariantPath` at that `src` directory. Source variants contain `src/` only; `Cargo.toml`, `build.rs`, overrides, vendor path patching, and compatibility overlays still come from the normal crate root and verifier-specific compat manifest. Do not add fixture-specific normalization to a source variant. Treat source variants as frozen recipes; only backport fixes that affect verifier correctness, security, or bytecode evidence, and verify them against that variant's recorded fixtures.

AI assistance is for developing the repeatable verifier recipe: decoded bytecode version analysis, compat overlay creation, fixture selection, and review. Once a verifier entry and its `scripts/compat/bytecode-verifiers/<verifier-id>/manifest.json` are committed, release work should be a deterministic build of that recipe, not new ad hoc coding. A supported legacy verifier must be rebuildable through `npm run build:bytecode-verifier -- --verifier <verifier-id>` without consulting `.sui-build/legacy-investigation/` or rewriting patches.

During a future Sui version-up, first compare the new pinned Sui version against the previous current verifier's decoded bytecode version and bytecode serialization behavior. If both are unchanged, update the current builder/verifier only. If either changes, update `scripts/verification/bytecode-version-sources.json` and `BYTECODE_VERSION_HISTORY.md`, then preserve the previous current verifier as a legacy bytecode verifier by moving its fixed compat recipe under `scripts/compat/bytecode-verifiers/<old-verifier-id>/`, adding the old verifier to `scripts/verification/bytecode-verifiers.json` with `status: "legacy"`, and verifying that the legacy package can be rebuilt through the verifier build script. This forward path should not require reconstructing patches from history.

If this repository skips Sui updates for a long period, do not assume only the immediately previous pinned version matters. Regenerate upstream tag inventory with `npm run inventory:sui-tags`, analyze skipped mainnet/testnet/devnet decoded bytecode versions with `npm run analyze:bytecode-versions`, update `BYTECODE_VERSION_HISTORY.md`, and restore any missing legacy verifier whose decoded bytecode version or bytecode serialization behavior changes and whose representative fixture proves a distinct verification outcome. The goal is to preserve evidence-changing bytecode versions, not to build every patch release.

When adding or changing a legacy bytecode verifier, provide a representative transaction fixture pinned to exact source and dependency commits. Inspect the reference artifact with `npm run inspect:reference-artifact -- --artifact <path> --fail-on-warning` before promoting it, record the warning-free `referenceInspection` summary in `knownFixtures`, and prove the fixture with `scripts/verification/prove-bytecode-verifier-fixture.mjs`. Use `--refresh-fixture` when you need to prove from freshly fetched pinned source and transaction data instead of an existing `.sui-build` proof cache. A legacy verifier is useful only when it changes the evidence outcome, such as current verifier `bytecode_format_drift` versus matching legacy `exact_bytecode_match`, or when it records an intentional unsupported/failure state as diagnostic evidence.

Move edition handling must follow the selected verifier's pinned Sui CLI/source semantics. Record valid editions, compiler `Edition::default()` evidence, missing-edition compile fallback, and edition feature-list evidence in `scripts/verification/bytecode-version-sources.json` and `BYTECODE_VERSION_HISTORY.md`. Do not map unknown editions to `legacy`. A verifier that predates plain `edition = "2024"` must reject it instead of treating it as `2024.alpha`.

Porting checkpoints:

- Keep V4 `Move.lock` fetch-plan, graph validation, and generation in Rust/WASM. TypeScript may fetch snapshots and adapt wire data, but it must not add package-manager semantics when Rust or an upstream Sui crate can own them.
- Keep output dependency filtering in Rust/WASM. If package graph/linkage metadata is needed, prefer moving the source of truth toward Rust/upstream Sui types rather than adding TypeScript post-processing.
- Keep compiler setup aligned with the pinned `BuildPlan` behavior. The WASM path may construct `PackagePaths` directly, but any divergence from upstream source discovery, edition/flavor, lint, or test-mode behavior needs a source reference and fixture.
- Keep full test execution tied to root package ownership. Dependency package tests must not be run as root tests unless pinned CLI behavior changes.
- Treat prepare-time Cargo patch failures as porting blockers. Empty stubs are allowed only when declared in the compat manifest.

### Rust and TypeScript Boundary

The desired target is not just "same output as `sui move`"; supported paths should make the same stage-level decisions as pinned `sui move build` and `sui move test`: `RootPackage` -> `PackageGraph` -> linkage -> `BuildPlan` -> compiler/test runner -> output dependencies, package digest, and `Move.lock`.

TypeScript should be treated as the browser/Node adapter layer. Its responsibilities are:

- Browser/Node public API shape.
- GitHub, local, and custom fetcher integration. Local filesystem access must be host-provided through snapshots or `fetchLocal`; browser builds must not assume direct filesystem access.
- In-memory package file snapshots.
- Progress callbacks and option normalization.
- WASM initialization and result wrapping.

TypeScript may improve host snapshot loading, fetcher contracts, API wrapping, progress reporting, WASM initialization, and result formatting. It must not add dependency graph, linkage, lockfile, digest, output dependency, or test ownership semantics when Rust/WASM or an upstream Sui crate can own that behavior.

Rust/WASM should be the source of truth for Sui package semantics. Its responsibilities are:

- `Move.toml` and `Move.lock` meaning.
- Package graph construction and linkage.
- Manifest digest validation.
- Compiler input and source discovery.
- `BuildPlan`-equivalent compiler invocation.
- Output dependency IDs, package digest, and `Move.lock` generation.
- `sui move test` package ownership and filtering behavior.

Do not independently reimplement Sui package-manager semantics in TypeScript when Rust or an upstream Sui crate can own the behavior. If TypeScript must mirror Rust/Sui behavior, the code or documentation must identify the corresponding upstream Rust file/function, avoid a divergent fallback, and add a targeted parity fixture for that behavior.

Move source and TOML version behavior must follow the pinned CLI semantics as well. Treat `Move.toml`, network-specific `Move.<env>.toml`, `Move.lock` schema versions, `Published.toml`, package `edition`, dependency source forms, and lockfile migration rules as versioned inputs with CLI-defined behavior. Do not normalize, migrate, or ignore these files differently from the pinned Sui implementation unless the difference is documented as a WASM limitation and covered by a parity fixture.

V0/V1/V2 `Move.lock` dependency graph loading is not used as a graph source in this repository. Match the pinned CLI behavior for outdated lockfiles by rebuilding supported dependency graphs from manifests through Rust/WASM. Do not reintroduce JS compatibility graph loading for these formats.

Package loading is part of the TS host boundary. TS may collect files from GitHub, local workspaces, browser uploads, File System Access API, server endpoints, or custom caches, but it should hand Rust/WASM a complete package snapshot. Missing local dependency loaders, empty fetched packages, and dependency packages without `Move.toml` should fail explicitly rather than silently changing the dependency graph.

Prefer upstream Rust/Sui type and function reuse when porting to a new CLI version. If direct reuse is blocked by WASM host constraints, keep the compatibility layer narrow, document the unsupported host behavior, and add a fixture that protects the chosen behavior.

## WASM Compatibility Overlay

The `scripts/compat/` directory is the active WASM compatibility overlay for the pinned Sui version. It must include `manifest.json`. The manifest records the crate-to-compat-source map, explicit empty-stub crates, the crates that are stubbed or stripped during prepare, and upstream files that are overwritten.

When adding, deleting, or renaming a compat file, update the manifest in the same change. When the pinned Sui version changes, refresh the active overlay against the pinned upstream source and use git history only as reference.

Compat files that correspond to upstream source files or patch targets must be checked against the pinned upstream source before use. Apply only the minimum WASM-specific change needed. Local-only stubs and replacements must stay explicit in the manifest with their purpose, replacement scope, runtime reachability, security impact, and upstream reference.

Crypto, signature, randomness, storage, networking, TLS, lock, and filesystem replacements are security-sensitive. For each security-sensitive compat replacement, document whether it is unreachable in the browser build path or why the replacement is functionally safe for the supported WASM path. If that cannot be shown, keep the failure as a compat/patch issue instead of adding a permissive stub, skipped verification, or hollow implementation that only makes tests pass.

## Documentation and Comments

Keep documentation and comments focused on current instructions and verified behavior:

- `AGENTS.md` is for agent instructions only.
- `README.md` is for current user-facing behavior, setup, usage, and limitations.
- `CLI_PIPELINE.md` is for current implementation boundaries and verified coverage.
- Code comments should explain current behavior, upstream source references, or non-obvious WASM limitations.
- Documentation and comments must record the current state only, not work history or before/after narratives.
- Do not add work logs, decision history, retrospective notes, or "why this was changed" narratives to docs or comments.
- If an unavoidable WASM difference is documented, include the reason, upstream reference, and fixture or test coverage.

## Required Outputs

For a normal refactor or version-up task, produce these outputs:

- Updated source files or scripts with narrow, reviewable changes.
- `.sui-build/patch-state.json` from a successful prepare run when WASM preparation is part of the task.
- `dist/lite` and/or `dist/full` only after the prepared build commands succeed.
- Bundled bytecode verifier artifacts such as `dist/verification/v6/classic` and `dist/verification/v6/v7source-2024` only after `npm run build:bytecode-verifiers` or `npm run build` succeeds.
- Updated README/CLI_PIPELINE content only for facts confirmed by code or tests.
- Verified CLI and WASM full/lite runtime version exposure when version-up work produces runnable artifacts.
- A final report listing changed files, commands run, failures, and remaining risks.

Artifact-specific duties:

- `sui-version.json`: update it only when the pinned Sui version changes. Confirm the selected Sui version, tag, and commit from upstream, then keep CLI reports, WASM version exports, verification manifests, generated runtime config, and documentation in agreement with that pin.
- `.sui-build/patch-state.json`: produce it only through `npm run prepare:wasm`. Confirm that it records the selected version, tag, commit, compat manifest, and applied patch state. Do not hand-edit it.
- `dist/lite` and `dist/full`: build them only from a successful prepared workspace with `npm run build:wasm:prepared:lite` and `npm run build:wasm:prepared:full`. Rebuild them after any Rust, compat, prepared source, or version pin change that can affect WASM output. After JS build, verify their public pinned Sui version APIs.
- `dist/verification`: treat this as the current verifier artifact. Build it from the prepared current workspace with `npm run build:wasm:prepared:verification` or as part of `npm run build`. When the current verifier ID or route changes, update `scripts/verification/bytecode-verifiers.json`, regenerate `src/generated/verificationRuntimeConfig.ts`, and verify the verification WASM version API.
- `dist/verification/v<decoded-bytecode-version>/<verifier-route>`: treat these as legacy verifier artifacts. Build them only through `npm run build:bytecode-verifier -- --verifier <verifier-id>` or the package scripts that call it. Confirm the verifier has an isolated compat recipe, does not fall back to the current compat overlay, has manifest route metadata, and has fixture evidence when it is a supported runtime candidate.
- `scripts/compat/manifest.json` and files under `scripts/compat/`: update the manifest in the same change as any compat file addition, deletion, rename, or security-sensitive behavior change. For crypto, signature, randomness, storage, networking, TLS, lock, and filesystem replacements, record reachability and security impact before trusting the build result.
- `scripts/verification/bytecode-version-sources.json` and `BYTECODE_VERSION_HISTORY.md`: before changing verifier routing during a Sui version-up, compare the new pinned Sui source with the previous current verifier for decoded bytecode version and bytecode serialization evidence. If decoded bytecode version, flavor, table layout, serializer behavior, deserializer behavior, or compiler edition capability changes, record the evidence and preserve the previous current verifier as legacy when it has a distinct verification outcome. If those evidence-changing fields are unchanged, update the current verifier record only and document the non-routing source change, such as protocol config drift, in the final report.
- `src/generated/verificationRuntimeConfig.ts`: regenerate it from `scripts/verification/bytecode-verifiers.json`; do not hand-edit it.
- `README.md`, `CLI_PIPELINE.md`, `VERIFICATION.md`, and `SECURITY.md`: update them only for current facts confirmed by source, prepare/build output, or tests. When `AGENTS.md`, `README.md`, or `CLI_PIPELINE.md` changes, run the required documentation checks before submitting.

If a check cannot run, record the exact reason. Do not describe skipped or blocked checks as passed. Distinguish sandbox, permission, network, missing local tool, and real code/test failures.

Use this failure report shape when a command or validation step fails:

```text
Failure:
- Command:
- Result:
- Category: sandbox | permission | network | missing local tool | real code/test failure | upstream API drift | native dependency issue | Cargo feature issue | compat/patch issue
- Evidence:
- Next required action:
```

If a default check fails for reasons unrelated to `AGENTS.md`, record it as an existing or unrelated failure instead of expanding a documentation-only task scope.

### Do Not Commit

Unless explicitly allowed, do not commit:

- `.sui-build/`
- `dist/`
- generated wasm-bindgen output

Any exception must be required by explicit project policy or by an explicit task request that specifically names the generated state to be committed.

## Sui WASM Version-Up Agent Prompt

The prompt below is a task launcher summary. If it conflicts with the rules above, the rules above win.

Use this prompt when preparing a new Sui version for this repository.

```text
You are the Sui WASM Version-Up Agent for this repository.

Goal:
Prepare a new Sui version for WASM build without polluting the pristine upstream source.

Inputs:
- Target Sui version/tag/commit
- Existing repo with `scripts/compat`
- Build flow: prepare:wasm -> build:wasm:prepared:lite/full -> tests

Rules:
- Do not edit .sui-build/source directly.
- Use a disposable worktree under .sui-build/work.
- Keep generated artifacts under .sui-build/generated.
- Use AGENTS.md as the single instruction source; do not create another duplicate guide.
- Refresh the active `scripts/compat` overlay for the target version when a compatibility overlay is required.
- Compat files that correspond to upstream source files or patch targets must be checked against the pinned upstream source before use.
- Review security-sensitive compat replacements for crypto, signature, randomness, storage, networking, TLS, lock, and filesystem behavior. Record whether each replacement is unreachable in the browser path or functionally safe for the supported WASM path.
- Use only the installed `sui` CLI or the binary selected by `SUI_CLI` for parity comparison. Do not build a separate Sui CLI in this repository for parity.
- Treat missing `sui` as an error. Treat installed CLI version mismatch as a warning and parity risk, not as permission to accept mismatched output.
- Do not claim CLI parity unless parity tests pass.
- Do not add fixture-only hardcoding, silent empty-stub fallbacks, or skipped digest checks.
- Do not add permissive security stubs, skipped verification, synthetic package metadata, generated fallback package groups, or output corrections to make parity tests pass.
- Do not add TypeScript package-manager heuristics for graph, linkage, lockfile, digest, output dependency, or test ownership behavior.
- Before adding a heuristic, identify the upstream Sui CLI stage and source file it is trying to match.
- Add or update a parity fixture for every new package-manager, lockfile, output dependency, or test-runner behavior.
- Treat missing expected patch targets as porting failures unless there is a documented upstream removal.
- Keep the Rust/TypeScript boundary clear: TypeScript should adapt files/fetchers/options, while Rust/WASM should own Sui package-manager, compiler, digest, lockfile, and test-plan semantics.
- Prefer upstream Rust/Sui type and function reuse before writing compatibility code.
- If TypeScript must mirror Rust behavior, record the upstream Rust source reference and add a targeted parity fixture.
- Treat behavior that differs from `sui move build` or `sui move test` as a documented limitation or explicit compatibility patch, not as a hidden fallback.
- Preserve pinned CLI behavior for `Move.toml`, `Move.<env>.toml`, `Move.lock` schema versions, `Published.toml`, package `edition`, and lockfile migration. Do not silently reinterpret versioned TOML formats.
- Treat package file loading as a host snapshot responsibility. Do not add hidden filesystem assumptions; use explicit fetcher/snapshot contracts and fail clearly when local dependencies cannot be loaded.
- If a check cannot run, record the exact reason and do not present it as passed.
- Keep README/CLI_PIPELINE and code comments limited to current verified behavior, implementation boundaries, upstream references, and WASM limitations. Do not add work logs or retrospective notes.

Tasks:
1. Run preflight:
   - identify target version/tag/commit
   - check whether `sui-version.json` or env/script overrides will select the target
   - check CLI and WASM version exposure paths
   - verify `scripts/compat/manifest.json`
   - check installed `sui` or `SUI_CLI`; fail if missing and warn if it differs from the pinned version
   - inspect dirty worktree state and preserve unrelated changes
2. Update sui-version.json for the target Sui version when the task requires a pinned version change.
3. Refresh the active compat overlay:
   - re-read upstream source files for every compat patch target that has a matching upstream file
   - keep local-only stubs explicit in `scripts/compat/manifest.json`
   - record purpose, replacement scope, runtime reachability, security impact, and upstream reference for security-sensitive replacements
4. Run the prepare pipeline and record failures.
5. For each failure, identify whether it is:
   - missing WASM-compatible stub
   - Cargo feature issue
   - native dependency issue
   - upstream API drift
   - test runner/full-build issue
6. Add the minimal compatibility overlay change needed.
7. Re-run prepare until patch-state.json is produced.
8. Run prepared lite build:
   - npm run build:wasm:prepared:lite
9. Run prepared full build:
   - npm run build:wasm:prepared:full
10. Run JS build:
   - npm run build:js
11. Run targeted and parity checks:
   - npm run typecheck
   - npm run lint
   - npm run format:check
   - npm test
   - npm run test:audit
   - verify full/lite public version APIs expose the pinned Sui version
12. Audit CLI/WASM stage outputs before claiming parity:
   - compare module count/order, bytecode header/version, dependency list/order, digest, and generated `Move.lock` behavior
   - classify differences as installed CLI mismatch, upstream API drift, compiler option drift, bytecode format drift, or compat patch drift
13. Run browser and release checks when the environment supports them:
   - npm run test:browser
   - npm run release:check
14. Update README/CLI_PIPELINE only for facts confirmed by code/tests.
15. Produce a final report:
   - target Sui version and commit
   - compat overlay used
   - files changed
   - compat files added/changed
   - installed Sui CLI path/version and any mismatch warning
   - CLI and WASM full/lite runtime version exposure results
   - security-sensitive compat replacements reviewed
   - CLI/WASM stage-output differences or confirmation
   - build/test commands run
   - skipped checks with reasons
   - failures or remaining risks

Output:
A concise implementation summary with exact changed files and verification results.
```
