#[cfg(feature = "testing")]
use move_compiler::{linters::LintLevel, Compiler};
use move_core_types::account_address::AccountAddress;
#[cfg(feature = "testing")]
use move_unit_test::{vm_test_setup::VMTestSetup, UnitTestingConfig};
#[cfg(feature = "testing")]
use move_vm_config::runtime::VMConfig;
#[cfg(feature = "testing")]
use move_vm_runtime::{
    dev_utils::gas_schedule::{unit_cost_schedule, Gas, GasStatus},
    natives::{extensions::NativeContextExtensions, functions::NativeFunctionTable},
};
use serde::{Deserialize, Serialize};
#[cfg(feature = "testing")]
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
#[cfg(feature = "testing")]
use std::rc::Rc;
#[cfg(feature = "testing")]
use std::sync::Arc;
#[cfg(feature = "testing")]
use sui_protocol_config::ProtocolConfig;
#[cfg(feature = "testing")]
use sui_types::{
    base_types::{SuiAddress, TxContext},
    digests::TransactionDigest,
    in_memory_storage::InMemoryStorage,
    metrics::LimitsMetrics,
};
use wasm_bindgen::prelude::*;

#[cfg(feature = "verification")]
pub(crate) struct CompileResult {
    success: bool,
    output: String, // JSON string of compiled units or errors
}

#[cfg(feature = "verification")]
impl CompileResult {
    pub(crate) fn success(&self) -> bool {
        self.success
    }

    pub(crate) fn output(&self) -> String {
        self.output.clone()
    }
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub struct WasmCompileResult {
    success: bool,
    output: String,
}

#[cfg(not(feature = "verification"))]
pub(crate) type CompileResult = WasmCompileResult;

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
impl WasmCompileResult {
    #[wasm_bindgen(getter)]
    pub fn success(&self) -> bool {
        self.success
    }

    #[wasm_bindgen(getter)]
    pub fn output(&self) -> String {
        self.output.clone()
    }
}

/// Compilation output containing bytecode and dependency metadata.
///
/// ORIGINAL SOURCE REFERENCES:
/// - sui/crates/sui-move-build/src/lib.rs - CompiledPackage struct
#[derive(Serialize)]
pub struct WasmCompilationOutput {
    modules: Vec<String>,      // Base64 encoded bytecode
    dependencies: Vec<String>, // Hex encoded dependency IDs
    digest: Vec<u8>,           // Blake2b-256 package digest
    #[serde(skip_serializing_if = "Option::is_none")]
    warnings: Option<String>,
}

mod compiler_support;
mod helper;
mod lockfile_v4;
mod manifest;
mod manifest_digest;
mod package_model;
mod publication;
mod stage_report;
mod system_packages;
#[cfg(feature = "verification")]
mod verification;
use helper::HelperError;
use lockfile_v4::{
    LockfileV4GenerateInput, LockfileV4PackageGroup, LockfileV4PackageGroupManifest,
    LockfileV4PackageGroups, LockfileV4PackageManifest, LockfileV4Source, LockfileV4ValidateInput,
    LockfileV4ValidatePackage, LockfileV4ValidatedEdge, LockfileV4ValidatedGraph,
    LockfileV4ValidatedPackage, LockfileV4ValidationResult,
};
use manifest_digest::{CombinedDependencySource, CombinedMoveDependency, ManifestPackagePlanSubst};
#[cfg(feature = "testing")]
use move_symbol_pool::Symbol;
use package_model::parse_hex_address_to_bytes;
#[cfg(feature = "testing")]
use package_model::{build_compiler_input, CompilerInput, CompilerInputMode};
use stage_report::StageReport;

fn package_version_from_lock(lock_contents: &str, package_name: &str) -> Option<String> {
    let mut in_pkg = false;
    for line in lock_contents.lines() {
        let trimmed = line.trim();
        if trimmed == "[[package]]" {
            in_pkg = false;
            continue;
        }
        if trimmed == format!("name = \"{}\"", package_name) {
            in_pkg = true;
            continue;
        }
        if in_pkg && trimmed.starts_with("version = \"") {
            let mut parts = trimmed.split('"');
            parts.next();
            if let Some(version) = parts.next() {
                return Some(version.to_string());
            }
        }
    }
    None
}

fn append_git_revision(version: String) -> String {
    if let Some(revision) = option_env!("GIT_REVISION") {
        if revision.is_empty() {
            version
        } else {
            format!("{}-{}", version, revision)
        }
    } else {
        version
    }
}

#[wasm_bindgen]
pub fn sui_move_version() -> String {
    if let Some(version) = option_env!("SUI_MOVE_VERSION") {
        return version.to_string();
    }
    let lock_contents = ""; // include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock"));
    match package_version_from_lock(lock_contents, "sui-move") {
        Some(version) => append_git_revision(version),
        None => "unknown".to_string(),
    }
}

#[wasm_bindgen]
pub fn sui_version() -> String {
    if let Some(version) = option_env!("SUI_VERSION") {
        return version.to_string();
    }
    let lock_contents = ""; // include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock"));
    match package_version_from_lock(lock_contents, "sui") {
        Some(version) => append_git_revision(version),
        None => "unknown".to_string(),
    }
}

#[cfg(feature = "testing")]
#[wasm_bindgen]
pub struct WasmTestResult {
    passed: bool,
    output: String,
}

#[cfg(feature = "testing")]
#[wasm_bindgen]
impl WasmTestResult {
    #[wasm_bindgen(getter)]
    pub fn passed(&self) -> bool {
        self.passed
    }

    #[wasm_bindgen(getter)]
    pub fn output(&self) -> String {
        self.output.clone()
    }
}

#[cfg(feature = "testing")]
struct SuiWasmVMTestSetup {
    protocol_config: ProtocolConfig,
    native_function_table: NativeFunctionTable,
    cost_table: move_vm_runtime::dev_utils::gas_schedule::CostTable,
}

#[cfg(feature = "testing")]
impl SuiWasmVMTestSetup {
    fn new() -> Self {
        let protocol_config = ProtocolConfig::get_for_max_version_UNSAFE();
        let native_function_table = sui_move_natives::all_natives(false, &protocol_config);
        Self {
            protocol_config,
            native_function_table,
            cost_table: unit_cost_schedule(),
        }
    }
}

#[cfg(feature = "testing")]
impl VMTestSetup for SuiWasmVMTestSetup {
    type Meter<'a> = GasStatus<'a>;
    type ExtensionsBuilder<'a> = sui_move_natives::test_scenario::InMemoryTestStore;

    fn new_meter<'a>(&'a self, execution_bound: Option<u64>) -> Self::Meter<'a> {
        match execution_bound {
            Some(bound) => GasStatus::new(&self.cost_table, Gas::new(bound)),
            None => GasStatus::new_unmetered(),
        }
    }

    fn used_gas<'a>(&'a self, execution_bound: u64, meter: Self::Meter<'a>) -> u64 {
        Gas::new(execution_bound)
            .checked_sub(meter.remaining_gas())
            .unwrap()
            .into()
    }

    fn vm_config(&self) -> VMConfig {
        VMConfig::default()
    }

    fn native_function_table(&self) -> NativeFunctionTable {
        self.native_function_table.clone()
    }

    fn new_extensions_builder(&self) -> Self::ExtensionsBuilder<'_> {
        sui_move_natives::test_scenario::InMemoryTestStore(RefCell::new(InMemoryStorage::default()))
    }

    fn new_native_context_extensions<'ext>(
        &self,
        store: &'ext Self::ExtensionsBuilder<'_>,
    ) -> NativeContextExtensions<'ext> {
        let mut ext = NativeContextExtensions::default();
        let registry = prometheus::Registry::new();
        let metrics = Arc::new(LimitsMetrics::new(&registry));

        ext.add(sui_move_natives::object_runtime::ObjectRuntime::new(
            store,
            BTreeMap::new(),
            false,
            Box::leak(Box::new(ProtocolConfig::get_for_max_version_UNSAFE())),
            metrics,
            0,
        ));
        ext.add(sui_move_natives::NativesCostTable::from_protocol_config(
            &self.protocol_config,
        ));
        let tx_context = TxContext::new_from_components(
            &SuiAddress::ZERO,
            &TransactionDigest::default(),
            &0,
            0,
            0,
            0,
            0,
            None,
            &self.protocol_config,
        );
        ext.add(
            sui_move_natives::transaction_context::TransactionContext::new_for_testing(Rc::new(
                RefCell::new(tx_context),
            )),
        );
        ext.add(store);
        ext
    }
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn compile(
    files_json: &str,
    dependencies_json: &str,
    options_json: Option<String>,
) -> WasmCompileResult {
    compiler_support::compile_impl(files_json, dependencies_json, options_json)
}

#[cfg(feature = "verification")]
#[wasm_bindgen]
pub fn verify_against_reference(input_json: &str) -> String {
    verification::verify_against_reference(input_json)
}

#[cfg(feature = "verification")]
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
enum VerificationResolvePackageGroupsInput {
    LockfileFetchPlan {
        #[serde(rename = "moveLockToml")]
        move_lock_toml: String,
        environment: String,
    },
    LockfileResolvePackageGroups {
        input: serde_json::Value,
    },
    ManifestGraphResolvePackageGroups {
        input: serde_json::Value,
    },
    LegacyPublicationMigration {
        input: serde_json::Value,
    },
}

#[cfg(feature = "verification")]
#[wasm_bindgen]
pub fn verification_resolve_package_groups(input_json: &str) -> String {
    let input: VerificationResolvePackageGroupsInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return lockfile_v4_error_with_code(
                "invalid_helper_input",
                format!("Invalid verification resolver input: {}", error),
            );
        }
    };

    match input {
        VerificationResolvePackageGroupsInput::LockfileFetchPlan {
            move_lock_toml,
            environment,
        } => match lockfile_v4::plan_from_toml(&move_lock_toml, &environment) {
            Ok(Some((root_id, lockfile_order, packages))) => {
                let stage_reports =
                    vec![StageReport::new("move_lock_fetch_plan", &environment, &[])
                        .package_id(root_id.clone())
                        .node_count(packages.len())];
                serde_json::json!({
                    "status": "ok",
                    "rootId": root_id,
                    "lockfileOrder": lockfile_order,
                    "packages": packages,
                    "stageReports": stage_reports,
                })
                .to_string()
            }
            Ok(None) => lockfile_v4_missing(format!(
                "Move.lock V4 has no pinned.{} section",
                environment
            )),
            Err(error) => lockfile_v4_error_from_helper(error),
        },
        VerificationResolvePackageGroupsInput::LockfileResolvePackageGroups { input } => {
            let input: LockfileV4ValidateInput = match serde_json::from_value(input) {
                Ok(input) => input,
                Err(error) => {
                    return lockfile_v4_error_with_code(
                        "invalid_helper_input",
                        format!("Invalid lockfile V4 package-group input: {}", error),
                    );
                }
            };

            let graph = match lockfile_v4_validate_graph_impl(&input) {
                LockfileV4ValidationResult::Ok(graph) => graph,
                LockfileV4ValidationResult::OutOfDate(package_id) => {
                    return lockfile_v4_out_of_date(package_id)
                }
                LockfileV4ValidationResult::Error(error) => return lockfile_v4_error(error),
            };

            let active_edge_count = graph
                .edges
                .iter()
                .filter(|edge| lockfile_v4_edge_matches_modes(edge, &input.modes))
                .count();
            let stage_reports =
                vec![
                    StageReport::new("move_lock_graph", &input.environment, &input.modes)
                        .package_id(graph.root_id.clone())
                        .node_count(graph.packages.len())
                        .edge_count(graph.edges.len())
                        .active_edge_count(active_edge_count),
                ];
            match lockfile_v4_package_groups_from_validated(&input, graph) {
                Ok(groups) => {
                    let mut reports = stage_reports;
                    reports.push(
                        StageReport::new("move_lock_linkage", &input.environment, &input.modes)
                            .linked_node_count(groups.dependencies.len()),
                    );
                    serde_json::json!({
                        "status": "ok",
                        "rootFiles": groups.root_files,
                        "dependencies": groups.dependencies,
                        "lockfileDependencies": groups.lockfile_dependencies,
                        "stageReports": reports,
                    })
                    .to_string()
                }
                Err(error) => lockfile_v4_error(error),
            }
        }
        VerificationResolvePackageGroupsInput::ManifestGraphResolvePackageGroups { input } => {
            let input: ManifestGraphInput = match serde_json::from_value(input) {
                Ok(input) => input,
                Err(error) => {
                    return lockfile_v4_error_with_code(
                        "invalid_helper_input",
                        format!("Invalid manifest graph input: {}", error),
                    );
                }
            };

            match manifest_graph_resolve_package_groups_impl(input) {
                Ok(response) => response.to_string(),
                Err(error) => lockfile_v4_error_from_helper(error),
            }
        }
        VerificationResolvePackageGroupsInput::LegacyPublicationMigration { input } => {
            publication::legacy_publication_migration_from_value(input)
        }
    }
}

#[cfg(feature = "testing")]
fn default_test_ansi_color() -> bool {
    true
}

#[cfg(feature = "testing")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmTestOptions {
    #[serde(default = "default_test_ansi_color")]
    ansi_color: bool,
    #[serde(default)]
    modes: Vec<String>,
}

#[cfg(feature = "testing")]
impl Default for WasmTestOptions {
    fn default() -> Self {
        Self {
            ansi_color: true,
            modes: Vec::new(),
        }
    }
}

#[cfg(feature = "testing")]
fn default_sui_unit_test_bound() -> u64 {
    ProtocolConfig::get_for_max_version_UNSAFE().max_tx_gas()
}

#[cfg(feature = "testing")]
fn test_impl(
    files_json: &str,
    dependencies_json: &str,
    options_json: Option<String>,
) -> WasmTestResult {
    console_error_panic_hook::set_once();

    let options: WasmTestOptions = match options_json {
        Some(json) => match serde_json::from_str(&json) {
            Ok(options) => options,
            Err(error) => {
                return WasmTestResult {
                    passed: false,
                    output: format!("Invalid test options: {}", error),
                }
            }
        },
        None => WasmTestOptions::default(),
    };

    colored::control::set_override(options.ansi_color);
    let ansi_color = options.ansi_color;

    let (root, files, dep_packages) =
        match compiler_support::setup_vfs(files_json, dependencies_json) {
            Ok(res) => res,
            Err(e) => {
                return WasmTestResult {
                    passed: false,
                    output: e,
                };
            }
        };

    let compiler_input =
        match build_compiler_input(&files, &dep_packages, CompilerInputMode::TestRunner) {
            Ok(input) => input,
            Err(error) => {
                return WasmTestResult {
                    passed: false,
                    output: error,
                }
            }
        };
    let CompilerInput {
        root_package_name,
        package_paths,
        ..
    } = compiler_input;

    let compiler = match Compiler::from_package_paths(Some(root), package_paths, Vec::new()) {
        Ok(c) => c,
        Err(e) => {
            return WasmTestResult {
                passed: false,
                output: format!("Failed to create compiler: {}", e),
            }
        }
    };

    let test_modes = {
        let mut modes = options.modes;
        if !modes.iter().any(|mode| mode == "test") {
            modes.push("test".to_string());
        }
        modes
    };
    let build_config = compiler_support::compiler_build_config(false, LintLevel::None, test_modes);
    let compiler = compiler_support::configure_compiler_for_sui(compiler, &build_config);
    let (files_info, comments_and_compiler_res) =
        match compiler.run::<{ move_compiler::PASS_CFGIR }>() {
            Ok(res) => res,
            Err(e) => {
                return WasmTestResult {
                    passed: false,
                    output: format!("Compiler error: {}", e),
                }
            }
        };

    let compiler = match comments_and_compiler_res {
        Ok(c) => c,
        Err((_severity, diags)) => {
            let buffer = move_compiler::diagnostics::report_diagnostics_to_buffer(
                &files_info,
                diags,
                ansi_color,
            );
            return WasmTestResult {
                passed: false,
                output: String::from_utf8_lossy(&buffer).to_string(),
            };
        }
    };

    let (compiler, cfgir) = compiler.into_ast();
    let compilation_env = compiler.compilation_env();
    let test_tests = move_compiler::unit_test::plan_builder::construct_test_plan(
        compilation_env,
        Some(Symbol::from(root_package_name.as_str())),
        &cfgir,
    );
    let mapped_files = compilation_env.mapped_files().clone();

    // Reconstruct/continue compilation to get units
    let compilation_result = compiler.at_cfgir(cfgir).build();
    let (units, _) = match compilation_result {
        Ok(res) => res,
        Err((_severity, diags)) => {
            let buffer = move_compiler::diagnostics::report_diagnostics_to_buffer(
                &files_info,
                diags,
                ansi_color,
            );
            return WasmTestResult {
                passed: false,
                output: String::from_utf8_lossy(&buffer).to_string(),
            };
        }
    };

    let units: Vec<_> = units.into_iter().map(|unit| unit.named_module).collect();

    let test_plan = match test_tests {
        Some(tests) => move_compiler::unit_test::TestPlan::new(tests, mapped_files, units, vec![]),
        None => {
            return WasmTestResult {
                passed: true,
                output: "No tests found".to_string(),
            }
        }
    };

    let default_config = UnitTestingConfig::default_with_bound(Some(default_sui_unit_test_bound()));
    let config = UnitTestingConfig {
        gas_limit: Some(default_sui_unit_test_bound()),
        report_stacktrace_on_abort: true,
        ..default_config
    };

    let output_buffer = std::io::Cursor::new(Vec::new());
    let (output_buffer, passed) =
        match config.run_and_report_unit_tests(test_plan, SuiWasmVMTestSetup::new(), output_buffer)
        {
            Ok(res) => res,
            Err(e) => {
                return WasmTestResult {
                    passed: false,
                    output: format!("Test runner error: {}", e),
                }
            }
        };

    let output_str = String::from_utf8_lossy(output_buffer.get_ref()).to_string();

    WasmTestResult {
        passed,
        output: output_str,
    }
}

#[cfg(feature = "testing")]
#[wasm_bindgen]
pub fn test_with_options(
    files_json: &str,
    dependencies_json: &str,
    options_json: String,
) -> WasmTestResult {
    test_impl(files_json, dependencies_json, Some(options_json))
}

/// Compute manifest digest from a Move.toml manifest. This is the preferred
/// WASM entrypoint because Rust owns the Move.toml dependency semantics.
#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn compute_manifest_digest_from_move_toml(
    move_toml: &str,
    package_name_override: Option<String>,
    environment: &str,
) -> String {
    manifest_digest::compute_manifest_digest_from_move_toml(
        move_toml,
        package_name_override,
        environment,
    )
}

/// Backward-compatible JSON entrypoint. New code should prefer
/// `compute_manifest_digest_from_move_toml`.
#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn compute_manifest_digest(deps_json: &str) -> String {
    manifest_digest::compute_manifest_digest(deps_json)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestPackagePlanDependency {
    name: String,
    source: ManifestPackagePlanSource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    modes: Vec<String>,
    #[serde(
        rename = "isOverride",
        default,
        skip_serializing_if = "manifest_plan_is_false"
    )]
    is_override: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    subst: Option<BTreeMap<String, ManifestPackagePlanSubst>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ManifestPackagePlanSource {
    Git {
        git: String,
        rev: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
        #[serde(rename = "isImplicit", skip_serializing_if = "manifest_plan_is_false")]
        is_implicit: bool,
    },
    Local {
        local: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestGraphInput {
    environment: String,
    #[serde(default)]
    framework_rev: Option<String>,
    #[serde(default)]
    modes: Vec<String>,
    root: ManifestGraphPackageSnapshot,
    #[serde(default)]
    packages: Vec<ManifestGraphPackageSnapshot>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestGraphPackageSnapshot {
    source: LockfileV4Source,
    #[serde(default)]
    requested_source: Option<LockfileV4Source>,
    #[serde(default)]
    files: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestGraphFetchRequest {
    source: LockfileV4Source,
    dependency_name: String,
    parent_package_name: String,
    parent_source: LockfileV4Source,
}

struct ManifestGraphNode {
    id: String,
    source: LockfileV4Source,
    files: BTreeMap<String, String>,
    manifest: LockfileV4PackageManifest,
    dep_alias_to_package_name: BTreeMap<String, String>,
}

fn manifest_plan_is_false(value: &bool) -> bool {
    !*value
}

fn lockfile_v4_error_response(error: String, code: Option<&'static str>) -> String {
    helper::error_response(error, code)
}

fn lockfile_v4_error(error: impl Into<String>) -> String {
    lockfile_v4_error_response(error.into(), None)
}

fn lockfile_v4_error_with_code(code: &'static str, error: impl Into<String>) -> String {
    helper::error_with_code(code, error)
}

fn lockfile_v4_error_from_helper(error: HelperError) -> String {
    helper::error_from_helper(error)
}

fn lockfile_v4_out_of_date(package_id: impl Into<String>) -> String {
    serde_json::json!({
        "status": "out_of_date",
        "code": "lockfile_out_of_date",
        "reason": "out_of_date",
        "packageId": package_id.into(),
    })
    .to_string()
}

fn lockfile_v4_missing(reason: impl Into<String>) -> String {
    serde_json::json!({
        "status": "missing",
        "reason": reason.into(),
    })
    .to_string()
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn lockfile_v4_fetch_plan(move_lock_toml: &str, environment: &str) -> String {
    match lockfile_v4::plan_from_toml(move_lock_toml, environment) {
        Ok(Some((root_id, lockfile_order, packages))) => {
            let stage_reports = vec![StageReport::new("move_lock_fetch_plan", environment, &[])
                .package_id(root_id.clone())
                .node_count(packages.len())];
            serde_json::json!({
                "status": "ok",
                "rootId": root_id,
                "lockfileOrder": lockfile_order,
                "packages": packages,
                "stageReports": stage_reports,
            })
            .to_string()
        }
        Ok(None) => lockfile_v4_missing(format!(
            "Move.lock V4 has no pinned.{} section",
            environment
        )),
        Err(error) => lockfile_v4_error_from_helper(error),
    }
}

fn normalize_hex_address_string(value: &str) -> Option<String> {
    parse_hex_address_to_bytes(value)
        .map(|bytes| AccountAddress::new(bytes).to_canonical_string(true))
}

fn is_move_named_address(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn lockfile_v4_normalize_nonzero_address(value: &str) -> Option<String> {
    let normalized = normalize_hex_address_string(value)?;
    if normalized == "0x0000000000000000000000000000000000000000000000000000000000000000" {
        None
    } else {
        Some(normalized)
    }
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn root_publication_metadata(input_json: &str) -> String {
    publication::root_publication_metadata_json(input_json)
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn publication_update(input_json: &str) -> String {
    publication::publication_update_json(input_json)
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn legacy_publication_migration(input_json: &str) -> String {
    publication::legacy_publication_migration_json(input_json)
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn lockfile_v4_generate(input_json: &str) -> String {
    let input: LockfileV4GenerateInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return lockfile_v4_error_with_code(
                "invalid_helper_input",
                format!("Invalid lockfile V4 generation input: {}", error),
            );
        }
    };

    match lockfile_v4::generate(input) {
        Ok(lockfile) => serde_json::json!({
            "status": "ok",
            "lockfile": lockfile,
        })
        .to_string(),
        Err(error) => lockfile_v4_error_from_helper(error),
    }
}

fn lockfile_v4_validate_graph_impl(input: &LockfileV4ValidateInput) -> LockfileV4ValidationResult {
    let mut root_ids = vec![];
    let mut package_ids = BTreeSet::new();
    for package in &input.packages {
        if matches!(package.source, LockfileV4Source::Root) {
            root_ids.push(package.id.clone());
        }
        package_ids.insert(package.id.clone());
    }
    if root_ids.is_empty() {
        return LockfileV4ValidationResult::Error(format!(
            "Move.lock V4 pinned.{} has no root package entry",
            input.environment
        ));
    }
    if root_ids.len() > 1 {
        return LockfileV4ValidationResult::Error(format!(
            "Move.lock V4 pinned.{} has multiple root package entries",
            input.environment
        ));
    }
    let root_id = root_ids[0].clone();

    let mut validated_packages = vec![];
    let mut edges = vec![];
    let mut lockfile_order = vec![];

    for package in &input.packages {
        lockfile_order.push(package.id.clone());

        let files = if matches!(package.source, LockfileV4Source::Root) {
            let mut root_files = package.files.clone();
            root_files
                .entry("Move.toml".to_string())
                .or_insert_with(|| input.root_move_toml.clone());
            root_files
        } else {
            package.files.clone()
        };

        let (manifest, _move_toml) =
            match lockfile_v4::manifest_from_files(&package.id, &files, &input.environment) {
                Ok(result) => result,
                Err(error) => return LockfileV4ValidationResult::Error(error),
            };
        if let Err(error) = lockfile_v4_validate_manifest_dependency_names(&manifest) {
            return LockfileV4ValidationResult::Error(error);
        }

        if let Some(expected_digest) = package.manifest_digest.as_ref() {
            let current_digest = manifest_digest::compute_manifest_digest_from_combined(
                manifest.combined_dependencies.clone(),
            )
            .unwrap_or_default();
            if !current_digest.eq_ignore_ascii_case(expected_digest) {
                return LockfileV4ValidationResult::OutOfDate(package.id.clone());
            }
        } else {
            return LockfileV4ValidationResult::OutOfDate(package.id.clone());
        }

        let lockfile_deps = manifest
            .combined_dependencies
            .iter()
            .map(|dep| dep.name.clone())
            .collect::<BTreeSet<_>>();
        for alias in &lockfile_deps {
            if !package.deps.contains_key(alias) {
                return LockfileV4ValidationResult::Error(format!(
                    "Move.lock V4 pinned.{}.{} is missing dependency '{}'",
                    input.environment, package.id, alias
                ));
            }
        }

        let dep_modes_by_alias = manifest
            .combined_dependencies
            .iter()
            .map(|dep| (dep.name.clone(), dep.modes.clone().unwrap_or_default()))
            .collect::<BTreeMap<_, _>>();
        let dep_override_by_alias = manifest
            .combined_dependencies
            .iter()
            .map(|dep| (dep.name.clone(), dep.is_override))
            .collect::<BTreeMap<_, _>>();
        let active_aliases = manifest
            .combined_dependencies
            .iter()
            .filter(|dep| manifest_digest::combined_dependency_matches_modes(dep, &input.modes))
            .map(|dep| dep.name.clone())
            .collect::<BTreeSet<_>>();
        let lockfile_dep_map = package
            .deps
            .iter()
            .filter(|(alias, _)| lockfile_deps.contains(*alias))
            .map(|(alias, target_id)| (alias.clone(), target_id.clone()))
            .collect::<BTreeMap<_, _>>();

        for (alias, target_id) in &lockfile_dep_map {
            if !package_ids.contains(target_id) {
                return LockfileV4ValidationResult::Error(format!(
                    "Move.lock V4 pinned.{}.{} references undefined dependency '{}'",
                    input.environment, package.id, target_id
                ));
            }
            if active_aliases.contains(alias) {
                edges.push(LockfileV4ValidatedEdge {
                    from: package.id.clone(),
                    to: target_id.clone(),
                    alias: alias.clone(),
                    modes: dep_modes_by_alias.get(alias).cloned().unwrap_or_default(),
                    is_override: dep_override_by_alias.get(alias).copied().unwrap_or(false),
                });
            }
        }
        let active_dep_map = lockfile_dep_map
            .iter()
            .filter(|(alias, _)| active_aliases.contains(*alias))
            .map(|(alias, target_id)| (alias.clone(), target_id.clone()))
            .collect::<BTreeMap<_, _>>();

        validated_packages.push(LockfileV4ValidatedPackage {
            id: package.id.clone(),
            source: package.source.clone(),
            manifest,
            dep_alias_to_package_name: lockfile_dep_map,
            active_dep_alias_to_package_name: active_dep_map,
        });
    }

    let graph_for_validation = LockfileV4ValidatedGraph {
        root_id: root_id.clone(),
        lockfile_order: lockfile_order.clone(),
        packages: validated_packages.clone(),
        edges: edges.clone(),
    };
    if let Err(error) = lockfile_v4_validate_root_graph_edges(&graph_for_validation) {
        return LockfileV4ValidationResult::Error(error);
    }

    let graph = LockfileV4ValidatedGraph {
        root_id,
        lockfile_order,
        packages: validated_packages,
        edges,
    };

    LockfileV4ValidationResult::Ok(graph)
}

fn lockfile_v4_validate_manifest_dependency_names(
    manifest: &LockfileV4PackageManifest,
) -> Result<(), String> {
    if manifest.is_legacy {
        return Ok(());
    }

    for name in manifest
        .combined_dependencies
        .iter()
        .map(|dependency| dependency.name.as_str())
    {
        if manifest_digest::is_legacy_system_dep_name(&name) {
            return Err(format!(
                "Dependency `{}` is a legacy system name and cannot be used. See https://docs.sui.io/guides/developer/sui-101/move-package-management#system-dependencies",
                name
            ));
        }
    }
    Ok(())
}

fn lockfile_v4_combined_dependency_by_name<'a>(
    manifest: &'a LockfileV4PackageManifest,
    alias: &str,
) -> Option<&'a CombinedMoveDependency> {
    manifest
        .combined_dependencies
        .iter()
        .find(|dependency| dependency.name == alias)
}

fn lockfile_v4_validate_root_graph_edges(graph: &LockfileV4ValidatedGraph) -> Result<(), String> {
    let packages_by_id = lockfile_v4_packages_by_id(graph);
    let root = packages_by_id.get(&graph.root_id).ok_or_else(|| {
        format!(
            "Move.lock V4 graph is missing root package '{}'",
            graph.root_id
        )
    })?;

    if root.manifest.is_legacy {
        for (alias, target_id) in &root.dep_alias_to_package_name {
            let target = packages_by_id
                .get(target_id)
                .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", target_id))?;
            if !target.manifest.is_legacy {
                return Err(
                    "Packages with old-style Move.toml files cannot depend on new-style packages. See https://docs.sui.io/references/package-managers/package-manager-migration for instructions."
                        .to_string(),
                );
            }
            let actual_dep_name = target.manifest.name.as_str();
            if alias == actual_dep_name {
                continue;
            }
            if target
                .manifest
                .legacy_name
                .as_deref()
                .map(manifest_digest::normalize_legacy_name_to_identifier)
                .is_some_and(|legacy_name| legacy_name == *alias)
            {
                continue;
            }
            return Err(format!(
                "Dependency '{}' does not match package name '{}'",
                alias, actual_dep_name
            ));
        }
        return Ok(());
    }

    for (alias, target_id) in &root.dep_alias_to_package_name {
        let target = packages_by_id
            .get(target_id)
            .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", target_id))?;
        let local_dep_name = alias.as_str();
        let actual_dep_name = target.manifest.name.as_str();
        let rename_from = lockfile_v4_combined_dependency_by_name(&root.manifest, local_dep_name)
            .and_then(|dependency| dependency.rename_from.as_deref());

        if let Some(rename_from) = rename_from {
            if local_dep_name == actual_dep_name {
                return Err(format!(
                    "Dependency '{}' specifies rename-from but already matches package name '{}'",
                    local_dep_name, actual_dep_name
                ));
            }
            if rename_from != actual_dep_name {
                return Err(format!(
                    "Dependency '{}' specifies rename-from '{}' but target package name is '{}'",
                    local_dep_name, rename_from, actual_dep_name
                ));
            }
        } else if local_dep_name != actual_dep_name {
            return Err(format!(
                "Dependency '{}' does not match package name '{}'",
                local_dep_name, actual_dep_name
            ));
        }
    }

    Ok(())
}

fn lockfile_v4_package_compile_id(
    package_id: &str,
    manifest: &LockfileV4PackageManifest,
) -> Option<String> {
    manifest
        .original_id
        .clone()
        .or_else(|| manifest.published_at.clone())
        .or_else(|| manifest.addresses.get(&manifest.name).cloned())
        .or_else(|| manifest.addresses.get(package_id).cloned())
}

fn lockfile_v4_package_output_id(
    package_id: &str,
    manifest: &LockfileV4PackageManifest,
) -> Option<String> {
    manifest
        .latest_published_id
        .clone()
        .or_else(|| manifest.published_at.clone())
        .or_else(|| manifest.original_id.clone())
        .or_else(|| lockfile_v4_package_compile_id(package_id, manifest))
}

fn lockfile_v4_compiler_files(
    files: &BTreeMap<String, String>,
    environment: &str,
    prefix: Option<&str>,
) -> BTreeMap<String, String> {
    let selected_move_toml = lockfile_v4::find_move_toml(files, environment).map(str::to_string);
    let mut output = BTreeMap::new();

    for (path, content) in files {
        let file_name = path.rsplit(['/', '\\']).next().unwrap_or(path.as_str());
        let is_manifest = file_name == "Move.toml"
            || (file_name.starts_with("Move.")
                && file_name.ends_with(".toml")
                && file_name.matches('.').count() == 2);
        if file_name == "Move.lock" || is_manifest {
            continue;
        }

        let output_path = match prefix {
            Some(prefix) => format!(
                "{}/{}",
                prefix.trim_end_matches('/'),
                path.trim_start_matches('/')
            ),
            None => path.clone(),
        };
        output.insert(output_path, content.clone());
    }

    if let Some(move_toml) = selected_move_toml {
        let output_path = match prefix {
            Some(prefix) => format!("{}/Move.toml", prefix.trim_end_matches('/')),
            None => "Move.toml".to_string(),
        };
        output.insert(output_path, move_toml);
    }

    output
}

fn lockfile_v4_move_toml_with_addresses(
    move_toml: &str,
    addresses: &BTreeMap<String, String>,
) -> String {
    let Ok(mut value) = move_toml.parse::<toml::Value>() else {
        return move_toml.to_string();
    };
    let Some(table) = value.as_table_mut() else {
        return move_toml.to_string();
    };
    let entry = table
        .entry("addresses".to_string())
        .or_insert_with(|| toml::Value::Table(toml::value::Table::new()));
    let Some(address_table) = entry.as_table_mut() else {
        return move_toml.to_string();
    };
    for (name, address) in addresses {
        address_table.insert(name.clone(), toml::Value::String(address.clone()));
    }
    toml::to_string(&value).unwrap_or_else(|_| move_toml.to_string())
}

#[derive(Clone)]
struct LockfileV4LinkageConflict {
    depth: usize,
    node: String,
    conflict: String,
}

#[derive(Default)]
struct LockfileV4LinkageTraversal {
    linkage: BTreeMap<String, (usize, String)>,
    best_conflict: Option<LockfileV4LinkageConflict>,
}

fn lockfile_v4_package_linkage_id(package: &LockfileV4ValidatedPackage) -> String {
    package
        .manifest
        .original_id
        .as_deref()
        .and_then(lockfile_v4_normalize_nonzero_address)
        .or_else(|| {
            package
                .manifest
                .published_at
                .as_deref()
                .and_then(lockfile_v4_normalize_nonzero_address)
        })
        .or_else(|| {
            package
                .manifest
                .latest_published_id
                .as_deref()
                .and_then(lockfile_v4_normalize_nonzero_address)
        })
        .unwrap_or_else(|| format!("unpublished:{}", package.id))
}

fn lockfile_v4_packages_by_id(
    graph: &LockfileV4ValidatedGraph,
) -> BTreeMap<String, &LockfileV4ValidatedPackage> {
    graph
        .packages
        .iter()
        .map(|package| (package.id.clone(), package))
        .collect()
}

fn lockfile_v4_edges_by_from(
    edges: &[LockfileV4ValidatedEdge],
) -> BTreeMap<String, Vec<LockfileV4ValidatedEdge>> {
    let mut edges_by_from: BTreeMap<String, Vec<LockfileV4ValidatedEdge>> = BTreeMap::new();
    for edge in edges {
        edges_by_from
            .entry(edge.from.clone())
            .or_default()
            .push(edge.clone());
    }
    for edges in edges_by_from.values_mut() {
        edges.sort_by(|left, right| {
            left.alias
                .cmp(&right.alias)
                .then_with(|| left.to.cmp(&right.to))
        });
    }
    edges_by_from
}

fn lockfile_v4_check_linkage_cycles(
    id: &str,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
    path: &mut Vec<String>,
    seen: &mut BTreeMap<String, usize>,
) -> Result<(), String> {
    let package = packages_by_id
        .get(id)
        .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", id))?;
    let original_id = lockfile_v4_package_linkage_id(package);
    let self_index = path.len();
    path.push(id.to_string());

    if let Some(old_index) = seen.insert(original_id.clone(), self_index) {
        let cycle = path[old_index..].join(" -> ");
        return Err(format!(
            "Move.lock V4 linkage dependency cycle detected: {} -> {}",
            cycle, id
        ));
    }

    if let Some(edges) = edges_by_from.get(id) {
        for edge in edges {
            lockfile_v4_check_linkage_cycles(&edge.to, packages_by_id, edges_by_from, path, seen)?;
        }
    }

    seen.remove(&original_id);
    path.pop();
    Ok(())
}

fn lockfile_v4_direct_overrides(
    id: &str,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
) -> Result<BTreeMap<String, String>, String> {
    let mut overrides = BTreeMap::<String, (String, String)>::new();
    for edge in edges_by_from.get(id).into_iter().flatten() {
        if !edge.is_override {
            continue;
        }
        let target = packages_by_id
            .get(&edge.to)
            .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", edge.to))?;
        let original_id = lockfile_v4_package_linkage_id(target);
        match overrides.get(&original_id) {
            Some((_, existing_id)) if existing_id != &edge.to => {
                return Err(format!(
                    "Move.lock V4 package '{}' has override dependencies that both resolve to package ID {}",
                    id, original_id
                ));
            }
            Some(_) => {}
            None => {
                overrides.insert(original_id, (edge.alias.clone(), edge.to.clone()));
            }
        }
    }

    Ok(overrides
        .into_iter()
        .map(|(original_id, (_, package_id))| (original_id, package_id))
        .collect())
}

fn lockfile_v4_min_conflict(
    left: Option<LockfileV4LinkageConflict>,
    right: Option<LockfileV4LinkageConflict>,
) -> Option<LockfileV4LinkageConflict> {
    match (left, right) {
        (None, right) => right,
        (left, None) => left,
        (Some(left), Some(right)) => Some(if left.depth <= right.depth {
            left
        } else {
            right
        }),
    }
}

fn lockfile_v4_linkage_ignoring_overrides(
    id: &str,
    overrides: &BTreeMap<String, String>,
    depth: usize,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
) -> Result<LockfileV4LinkageTraversal, String> {
    let package = packages_by_id
        .get(id)
        .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", id))?;

    let mut local_overrides = lockfile_v4_direct_overrides(id, packages_by_id, edges_by_from)?;
    for (original_id, package_id) in overrides {
        local_overrides.insert(original_id.clone(), package_id.clone());
    }

    let mut result = LockfileV4LinkageTraversal::default();
    for edge in edges_by_from.get(id).into_iter().flatten() {
        let target = packages_by_id
            .get(&edge.to)
            .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", edge.to))?;
        if overrides.contains_key(&lockfile_v4_package_linkage_id(target)) {
            continue;
        }

        let child = lockfile_v4_linkage_ignoring_overrides(
            &edge.to,
            &local_overrides,
            depth + 1,
            packages_by_id,
            edges_by_from,
        )?;
        result.best_conflict = lockfile_v4_min_conflict(result.best_conflict, child.best_conflict);

        for (original_id, (new_depth, new_id)) in child.linkage {
            match result.linkage.get(&original_id).cloned() {
                None => {
                    result.linkage.insert(original_id, (new_depth, new_id));
                }
                Some((old_depth, old_id)) => {
                    let (min_depth, min_id, other_id) = if new_depth < old_depth {
                        (new_depth, new_id.clone(), old_id.clone())
                    } else {
                        (old_depth, old_id.clone(), new_id.clone())
                    };
                    if old_id != new_id {
                        result.best_conflict = lockfile_v4_min_conflict(
                            result.best_conflict,
                            Some(LockfileV4LinkageConflict {
                                depth: min_depth,
                                node: min_id.clone(),
                                conflict: other_id,
                            }),
                        );
                    }
                    result.linkage.insert(original_id, (min_depth, min_id));
                }
            }
        }
    }

    result.linkage.insert(
        lockfile_v4_package_linkage_id(package),
        (depth, id.to_string()),
    );
    Ok(result)
}

fn lockfile_v4_linkage_table(
    graph: &LockfileV4ValidatedGraph,
) -> Result<BTreeMap<String, String>, String> {
    let packages_by_id = lockfile_v4_packages_by_id(graph);
    let edges_by_from = lockfile_v4_edges_by_from(&graph.edges);
    lockfile_v4_check_linkage_cycles(
        &graph.root_id,
        &packages_by_id,
        &edges_by_from,
        &mut Vec::new(),
        &mut BTreeMap::new(),
    )?;

    let traversal = lockfile_v4_linkage_ignoring_overrides(
        &graph.root_id,
        &BTreeMap::new(),
        0,
        &packages_by_id,
        &edges_by_from,
    )?;
    if let Some(conflict) = traversal.best_conflict {
        return Err(format!(
            "Move.lock V4 linkage depends on multiple versions of package ID {} through '{}' and '{}'",
            lockfile_v4_package_linkage_id(
                packages_by_id.get(&conflict.node).ok_or_else(|| {
                    format!(
                        "Move.lock V4 linkage has unknown package '{}'",
                        conflict.node
                    )
                })?
            ),
            conflict.node,
            conflict.conflict
        ));
    }

    Ok(traversal
        .linkage
        .into_iter()
        .map(|(original_id, (_, package_id))| (original_id, package_id))
        .collect())
}

fn lockfile_v4_linked_graph(
    graph: &LockfileV4ValidatedGraph,
) -> Result<LockfileV4ValidatedGraph, String> {
    let packages_by_id = lockfile_v4_packages_by_id(graph);
    let linkage = lockfile_v4_linkage_table(graph)?;
    let linked_ids = linkage.values().cloned().collect::<BTreeSet<_>>();

    let mut packages = graph
        .packages
        .iter()
        .filter(|package| linked_ids.contains(&package.id))
        .cloned()
        .collect::<Vec<_>>();
    packages.sort_by(|left, right| {
        left.manifest
            .name
            .cmp(&right.manifest.name)
            .then_with(|| left.id.cmp(&right.id))
    });

    let package_ids = packages
        .iter()
        .map(|package| package.id.clone())
        .collect::<BTreeSet<_>>();
    let mut edge_keys = BTreeSet::new();
    let mut edges = Vec::new();
    for edge in &graph.edges {
        if !package_ids.contains(&edge.from) {
            continue;
        }
        let Some(target_package) = packages_by_id.get(&edge.to) else {
            return Err(format!(
                "Move.lock V4 linkage has unknown package '{}'",
                edge.to
            ));
        };
        let target_original_id = lockfile_v4_package_linkage_id(target_package);
        let Some(linked_target) = linkage.get(&target_original_id) else {
            continue;
        };
        if !package_ids.contains(linked_target) {
            continue;
        }
        let key = (
            edge.from.clone(),
            linked_target.clone(),
            edge.alias.clone(),
            edge.modes.clone(),
            edge.is_override,
        );
        if edge_keys.insert(key) {
            edges.push(LockfileV4ValidatedEdge {
                from: edge.from.clone(),
                to: linked_target.clone(),
                alias: edge.alias.clone(),
                modes: edge.modes.clone(),
                is_override: edge.is_override,
            });
        }
    }
    let active_aliases_by_from = edges.iter().fold(
        BTreeMap::<String, BTreeMap<String, String>>::new(),
        |mut acc, edge| {
            acc.entry(edge.from.clone())
                .or_default()
                .insert(edge.alias.clone(), edge.to.clone());
            acc
        },
    );
    for package in &mut packages {
        package.active_dep_alias_to_package_name = active_aliases_by_from
            .get(&package.id)
            .cloned()
            .unwrap_or_default();
    }

    Ok(LockfileV4ValidatedGraph {
        root_id: graph.root_id.clone(),
        lockfile_order: packages.iter().map(|package| package.id.clone()).collect(),
        packages,
        edges,
    })
}

fn lockfile_v4_insert_named_address(
    mapping: &mut BTreeMap<String, String>,
    name: &str,
    address: &str,
    package_id: &str,
) -> Result<(), String> {
    if !is_move_named_address(name) {
        return Ok(());
    }
    let normalized = normalize_hex_address_string(address).unwrap_or_else(|| address.to_string());
    if let Some(existing) = mapping.get(name) {
        let existing_normalized =
            normalize_hex_address_string(existing).unwrap_or_else(|| existing.clone());
        if existing_normalized != normalized {
            return Err(format!(
                "Move.lock V4 package '{}' has duplicate named address '{}'",
                package_id, name
            ));
        }
    }
    mapping.insert(name.to_string(), normalized);
    Ok(())
}

fn lockfile_v4_package_is_legacy(package: &LockfileV4ValidatedPackage) -> bool {
    package.manifest.is_legacy
}

fn lockfile_v4_package_node_address(package: &LockfileV4ValidatedPackage) -> Option<String> {
    lockfile_v4_package_compile_id(&package.id, &package.manifest)
        .and_then(|address| normalize_hex_address_string(&address))
}

fn lockfile_v4_package_named_address_value(package: &LockfileV4ValidatedPackage) -> String {
    lockfile_v4_package_node_address(package).unwrap_or_else(|| "_".to_string())
}

fn lockfile_v4_named_addresses_for_package(
    package_id: &str,
    graph: &LockfileV4ValidatedGraph,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
    visiting: &mut BTreeSet<String>,
) -> Result<BTreeMap<String, String>, String> {
    let package = packages_by_id
        .get(package_id)
        .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", package_id))?;
    let mut mapping = BTreeMap::new();

    if lockfile_v4_package_is_legacy(package) {
        if package.manifest.name != lockfile_v4::NO_NAME_LEGACY_PACKAGE_NAME {
            lockfile_v4_insert_named_address(
                &mut mapping,
                &package.manifest.name,
                &lockfile_v4_package_named_address_value(package),
                package_id,
            )?;
        }

        if !visiting.insert(package_id.to_string()) {
            return Err(format!(
                "Move.lock V4 package '{}' has recursive legacy named addresses",
                package_id
            ));
        }
        for edge in edges_by_from.get(package_id).into_iter().flatten() {
            let child_mapping = lockfile_v4_named_addresses_for_package(
                &edge.to,
                graph,
                packages_by_id,
                edges_by_from,
                visiting,
            )?;
            for (name, address) in child_mapping {
                lockfile_v4_insert_named_address(&mut mapping, &name, &address, package_id)?;
            }
        }
        visiting.remove(package_id);

        for (name, address) in package
            .manifest
            .addresses
            .iter()
            .filter(|(name, _)| *name != &package.manifest.name)
        {
            lockfile_v4_insert_named_address(&mut mapping, name, address, package_id)?;
        }
    } else {
        for edge in edges_by_from.get(package_id).into_iter().flatten() {
            let target = packages_by_id
                .get(&edge.to)
                .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", edge.to))?;
            lockfile_v4_insert_named_address(
                &mut mapping,
                &edge.alias,
                &lockfile_v4_package_named_address_value(target),
                package_id,
            )?;
        }
        lockfile_v4_insert_named_address(
            &mut mapping,
            &package.manifest.name,
            &lockfile_v4_package_named_address_value(package),
            package_id,
        )?;
    }

    Ok(mapping)
}

fn lockfile_v4_package_groups_from_validated_with_orders(
    input: &LockfileV4ValidateInput,
    graph: LockfileV4ValidatedGraph,
    lockfile_order: &[String],
) -> Result<LockfileV4PackageGroups, String> {
    let linked_graph = lockfile_v4_linked_graph(&graph)?;
    let packages_by_id = graph
        .packages
        .iter()
        .map(|package| (package.id.clone(), package))
        .collect::<BTreeMap<_, _>>();
    let linked_packages_by_id = lockfile_v4_packages_by_id(&linked_graph);
    let linked_edges_by_from = lockfile_v4_edges_by_from(&linked_graph.edges);
    let input_by_id = input
        .packages
        .iter()
        .map(|package| (package.id.clone(), package))
        .collect::<BTreeMap<_, _>>();

    let _root_package = linked_packages_by_id
        .get(&linked_graph.root_id)
        .ok_or_else(|| {
            format!(
                "Move.lock V4 graph is missing root package '{}'",
                linked_graph.root_id
            )
        })?;
    let root_input = input_by_id.get(&graph.root_id).ok_or_else(|| {
        format!(
            "Move.lock V4 input is missing root package '{}'",
            graph.root_id
        )
    })?;
    let mut root_input_files = root_input.files.clone();
    root_input_files
        .entry("Move.toml".to_string())
        .or_insert_with(|| input.root_move_toml.clone());

    let root_address_mapping = lockfile_v4_named_addresses_for_package(
        &linked_graph.root_id,
        &linked_graph,
        &linked_packages_by_id,
        &linked_edges_by_from,
        &mut BTreeSet::new(),
    )?;

    let mut root_files = lockfile_v4_compiler_files(&root_input_files, &input.environment, None);
    if let Some(root_move_toml) = root_files.get("Move.toml").cloned() {
        root_files.insert(
            "Move.toml".to_string(),
            lockfile_v4_move_toml_with_addresses(&root_move_toml, &root_address_mapping),
        );
    }

    let mut root_aliases_by_target: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in linked_graph
        .edges
        .iter()
        .filter(|edge| edge.from == linked_graph.root_id)
    {
        root_aliases_by_target
            .entry(edge.to.clone())
            .or_default()
            .push(edge.alias.clone());
    }
    for aliases in root_aliases_by_target.values_mut() {
        aliases.sort();
    }

    let mut groups_by_id = BTreeMap::new();
    let mut active_groups_by_id = BTreeMap::new();

    for package_id in graph
        .lockfile_order
        .iter()
        .filter(|package_id| *package_id != &graph.root_id)
    {
        let package = packages_by_id
            .get(package_id)
            .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", package_id))?;
        let input_package = input_by_id
            .get(package_id)
            .ok_or_else(|| format!("Move.lock V4 input has no files for '{}'", package_id))?;
        let prefix = format!("dependencies/{}", package.id);
        let files = lockfile_v4_compiler_files(
            &input_package.files,
            &input.environment,
            Some(prefix.as_str()),
        );

        let address_mapping = if linked_packages_by_id.contains_key(package_id) {
            lockfile_v4_named_addresses_for_package(
                package_id,
                &linked_graph,
                &linked_packages_by_id,
                &linked_edges_by_from,
                &mut BTreeSet::new(),
            )?
        } else {
            package.manifest.addresses.clone()
        };

        let group = LockfileV4PackageGroup {
            name: package.id.clone(),
            display_name: package
                .manifest
                .legacy_name
                .clone()
                .unwrap_or_else(|| package.manifest.name.clone()),
            files,
            edition: package.manifest.edition.clone(),
            address_mapping,
            published_id_for_output: lockfile_v4_package_output_id(&package.id, &package.manifest),
            source: package.source.clone(),
            manifest_deps: lockfile_v4::manifest_dep_names(&package.manifest),
            manifest: LockfileV4PackageGroupManifest {
                name: package.manifest.name.clone(),
                dependencies: package.manifest.dependencies.clone(),
            },
            dep_alias_to_package_name: package.dep_alias_to_package_name.clone(),
            root_dependency_aliases: root_aliases_by_target
                .get(package_id)
                .cloned()
                .unwrap_or_default(),
        };
        let mut active_group = group.clone();
        if let Some(linked_package) = linked_packages_by_id.get(package_id) {
            active_group.dep_alias_to_package_name =
                linked_package.active_dep_alias_to_package_name.clone();
        } else {
            active_group.dep_alias_to_package_name.clear();
        }
        active_groups_by_id.insert(package.id.clone(), active_group);
        groups_by_id.insert(package.id.clone(), group);
    }

    let dependencies = linked_graph
        .lockfile_order
        .iter()
        .filter(|package_id| *package_id != &linked_graph.root_id)
        .filter_map(|package_id| active_groups_by_id.get(package_id).cloned())
        .collect::<Vec<_>>();
    let lockfile_dependencies = lockfile_order
        .iter()
        .filter(|package_id| *package_id != &graph.root_id)
        .filter_map(|package_id| groups_by_id.get(package_id).cloned())
        .collect::<Vec<_>>();

    Ok(LockfileV4PackageGroups {
        root_files,
        dependencies,
        lockfile_dependencies,
    })
}

fn lockfile_v4_package_groups_from_validated(
    input: &LockfileV4ValidateInput,
    graph: LockfileV4ValidatedGraph,
) -> Result<LockfileV4PackageGroups, String> {
    let order = graph.lockfile_order.clone();
    lockfile_v4_package_groups_from_validated_with_orders(input, graph, &order)
}

fn manifest_has_move_source(files: &BTreeMap<String, String>) -> bool {
    files.keys().any(|path| path.ends_with(".move"))
}

fn manifest_plan_resolve_relative_path(parent_path: &str, local_path: &str) -> String {
    let mut parts = parent_path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    for part in local_path.split('/').filter(|part| !part.is_empty()) {
        match part {
            "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value.to_string()),
        }
    }

    parts.join("/")
}

fn system_package_git_source(
    package_name: &str,
    dep_name: &str,
    system_name: &str,
) -> Result<ManifestPackagePlanSource, HelperError> {
    let source =
        system_packages::system_package_source(system_name).map_err(|code| match code {
            system_packages::SystemPackageSourceError::MissingSnapshot => HelperError::with_code(
                "missing_system_package_snapshot",
                format!(
                    "Dependency '{}.{}' uses system package '{}' but the pinned system package snapshot is unavailable",
                    package_name, dep_name, system_name
                ),
            ),
            system_packages::SystemPackageSourceError::UnsupportedSystemDependency => {
                HelperError::with_code(
                    "unsupported_system_dependency",
                    format!(
                        "Dependency '{}.{}' has unsupported system package '{}'",
                        package_name, dep_name, system_name
                    ),
                )
            }
        })?;

    Ok(ManifestPackagePlanSource::Git {
        git: source.git,
        rev: source.rev,
        subdir: Some(source.subdir),
        is_implicit: true,
    })
}

fn manifest_plan_dependency_source_from_combined(
    package_name: &str,
    dep: &CombinedMoveDependency,
    parent_source: &LockfileV4Source,
) -> Result<ManifestPackagePlanSource, HelperError> {
    match &dep.source {
        CombinedDependencySource::Git { git, rev, subdir } => {
            let rev = rev.as_ref().ok_or_else(|| {
                HelperError::new(format!(
                    "Dependency '{}.{}' has git source without rev",
                    package_name, dep.name
                ))
            })?;
            Ok(ManifestPackagePlanSource::Git {
                git: git.clone(),
                rev: rev.clone(),
                subdir: subdir.clone(),
                is_implicit: false,
            })
        }
        CombinedDependencySource::Local { local } => match parent_source {
            LockfileV4Source::Git { git, rev, subdir } => {
                let resolved_subdir = manifest_plan_resolve_relative_path(
                    subdir.as_deref().unwrap_or_default(),
                    local,
                );
                Ok(ManifestPackagePlanSource::Git {
                    git: git.clone(),
                    rev: rev.clone(),
                    subdir: Some(resolved_subdir),
                    is_implicit: false,
                })
            }
            LockfileV4Source::Local {
                local: parent_local,
            } => Ok(ManifestPackagePlanSource::Local {
                local: manifest_plan_resolve_relative_path(parent_local, local),
            }),
            LockfileV4Source::Root => Ok(ManifestPackagePlanSource::Local {
                local: local.clone(),
            }),
            LockfileV4Source::Unsupported => Err(HelperError::with_code(
                "unsupported_dependency_source",
                format!(
                    "Dependency '{}.{}' has unsupported parent source",
                    package_name, dep.name
                ),
            )),
        },
        CombinedDependencySource::System { system } => {
            system_package_git_source(package_name, &dep.name, system)
        }
    }
}

fn manifest_plan_dependencies_from_manifest(
    manifest: &LockfileV4PackageManifest,
    parent_source: &LockfileV4Source,
) -> Result<Vec<ManifestPackagePlanDependency>, HelperError> {
    let mut dependencies = Vec::new();
    for dep in &manifest.combined_dependencies {
        dependencies.push(ManifestPackagePlanDependency {
            name: dep.name.clone(),
            source: manifest_plan_dependency_source_from_combined(
                &manifest.name,
                dep,
                parent_source,
            )?,
            modes: dep.modes.clone().unwrap_or_default(),
            is_override: dep.is_override,
            subst: dep.subst.clone(),
        });
    }
    Ok(dependencies)
}

fn manifest_graph_source_key(source: &LockfileV4Source) -> String {
    match source {
        LockfileV4Source::Root => "root".to_string(),
        LockfileV4Source::Git { git, rev, subdir } => {
            format!(
                "git|{}|{}|{}",
                git,
                rev,
                subdir.as_deref().unwrap_or_default()
            )
        }
        LockfileV4Source::Local { local } => format!("local|{}", local),
        LockfileV4Source::Unsupported => "unsupported".to_string(),
    }
}

fn manifest_graph_plan_source_to_lockfile_source(
    source: &ManifestPackagePlanSource,
) -> LockfileV4Source {
    match source {
        ManifestPackagePlanSource::Git {
            git, rev, subdir, ..
        } => LockfileV4Source::Git {
            git: git.clone(),
            rev: rev.clone(),
            subdir: subdir.clone(),
        },
        ManifestPackagePlanSource::Local { local } => LockfileV4Source::Local {
            local: local.clone(),
        },
    }
}

fn manifest_graph_dependency_is_implicit(dep: &ManifestPackagePlanDependency) -> bool {
    matches!(
        dep.source,
        ManifestPackagePlanSource::Git {
            is_implicit: true,
            ..
        }
    )
}

fn manifest_graph_sort_dependencies(dependencies: &mut [ManifestPackagePlanDependency]) {
    dependencies.sort_by(|left, right| {
        let left_implicit = manifest_graph_dependency_is_implicit(left);
        let right_implicit = manifest_graph_dependency_is_implicit(right);
        right_implicit
            .cmp(&left_implicit)
            .then_with(|| left.name.cmp(&right.name))
    });
}

fn lockfile_v4_edge_matches_modes(edge: &LockfileV4ValidatedEdge, modes: &[String]) -> bool {
    edge.modes.is_empty()
        || edge
            .modes
            .iter()
            .any(|dep_mode| modes.iter().any(|mode| mode == dep_mode))
}

fn lockfile_v4_active_edges(
    edges: &[LockfileV4ValidatedEdge],
    modes: &[String],
) -> Vec<LockfileV4ValidatedEdge> {
    edges
        .iter()
        .filter(|edge| lockfile_v4_edge_matches_modes(edge, modes))
        .cloned()
        .collect()
}

fn manifest_graph_plan_snapshot(
    environment: &str,
    _framework_rev: &Option<String>,
    package_id_hint: &str,
    snapshot: &ManifestGraphPackageSnapshot,
) -> Result<
    (
        LockfileV4PackageManifest,
        Vec<ManifestPackagePlanDependency>,
    ),
    HelperError,
> {
    let (manifest, _move_toml) =
        lockfile_v4::manifest_from_files(package_id_hint, &snapshot.files, environment)?;
    lockfile_v4_validate_manifest_dependency_names(&manifest).map_err(HelperError::new)?;
    let mut dependencies = manifest_plan_dependencies_from_manifest(&manifest, &snapshot.source)?;
    manifest_graph_sort_dependencies(&mut dependencies);
    Ok((manifest, dependencies))
}

fn manifest_graph_unique_id(
    manifest_name: &str,
    name_to_suffix: &mut BTreeMap<String, usize>,
) -> String {
    let suffix = name_to_suffix
        .get(manifest_name)
        .copied()
        .unwrap_or_default();
    name_to_suffix.insert(manifest_name.to_string(), suffix + 1);
    if suffix == 0 {
        manifest_name.to_string()
    } else {
        format!("{}_{}", manifest_name, suffix)
    }
}

#[allow(clippy::too_many_arguments)]
fn manifest_graph_add_package(
    snapshot: ManifestGraphPackageSnapshot,
    package_id_hint: &str,
    is_root: bool,
    input: &ManifestGraphInput,
    known_by_source: &BTreeMap<String, ManifestGraphPackageSnapshot>,
    source_to_id: &mut BTreeMap<String, String>,
    name_to_suffix: &mut BTreeMap<String, usize>,
    nodes: &mut Vec<ManifestGraphNode>,
    edges: &mut Vec<LockfileV4ValidatedEdge>,
    requests: &mut BTreeMap<String, ManifestGraphFetchRequest>,
) -> Result<String, HelperError> {
    let source_key = manifest_graph_source_key(&snapshot.source);
    if let Some(existing_id) = source_to_id.get(&source_key) {
        return Ok(existing_id.clone());
    }
    if let Some(requested_source) = &snapshot.requested_source {
        let requested_key = manifest_graph_source_key(requested_source);
        if let Some(existing_id) = source_to_id.get(&requested_key) {
            return Ok(existing_id.clone());
        }
    }

    let (manifest, dependencies) = manifest_graph_plan_snapshot(
        &input.environment,
        &input.framework_rev,
        package_id_hint,
        &snapshot,
    )?;
    let package_id = if is_root {
        let id = lockfile_v4::package_graph_id_name(&manifest);
        name_to_suffix.insert(id.clone(), 1);
        id
    } else {
        manifest_graph_unique_id(
            &lockfile_v4::package_graph_id_name(&manifest),
            name_to_suffix,
        )
    };
    if !is_root && !manifest_has_move_source(&snapshot.files) {
        return Err(HelperError::with_code(
            "bytecode_only_dependency_unsupported",
            format!(
                "Dependency '{}' has no Move source files; bytecode-only dependencies are not supported",
                package_id
            ),
        ));
    }

    source_to_id.insert(source_key, package_id.clone());
    if let Some(requested_source) = &snapshot.requested_source {
        source_to_id.insert(
            manifest_graph_source_key(requested_source),
            package_id.clone(),
        );
    }

    let node_index = nodes.len();
    nodes.push(ManifestGraphNode {
        id: package_id.clone(),
        source: snapshot.source.clone(),
        files: snapshot.files.clone(),
        manifest,
        dep_alias_to_package_name: BTreeMap::new(),
    });

    let mut resolved_edges = Vec::new();
    for dependency in dependencies {
        let dependency_source = manifest_graph_plan_source_to_lockfile_source(&dependency.source);
        let dependency_key = manifest_graph_source_key(&dependency_source);
        let target_id = if let Some(existing_id) = source_to_id.get(&dependency_key) {
            Some(existing_id.clone())
        } else if let Some(dependency_snapshot) = known_by_source.get(&dependency_key) {
            Some(manifest_graph_add_package(
                dependency_snapshot.clone(),
                &dependency.name,
                false,
                input,
                known_by_source,
                source_to_id,
                name_to_suffix,
                nodes,
                edges,
                requests,
            )?)
        } else {
            requests
                .entry(dependency_key)
                .or_insert_with(|| ManifestGraphFetchRequest {
                    source: dependency_source,
                    dependency_name: dependency.name.clone(),
                    parent_package_name: nodes[node_index]
                        .manifest
                        .legacy_name
                        .clone()
                        .unwrap_or_else(|| nodes[node_index].manifest.name.clone()),
                    parent_source: nodes[node_index].source.clone(),
                });
            None
        };

        if let Some(target_id) = target_id {
            resolved_edges.push((
                dependency.name,
                target_id,
                dependency.modes,
                dependency.is_override,
            ));
        }
    }

    for (alias, target_id, modes, is_override) in resolved_edges {
        nodes[node_index]
            .dep_alias_to_package_name
            .insert(alias.clone(), target_id.clone());
        edges.push(LockfileV4ValidatedEdge {
            from: package_id.clone(),
            to: target_id,
            alias,
            modes,
            is_override,
        });
    }

    Ok(package_id)
}

fn manifest_graph_cycle(root_id: &str, edges: &[LockfileV4ValidatedEdge]) -> Option<Vec<String>> {
    let mut edges_by_from: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in edges {
        edges_by_from
            .entry(edge.from.clone())
            .or_default()
            .push(edge.to.clone());
    }

    fn visit(
        id: &str,
        edges_by_from: &BTreeMap<String, Vec<String>>,
        visited: &mut BTreeSet<String>,
        stack: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        if let Some(position) = stack.iter().position(|entry| entry == id) {
            let mut cycle = stack[position..].to_vec();
            cycle.push(id.to_string());
            return Some(cycle);
        }
        if !visited.insert(id.to_string()) {
            return None;
        }

        stack.push(id.to_string());
        if let Some(targets) = edges_by_from.get(id) {
            for target in targets {
                if let Some(cycle) = visit(target, edges_by_from, visited, stack) {
                    return Some(cycle);
                }
            }
        }
        stack.pop();
        None
    }

    visit(
        root_id,
        &edges_by_from,
        &mut BTreeSet::new(),
        &mut Vec::new(),
    )
}

fn manifest_graph_lockfile_order(root_id: &str, edges: &[LockfileV4ValidatedEdge]) -> Vec<String> {
    let mut edges_by_from: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in edges {
        edges_by_from
            .entry(edge.from.clone())
            .or_default()
            .push(edge.to.clone());
    }

    fn visit(
        id: &str,
        edges_by_from: &BTreeMap<String, Vec<String>>,
        visited: &mut BTreeSet<String>,
        order: &mut Vec<String>,
    ) {
        if !visited.insert(id.to_string()) {
            return;
        }
        if let Some(targets) = edges_by_from.get(id) {
            for target in targets {
                visit(target, edges_by_from, visited, order);
            }
        }
        order.push(id.to_string());
    }

    let mut order = Vec::new();
    visit(root_id, &edges_by_from, &mut BTreeSet::new(), &mut order);
    order
}

fn manifest_graph_resolve_package_groups_impl(
    input: ManifestGraphInput,
) -> Result<serde_json::Value, HelperError> {
    let environment = input.environment.clone();
    let modes = input.modes.clone();
    let mut known_by_source = BTreeMap::new();
    for package in &input.packages {
        if matches!(package.source, LockfileV4Source::Root) {
            return Err(HelperError::new(
                "Manifest graph dependency package cannot use root source",
            ));
        }
        known_by_source.insert(manifest_graph_source_key(&package.source), package.clone());
        if let Some(requested_source) = &package.requested_source {
            known_by_source.insert(manifest_graph_source_key(requested_source), package.clone());
        }
    }

    let mut source_to_id = BTreeMap::new();
    let mut name_to_suffix = BTreeMap::new();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut requests = BTreeMap::new();
    let root_id = manifest_graph_add_package(
        input.root.clone(),
        "root",
        true,
        &input,
        &known_by_source,
        &mut source_to_id,
        &mut name_to_suffix,
        &mut nodes,
        &mut edges,
        &mut requests,
    )?;

    if !requests.is_empty() {
        let stage_reports =
            vec![
                StageReport::new("manifest_graph_fetch_plan", &environment, &modes)
                    .package_id(root_id.clone())
                    .node_count(nodes.len())
                    .edge_count(edges.len()),
            ];
        return Ok(serde_json::json!({
            "status": "needFetch",
            "requests": requests.into_values().collect::<Vec<_>>(),
            "stageReports": stage_reports,
        }));
    }

    if let Some(cycle) = manifest_graph_cycle(&root_id, &edges) {
        return Err(HelperError::with_code(
            "dependency_cycle",
            format!("Dependency cycle detected: {}", cycle.join(" -> ")),
        ));
    }

    let lockfile_order = manifest_graph_lockfile_order(&root_id, &edges);
    let active_edges = lockfile_v4_active_edges(&edges, &input.modes);
    let node_count = nodes.len();
    let edge_count = edges.len();
    let active_edge_count = active_edges.len();
    let active_aliases_by_from = active_edges.iter().fold(
        BTreeMap::<String, BTreeSet<String>>::new(),
        |mut acc, edge| {
            acc.entry(edge.from.clone())
                .or_default()
                .insert(edge.alias.clone());
            acc
        },
    );
    let node_by_id = nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();

    let mut validate_packages = Vec::new();
    let mut validated_packages = Vec::new();
    for package_id in &lockfile_order {
        let node = node_by_id.get(package_id).ok_or_else(|| {
            HelperError::new(format!(
                "Manifest graph has unknown package '{}'",
                package_id
            ))
        })?;
        validate_packages.push(LockfileV4ValidatePackage {
            id: node.id.clone(),
            source: node.source.clone(),
            deps: node.dep_alias_to_package_name.clone(),
            manifest_digest: None,
            files: node.files.clone(),
        });
        validated_packages.push(LockfileV4ValidatedPackage {
            id: node.id.clone(),
            source: node.source.clone(),
            manifest: node.manifest.clone(),
            dep_alias_to_package_name: node.dep_alias_to_package_name.clone(),
            active_dep_alias_to_package_name: node
                .dep_alias_to_package_name
                .iter()
                .filter(|(alias, _)| {
                    active_aliases_by_from
                        .get(&node.id)
                        .map(|aliases| aliases.contains(*alias))
                        .unwrap_or(false)
                })
                .map(|(alias, target_id)| (alias.clone(), target_id.clone()))
                .collect(),
        });
    }

    let root_move_toml = lockfile_v4::find_move_toml(&input.root.files, &input.environment)
        .unwrap_or_default()
        .to_string();
    let validate_input = LockfileV4ValidateInput {
        environment: input.environment,
        root_move_toml,
        modes: input.modes,
        packages: validate_packages,
    };
    let root_id_for_report = root_id.clone();
    let graph = LockfileV4ValidatedGraph {
        root_id,
        lockfile_order: lockfile_order.clone(),
        packages: validated_packages,
        edges: active_edges,
    };
    let groups = lockfile_v4_package_groups_from_validated_with_orders(
        &validate_input,
        graph,
        &lockfile_order,
    )?;
    let stage_reports = vec![
        StageReport::new("manifest_graph", &environment, &modes)
            .package_id(root_id_for_report)
            .node_count(node_count)
            .edge_count(edge_count),
        StageReport::new("manifest_mode_filter", &environment, &modes)
            .node_count(node_count)
            .edge_count(edge_count)
            .active_edge_count(active_edge_count),
        StageReport::new("manifest_linkage", &environment, &modes)
            .linked_node_count(groups.dependencies.len()),
    ];

    Ok(serde_json::json!({
        "status": "ok",
        "rootFiles": groups.root_files,
        "dependencies": groups.dependencies,
        "lockfileDependencies": groups.lockfile_dependencies,
        "stageReports": stage_reports,
    }))
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn manifest_graph_resolve_package_groups(input_json: &str) -> String {
    let input: ManifestGraphInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return lockfile_v4_error_with_code(
                "invalid_helper_input",
                format!("Invalid manifest graph input: {}", error),
            );
        }
    };

    match manifest_graph_resolve_package_groups_impl(input) {
        Ok(response) => response.to_string(),
        Err(error) => lockfile_v4_error_from_helper(error),
    }
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn lockfile_v4_validate_graph(input_json: &str) -> String {
    let input: LockfileV4ValidateInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return lockfile_v4_error_with_code(
                "invalid_helper_input",
                format!("Invalid lockfile V4 validation input: {}", error),
            );
        }
    };

    let graph = match lockfile_v4_validate_graph_impl(&input) {
        LockfileV4ValidationResult::Ok(graph) => graph,
        LockfileV4ValidationResult::OutOfDate(package_id) => {
            return lockfile_v4_out_of_date(package_id)
        }
        LockfileV4ValidationResult::Error(error) => return lockfile_v4_error(error),
    };

    serde_json::json!({
        "status": "ok",
        "graph": graph,
    })
    .to_string()
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn lockfile_v4_resolve_package_groups(input_json: &str) -> String {
    let input: LockfileV4ValidateInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return lockfile_v4_error_with_code(
                "invalid_helper_input",
                format!("Invalid lockfile V4 package-group input: {}", error),
            );
        }
    };

    let graph = match lockfile_v4_validate_graph_impl(&input) {
        LockfileV4ValidationResult::Ok(graph) => graph,
        LockfileV4ValidationResult::OutOfDate(package_id) => {
            return lockfile_v4_out_of_date(package_id)
        }
        LockfileV4ValidationResult::Error(error) => return lockfile_v4_error(error),
    };

    let active_edge_count = graph
        .edges
        .iter()
        .filter(|edge| lockfile_v4_edge_matches_modes(edge, &input.modes))
        .count();
    let stage_reports = vec![
        StageReport::new("move_lock_graph", &input.environment, &input.modes)
            .package_id(graph.root_id.clone())
            .node_count(graph.packages.len())
            .edge_count(graph.edges.len())
            .active_edge_count(active_edge_count),
    ];
    match lockfile_v4_package_groups_from_validated(&input, graph) {
        Ok(groups) => {
            let mut reports = stage_reports;
            reports.push(
                StageReport::new("move_lock_linkage", &input.environment, &input.modes)
                    .linked_node_count(groups.dependencies.len()),
            );
            serde_json::json!({
                "status": "ok",
                "rootFiles": groups.root_files,
                "dependencies": groups.dependencies,
                "lockfileDependencies": groups.lockfile_dependencies,
                "stageReports": reports,
            })
            .to_string()
        }
        Err(error) => lockfile_v4_error(error),
    }
}
