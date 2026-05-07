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
#[cfg(any(feature = "testing", feature = "verification"))]
use serde::Deserialize;
use serde::Serialize;
#[cfg(feature = "testing")]
use std::cell::RefCell;
#[cfg(feature = "testing")]
use std::collections::BTreeMap;
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
    metrics::ExecutionMetrics,
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
/// Upstream source references:
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
mod manifest_graph;
mod package_model;
mod publication;
mod stage_report;
mod system_packages;
#[cfg(feature = "verification")]
mod verification;
#[cfg(feature = "testing")]
use move_symbol_pool::Symbol;
use package_model::parse_hex_address_to_bytes;
#[cfg(feature = "testing")]
use package_model::{build_compiler_input, CompilerInput, CompilerInputMode};

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
        let metrics = Arc::new(ExecutionMetrics::new(&registry));

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
            return helper::error_with_code(
                "invalid_helper_input",
                format!("Invalid verification resolver input: {}", error),
            );
        }
    };

    match input {
        VerificationResolvePackageGroupsInput::LockfileFetchPlan {
            move_lock_toml,
            environment,
        } => lockfile_v4::fetch_plan_json(&move_lock_toml, &environment),
        VerificationResolvePackageGroupsInput::LockfileResolvePackageGroups { input } => {
            lockfile_v4::resolve_package_groups_from_value(input)
        }
        VerificationResolvePackageGroupsInput::ManifestGraphResolvePackageGroups { input } => {
            manifest_graph::resolve_package_groups_from_value(input)
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

/// JSON entrypoint for callers that provide pre-normalized dependency data.
/// `compute_manifest_digest_from_move_toml` keeps Move.toml semantics in Rust.
#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn compute_manifest_digest(deps_json: &str) -> String {
    manifest_digest::compute_manifest_digest(deps_json)
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn lockfile_v4_fetch_plan(move_lock_toml: &str, environment: &str) -> String {
    lockfile_v4::fetch_plan_json(move_lock_toml, environment)
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
    lockfile_v4::generate_json(input_json)
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn manifest_graph_resolve_package_groups(input_json: &str) -> String {
    manifest_graph::resolve_package_groups_json(input_json)
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn lockfile_v4_validate_graph(input_json: &str) -> String {
    lockfile_v4::validate_graph_json(input_json)
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn lockfile_v4_resolve_package_groups(input_json: &str) -> String {
    lockfile_v4::resolve_package_groups_json(input_json)
}
