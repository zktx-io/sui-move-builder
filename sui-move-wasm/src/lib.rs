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
mod manifest;
mod package_model;
mod publication;
mod stage_report;
mod system_packages;
#[cfg(feature = "verification")]
mod verification;
use helper::HelperError;
#[cfg(feature = "testing")]
use move_symbol_pool::Symbol;
#[cfg(feature = "testing")]
use package_model::{build_compiler_input, CompilerInput, CompilerInputMode};
use package_model::{dependency_name_is_implicit, parse_hex_address_to_bytes};
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
        } => match lockfile_v4_plan_from_toml(&move_lock_toml, &environment) {
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

#[derive(Clone, Debug, Deserialize)]
struct DigestDepInfo {
    name: String,
    #[serde(default)]
    git: Option<String>,
    #[serde(default)]
    subdir: Option<String>,
    #[serde(default)]
    rev: Option<String>,
    #[serde(default)]
    local: Option<String>,
    #[serde(default)]
    system: Option<String>,
    #[serde(default)]
    is_override: Option<bool>,
    #[serde(default)]
    use_environment: Option<String>,
    #[serde(default)]
    rename_from: Option<String>,
    #[serde(default)]
    modes: Option<Vec<String>>,
}

#[derive(Clone, Debug)]
enum CombinedDependencySource {
    Git {
        git: String,
        rev: Option<String>,
        subdir: Option<String>,
    },
    Local {
        local: String,
    },
    System {
        system: String,
    },
}

#[derive(Clone, Debug)]
struct CombinedMoveDependency {
    name: String,
    source: CombinedDependencySource,
    is_override: bool,
    rename_from: Option<String>,
    modes: Option<Vec<String>>,
    use_environment: String,
    address_override: Option<PublishAddressesDigest>,
    package_hint: Option<String>,
    subst: Option<BTreeMap<String, ManifestPackagePlanSubst>>,
}

#[derive(Serialize)]
struct ManifestGitDependency {
    #[serde(rename = "git")]
    repo: String,
    #[serde(default)]
    rev: Option<String>,
    #[serde(default)]
    subdir: std::path::PathBuf,
}

#[derive(Serialize)]
struct LocalDepInfo {
    local: std::path::PathBuf,
}

#[derive(Serialize)]
struct SystemDependency {
    system: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct PublishAddressesDigest {
    published_at: String,
    original_id: String,
}

#[derive(Serialize)]
enum ManifestDependencyInfo {
    Git(ManifestGitDependency),
    Local(LocalDepInfo),
    System(SystemDependency),
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
struct DefaultDependency {
    #[serde(flatten)]
    dependency_info: ManifestDependencyInfo,
    #[serde(rename = "override", default)]
    is_override: bool,
    #[serde(default)]
    rename_from: Option<String>,
    #[serde(default)]
    modes: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
struct ReplacementDependency {
    #[serde(flatten, default)]
    dependency: Option<DefaultDependency>,
    #[serde(flatten, default)]
    addresses: Option<PublishAddressesDigest>,
    #[serde(default)]
    use_environment: Option<String>,
}

#[derive(Serialize)]
struct RepinTriggers {
    deps: BTreeMap<String, ReplacementDependency>,
}

fn digest_dependency(dep: DigestDepInfo) -> (String, ReplacementDependency) {
    let source = if let Some(repo) = dep.git {
        Some(CombinedDependencySource::Git {
            git: repo,
            rev: dep.rev,
            subdir: dep.subdir,
        })
    } else if let Some(local) = dep.local {
        Some(CombinedDependencySource::Local { local })
    } else {
        dep.system
            .map(|system| CombinedDependencySource::System { system })
    };

    let replacement = source.map(|source| CombinedMoveDependency {
        name: dep.name.clone(),
        source,
        is_override: dep.is_override.unwrap_or(false),
        rename_from: dep.rename_from,
        modes: dep.modes,
        use_environment: dep.use_environment.unwrap_or_default(),
        address_override: None,
        package_hint: None,
        subst: None,
    });

    match replacement {
        Some(dep) => (dep.name.clone(), replacement_dependency_from_combined(&dep)),
        None => (
            dep.name,
            ReplacementDependency {
                dependency: None,
                addresses: None,
                use_environment: None,
            },
        ),
    }
}

fn compute_manifest_digest_from_deps(deps: Vec<DigestDepInfo>) -> Option<String> {
    use sha2::{Digest, Sha256};

    let mut deps_map: BTreeMap<String, ReplacementDependency> = BTreeMap::new();
    for dep in deps {
        let (name, replacement) = digest_dependency(dep);
        deps_map.insert(name, replacement);
    }

    let triggers = RepinTriggers { deps: deps_map };
    let serialized = toml_edit::ser::to_string(&triggers).ok()?;
    let hash = Sha256::digest(serialized.as_bytes());
    Some(format!("{:X}", hash))
}

fn compute_manifest_digest_from_combined(deps: Vec<CombinedMoveDependency>) -> Option<String> {
    use sha2::{Digest, Sha256};

    let deps_map = deps
        .iter()
        .map(|dep| (dep.name.clone(), replacement_dependency_from_combined(dep)))
        .collect::<BTreeMap<_, _>>();
    let triggers = RepinTriggers { deps: deps_map };
    let serialized = toml_edit::ser::to_string(&triggers).ok()?;
    let hash = Sha256::digest(serialized.as_bytes());
    Some(format!("{:X}", hash))
}

fn combined_dependency_matches_modes(dep: &CombinedMoveDependency, modes: &[String]) -> bool {
    dep.modes
        .as_ref()
        .map(|dep_modes| {
            dep_modes
                .iter()
                .any(|dep_mode| modes.iter().any(|mode| mode == dep_mode))
        })
        .unwrap_or(true)
}

fn toml_table_string(table: &toml::value::Table, kebab: &str, snake: &str) -> Option<String> {
    table
        .get(kebab)
        .or_else(|| table.get(snake))
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

fn toml_table_string_vec(table: &toml::value::Table, key: &str) -> Option<Vec<String>> {
    table
        .get(key)
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
}

fn combined_dependency_source_from_table(
    table: &toml::value::Table,
) -> Option<CombinedDependencySource> {
    if let Some(git) = table.get("git").and_then(|value| value.as_str()) {
        return Some(CombinedDependencySource::Git {
            git: git.to_string(),
            rev: table
                .get("rev")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            subdir: table
                .get("subdir")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        });
    }
    if let Some(local) = table.get("local").and_then(|value| value.as_str()) {
        return Some(CombinedDependencySource::Local {
            local: local.to_string(),
        });
    }
    table
        .get("system")
        .and_then(|value| value.as_str())
        .map(|system| CombinedDependencySource::System {
            system: system.to_string(),
        })
}

fn dependency_address_override_from_table(
    table: &toml::value::Table,
) -> Result<Option<PublishAddressesDigest>, String> {
    let published_at = toml_table_string(table, "published-at", "published_at");
    let original_id = toml_table_string(table, "original-id", "original_id");
    if published_at.is_some() != original_id.is_some() {
        return Err("Dependency replacement address override requires both `published-at` and `original-id`".to_string());
    }
    Ok(match (published_at, original_id) {
        (Some(published_at), Some(original_id)) => Some(PublishAddressesDigest {
            published_at: normalize_hex_address_string(&published_at).unwrap_or(published_at),
            original_id: normalize_hex_address_string(&original_id).unwrap_or(original_id),
        }),
        _ => None,
    })
}

#[derive(Clone)]
enum CombinedDependencyModeSource {
    FromTable,
    Fixed(Option<Vec<String>>),
}

fn combined_dependency_from_table_with_modes(
    name: &str,
    table: &toml::value::Table,
    environment: &str,
    modes: CombinedDependencyModeSource,
) -> Result<CombinedMoveDependency, String> {
    let source = combined_dependency_source_from_table(table)
        .ok_or_else(|| format!("Dependency '{}' has unsupported source form", name))?;
    let modes = match modes {
        CombinedDependencyModeSource::FromTable => toml_table_string_vec(table, "modes"),
        CombinedDependencyModeSource::Fixed(modes) => modes,
    };
    Ok(CombinedMoveDependency {
        name: name.to_string(),
        source,
        is_override: table
            .get("override")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        rename_from: toml_table_string(table, "rename-from", "rename_from"),
        modes,
        use_environment: environment.to_string(),
        address_override: None,
        package_hint: toml_table_string(table, "package", "package"),
        subst: manifest_plan_dependency_subst(table),
    })
}

fn combined_dependency_with_replacement(
    name: &str,
    default: Option<CombinedMoveDependency>,
    replacement_value: Option<toml::Value>,
    environment: &str,
) -> Result<CombinedMoveDependency, String> {
    let Some(replacement_value) = replacement_value else {
        return default.ok_or_else(|| format!("Dependency '{}' has no source", name));
    };
    let replacement_table = replacement_value.as_table().ok_or_else(|| {
        format!(
            "Dependency replacement '{}' has unsupported source form",
            name
        )
    })?;

    let replacement_source = combined_dependency_source_from_table(replacement_table);
    let mut dep = if let Some(source) = replacement_source {
        CombinedMoveDependency {
            name: name.to_string(),
            source,
            is_override: replacement_table
                .get("override")
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            rename_from: toml_table_string(replacement_table, "rename-from", "rename_from"),
            modes: toml_table_string_vec(replacement_table, "modes"),
            use_environment: environment.to_string(),
            address_override: None,
            package_hint: toml_table_string(replacement_table, "package", "package"),
            subst: manifest_plan_dependency_subst(replacement_table),
        }
    } else {
        default.ok_or_else(|| format!("Dependency replacement '{}' has no source", name))?
    };

    if replacement_table.contains_key("package") {
        dep.package_hint = toml_table_string(replacement_table, "package", "package");
    }
    if replacement_table.contains_key("addr-subst") || replacement_table.contains_key("addr_subst")
    {
        dep.subst = manifest_plan_dependency_subst(replacement_table);
    }
    dep.use_environment =
        toml_table_string(replacement_table, "use-environment", "use_environment")
            .unwrap_or_else(|| environment.to_string());
    dep.address_override = dependency_address_override_from_table(replacement_table)?;
    Ok(dep)
}

fn merge_dependency_table_into_defaults(
    defaults: &mut BTreeMap<String, CombinedMoveDependency>,
    dep_table: &toml::value::Table,
    is_legacy: bool,
    package_uses_implicit_dependencies: bool,
    environment: &str,
    modes: CombinedDependencyModeSource,
) -> Result<(), String> {
    for (name, value) in dep_table {
        if package_uses_implicit_dependencies && dependency_name_is_implicit(name) {
            return Err(format!(
                "The `{}` dependency is implicitly provided and should not be defined in your manifest.",
                name
            ));
        }
        let table = value.as_table().ok_or_else(|| {
            format!(
                "Dependency '{}' must be a table with a supported source",
                name
            )
        })?;
        let dependency_name = if is_legacy {
            lockfile_v4_normalize_legacy_name_to_identifier(name)
        } else {
            name.clone()
        };
        defaults.insert(
            dependency_name.clone(),
            combined_dependency_from_table_with_modes(
                &dependency_name,
                table,
                environment,
                modes.clone(),
            )?,
        );
    }
    Ok(())
}

fn replacement_dependency_from_combined(dep: &CombinedMoveDependency) -> ReplacementDependency {
    let dependency_info = match &dep.source {
        CombinedDependencySource::Git { git, rev, subdir } => {
            ManifestDependencyInfo::Git(ManifestGitDependency {
                repo: git.clone(),
                rev: rev.clone(),
                subdir: std::path::PathBuf::from(subdir.clone().unwrap_or_default()),
            })
        }
        CombinedDependencySource::Local { local } => ManifestDependencyInfo::Local(LocalDepInfo {
            local: std::path::PathBuf::from(local),
        }),
        CombinedDependencySource::System { system } => {
            ManifestDependencyInfo::System(SystemDependency {
                system: system.clone(),
            })
        }
    };
    ReplacementDependency {
        dependency: Some(DefaultDependency {
            dependency_info,
            is_override: dep.is_override,
            rename_from: dep.rename_from.clone(),
            modes: dep.modes.clone(),
        }),
        addresses: dep.address_override.clone(),
        use_environment: Some(dep.use_environment.clone()),
    }
}

fn combined_dependencies_from_move_toml(
    move_toml: &str,
    package_name_override: Option<String>,
    environment: &str,
) -> Result<Vec<CombinedMoveDependency>, String> {
    let parsed = move_toml
        .parse::<toml::Value>()
        .map_err(|error| format!("Failed to parse Move.toml dependencies: {}", error))?;
    let package_name = package_name_override
        .filter(|name| !name.is_empty())
        .or_else(|| {
            parsed
                .get("package")
                .and_then(|package| package.get("name"))
                .and_then(|name| name.as_str())
                .map(|name| name.to_string())
        })
        .unwrap_or_default();
    let implicit_dependencies = parsed
        .get("package")
        .and_then(|package| package.get("implicit-dependencies"))
        .or_else(|| {
            parsed
                .get("package")
                .and_then(|package| package.get("implicit_dependencies"))
        })
        .and_then(|value| value.as_bool())
        .unwrap_or(true);

    let is_legacy = parsed
        .get("addresses")
        .and_then(|addresses| addresses.as_table())
        .is_some()
        || parsed
            .get("dev-addresses")
            .and_then(|addresses| addresses.as_table())
            .is_some()
        || parsed
            .get("dev-dependencies")
            .and_then(|dependencies| dependencies.as_table())
            .is_some();
    let package_uses_implicit_dependencies = if is_legacy {
        lockfile_v4_legacy_implicit_dependencies(&package_name, &parsed, implicit_dependencies)
    } else {
        implicit_dependencies && !dependency_name_is_implicit(&package_name)
    };

    let mut defaults = BTreeMap::<String, CombinedMoveDependency>::new();
    if let Some(dep_table) = parsed.get("dependencies").and_then(|deps| deps.as_table()) {
        merge_dependency_table_into_defaults(
            &mut defaults,
            dep_table,
            is_legacy,
            package_uses_implicit_dependencies,
            environment,
            if is_legacy {
                CombinedDependencyModeSource::Fixed(None)
            } else {
                CombinedDependencyModeSource::FromTable
            },
        )?;
    }

    if is_legacy {
        if let Some(dep_table) = parsed
            .get("dev-dependencies")
            .and_then(|deps| deps.as_table())
        {
            merge_dependency_table_into_defaults(
                &mut defaults,
                dep_table,
                true,
                package_uses_implicit_dependencies,
                environment,
                CombinedDependencyModeSource::Fixed(Some(vec!["test".to_string()])),
            )?;
        }
    }

    let mut replacements = parsed
        .get("dep-replacements")
        .or_else(|| parsed.get("dep_replacements"))
        .and_then(|deps| deps.as_table())
        .and_then(|deps| deps.get(environment))
        .and_then(|deps| deps.as_table())
        .map(|deps| {
            deps.iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();

    let mut deps = Vec::new();
    for (name, default) in defaults {
        let replacement = replacements.remove(&name);
        deps.push(combined_dependency_with_replacement(
            &name,
            Some(default),
            replacement,
            environment,
        )?);
    }

    for (name, replacement) in replacements {
        if package_uses_implicit_dependencies && dependency_name_is_implicit(&name) {
            return Err(format!(
                "The `{}` dependency is implicitly provided and should not be defined in your manifest.",
                name
            ));
        }
        deps.push(combined_dependency_with_replacement(
            &name,
            None,
            Some(replacement),
            environment,
        )?);
    }

    if package_uses_implicit_dependencies {
        deps.push(CombinedMoveDependency {
            name: "sui".to_string(),
            source: CombinedDependencySource::System {
                system: "sui".to_string(),
            },
            is_override: true,
            rename_from: None,
            modes: None,
            use_environment: environment.to_string(),
            address_override: None,
            package_hint: None,
            subst: None,
        });
        deps.push(CombinedMoveDependency {
            name: "std".to_string(),
            source: CombinedDependencySource::System {
                system: "std".to_string(),
            },
            is_override: true,
            rename_from: None,
            modes: None,
            use_environment: environment.to_string(),
            address_override: None,
            package_hint: None,
            subst: None,
        });
    }

    Ok(deps)
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
    combined_dependencies_from_move_toml(move_toml, package_name_override, environment)
        .ok()
        .and_then(compute_manifest_digest_from_combined)
        .unwrap_or_default()
}

/// Backward-compatible JSON entrypoint. New code should prefer
/// `compute_manifest_digest_from_move_toml`.
#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn compute_manifest_digest(deps_json: &str) -> String {
    #[derive(Deserialize)]
    struct Input {
        deps: Vec<DigestDepInfo>,
    }

    let input: Input = match serde_json::from_str(deps_json) {
        Ok(i) => i,
        Err(_) => {
            let simple: Vec<String> = match serde_json::from_str(deps_json) {
                Ok(s) => s,
                Err(_) => return String::new(),
            };
            let deps = simple
                .into_iter()
                .map(|name| DigestDepInfo {
                    name,
                    git: None,
                    subdir: None,
                    rev: None,
                    local: None,
                    system: None,
                    is_override: None,
                    use_environment: None,
                    rename_from: None,
                    modes: None,
                })
                .collect();
            return compute_manifest_digest_from_deps(deps).unwrap_or_default();
        }
    };

    compute_manifest_digest_from_deps(input.deps).unwrap_or_default()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum LockfileV4Source {
    Root,
    Git {
        git: String,
        rev: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
    },
    Local {
        local: String,
    },
    #[serde(other)]
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4PlanPackage {
    id: String,
    source: LockfileV4Source,
    #[serde(default)]
    deps: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manifest_digest: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4ValidateInput {
    environment: String,
    root_move_toml: String,
    #[serde(default)]
    modes: Vec<String>,
    packages: Vec<LockfileV4ValidatePackage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4ValidatePackage {
    id: String,
    source: LockfileV4Source,
    #[serde(default)]
    deps: BTreeMap<String, String>,
    #[serde(default)]
    manifest_digest: Option<String>,
    #[serde(default)]
    files: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4GenerateInput {
    environment: String,
    #[serde(default)]
    existing_lockfile: Option<String>,
    root: LockfileV4GeneratePackage,
    packages: Vec<LockfileV4GeneratePackage>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4GeneratePackage {
    id: String,
    source: LockfileV4Source,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    dep_alias_to_package_name: BTreeMap<String, String>,
    #[serde(default)]
    root_dependency_aliases: Vec<String>,
}

struct LockfileV4GenerateResolvedPackage {
    id: String,
    source: LockfileV4Source,
    manifest_name: String,
    graph_id_name: String,
    combined_dependencies: Vec<CombinedMoveDependency>,
    dep_alias_to_package_name: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4ValidatedGraph {
    root_id: String,
    lockfile_order: Vec<String>,
    packages: Vec<LockfileV4ValidatedPackage>,
    edges: Vec<LockfileV4ValidatedEdge>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4ValidatedPackage {
    id: String,
    source: LockfileV4Source,
    manifest: LockfileV4PackageManifest,
    #[serde(default)]
    dep_alias_to_package_name: BTreeMap<String, String>,
    #[serde(default)]
    active_dep_alias_to_package_name: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4PackageManifest {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "legacyName")]
    legacy_name: Option<String>,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    edition: Option<String>,
    #[serde(default, rename = "isLegacy")]
    is_legacy: bool,
    #[serde(skip_serializing_if = "manifest_plan_is_true")]
    implicit_dependencies: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_published_id: Option<String>,
    addresses: BTreeMap<String, String>,
    dependencies: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    dev_dependencies: Option<serde_json::Value>,
    #[serde(skip_serializing)]
    combined_dependencies: Vec<CombinedMoveDependency>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4ValidatedEdge {
    from: String,
    to: String,
    alias: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    modes: Vec<String>,
    #[serde(
        rename = "isOverride",
        default,
        skip_serializing_if = "manifest_plan_is_false"
    )]
    is_override: bool,
}

enum LockfileV4ValidationResult {
    Ok(LockfileV4ValidatedGraph),
    OutOfDate(String),
    Error(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4PackageGroups {
    root_files: BTreeMap<String, String>,
    dependencies: Vec<LockfileV4PackageGroup>,
    lockfile_dependencies: Vec<LockfileV4PackageGroup>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LockfileV4PackageGroup {
    name: String,
    display_name: String,
    files: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    edition: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    address_mapping: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_id_for_output: Option<String>,
    source: LockfileV4Source,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    manifest_deps: Vec<String>,
    manifest: LockfileV4PackageGroupManifest,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    dep_alias_to_package_name: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    root_dependency_aliases: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LockfileV4PackageGroupManifest {
    name: String,
    dependencies: serde_json::Value,
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

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ManifestPackagePlanSubst {
    Assign { address: String },
    RenameFrom { name: String },
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

fn manifest_plan_is_true(value: &bool) -> bool {
    *value
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

fn lockfile_v4_parse_source(
    environment: &str,
    package_id: &str,
    source_value: Option<&toml::Value>,
) -> Result<LockfileV4Source, HelperError> {
    let source = source_value
        .and_then(|value| value.as_table())
        .ok_or_else(|| {
            HelperError::new(format!(
                "Move.lock V4 pinned.{}.{} has no source",
                environment, package_id
            ))
        })?;

    if source.contains_key("root") {
        return Ok(LockfileV4Source::Root);
    }

    if let Some(git) = source.get("git").and_then(|value| value.as_str()) {
        let rev = source
            .get("rev")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                HelperError::new(format!(
                    "Move.lock V4 pinned.{}.{} git source is missing rev",
                    environment, package_id
                ))
            })?;
        return Ok(LockfileV4Source::Git {
            git: git.to_string(),
            rev: rev.to_string(),
            subdir: source
                .get("subdir")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
        });
    }

    if let Some(local) = source.get("local").and_then(|value| value.as_str()) {
        return Ok(LockfileV4Source::Local {
            local: local.to_string(),
        });
    }

    Err(HelperError::with_code(
        "unsupported_dependency_source",
        format!(
            "Move.lock V4 pinned.{}.{} has unsupported source",
            environment, package_id
        ),
    ))
}

fn lockfile_v4_parse_deps(pin: &toml::Table) -> BTreeMap<String, String> {
    let mut deps = BTreeMap::new();
    if let Some(dep_table) = pin.get("deps").and_then(|value| value.as_table()) {
        for (alias, target) in dep_table {
            if let Some(target_id) = target.as_str() {
                deps.insert(alias.clone(), target_id.to_string());
            }
        }
    }
    deps
}

fn lockfile_v4_plan_from_toml(
    move_lock_toml: &str,
    environment: &str,
) -> Result<Option<(String, Vec<String>, Vec<LockfileV4PlanPackage>)>, HelperError> {
    let parsed = move_lock_toml.parse::<toml::Value>().map_err(|error| {
        HelperError::with_code(
            "malformed_lockfile",
            format!("Failed to parse Move.lock: {}", error),
        )
    })?;
    if let Some(version) = parsed
        .get("move")
        .and_then(|move_section| move_section.get("version"))
        .and_then(|value| value.as_integer())
    {
        if version > 4 {
            return Err(HelperError::with_code(
                "unsupported_lockfile_version",
                format!(
                    "Move.lock version {} is newer than the supported V4 schema",
                    version
                ),
            ));
        }
    }

    let pinned_env = match parsed
        .get("pinned")
        .and_then(|pinned| pinned.get(environment))
        .and_then(|value| value.as_table())
    {
        Some(table) => table,
        None => return Ok(None),
    };

    let mut root_ids = vec![];
    let mut lockfile_order = vec![];
    let mut packages = vec![];

    for (package_id, pin_value) in pinned_env {
        let pin = pin_value.as_table().ok_or_else(|| {
            HelperError::new(format!(
                "Move.lock V4 pinned.{}.{} is not a table",
                environment, package_id
            ))
        })?;
        let source = lockfile_v4_parse_source(environment, package_id, pin.get("source"))?;
        if matches!(source, LockfileV4Source::Root) {
            root_ids.push(package_id.clone());
        }
        lockfile_order.push(package_id.clone());
        packages.push(LockfileV4PlanPackage {
            id: package_id.clone(),
            source,
            deps: lockfile_v4_parse_deps(pin),
            manifest_digest: pin
                .get("manifest_digest")
                .or_else(|| pin.get("manifest-digest"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
        });
    }

    if root_ids.is_empty() {
        return Err(HelperError::new(format!(
            "Move.lock V4 pinned.{} has no root package entry",
            environment
        )));
    }
    if root_ids.len() > 1 {
        return Err(HelperError::new(format!(
            "Move.lock V4 pinned.{} has multiple root package entries",
            environment
        )));
    }

    Ok(Some((root_ids.remove(0), lockfile_order, packages)))
}

#[cfg(not(feature = "verification"))]
#[wasm_bindgen]
pub fn lockfile_v4_fetch_plan(move_lock_toml: &str, environment: &str) -> String {
    match lockfile_v4_plan_from_toml(move_lock_toml, environment) {
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

fn lockfile_v4_find_move_toml<'a>(
    files: &'a BTreeMap<String, String>,
    environment: &str,
) -> Option<&'a str> {
    let network_toml = format!("Move.{}.toml", environment);
    files
        .get(&network_toml)
        .or_else(|| {
            files
                .iter()
                .find(|(path, _)| path.ends_with(&network_toml))
                .map(|(_, content)| content)
        })
        .or_else(|| files.get("Move.toml"))
        .or_else(|| {
            files
                .iter()
                .find(|(path, _)| path.ends_with("Move.toml"))
                .map(|(_, content)| content)
        })
        .map(|value| value.as_str())
}

fn lockfile_v4_dependency_aliases_from_section(
    value: &toml::Value,
    section: &str,
) -> BTreeSet<String> {
    value
        .get(section)
        .and_then(|deps| deps.as_table())
        .map(|deps| deps.keys().cloned().collect())
        .unwrap_or_default()
}

fn lockfile_v4_legacy_implicit_dependencies(
    legacy_name: &str,
    value: &toml::Value,
    implicit_dependencies: bool,
) -> bool {
    if !implicit_dependencies || lockfile_v4_is_active_legacy_system_dep_name(legacy_name) {
        return false;
    }

    let mut aliases = lockfile_v4_dependency_aliases_from_section(value, "dependencies");
    aliases.extend(lockfile_v4_dependency_aliases_from_section(
        value,
        "dev-dependencies",
    ));
    !aliases
        .iter()
        .any(|alias| lockfile_v4_is_active_legacy_system_dep_name(alias))
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

fn lockfile_v4_is_zero_or_unassigned_address(value: &str) -> bool {
    value.trim() == "_"
        || normalize_hex_address_string(value)
            .map(|address| {
                address == "0x0000000000000000000000000000000000000000000000000000000000000000"
            })
            .unwrap_or(false)
}

fn lockfile_v4_normalize_nonzero_address(value: &str) -> Option<String> {
    let normalized = normalize_hex_address_string(value)?;
    if normalized == "0x0000000000000000000000000000000000000000000000000000000000000000" {
        None
    } else {
        Some(normalized)
    }
}

fn lockfile_v4_normalize_legacy_name_to_identifier(name: &str) -> String {
    let mut result = name
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>();
    if result.is_empty() || result == "_" {
        return "__".to_string();
    }
    if result
        .chars()
        .next()
        .map(|ch| ch.is_ascii_digit())
        .unwrap_or(false)
    {
        result.insert(0, '_');
    }
    result
}

const LOCKFILE_V4_NO_NAME_LEGACY_PACKAGE_NAME: &str = "unnamed_legacy_package";

fn lockfile_v4_is_legacy_system_dep_name(name: &str) -> bool {
    matches!(
        name,
        "Sui" | "MoveStdlib" | "Bridge" | "DeepBook" | "SuiSystem"
    )
}

fn lockfile_v4_is_active_legacy_system_dep_name(name: &str) -> bool {
    lockfile_v4_is_legacy_system_dep_name(name) && name != "DeepBook"
}

fn lockfile_v4_strip_move_comments(source: &str) -> String {
    let mut result = String::new();
    let mut in_block_comment = false;

    for line in source.lines() {
        let mut line_cleaned = line.to_string();

        if let Some(start) = line_cleaned.find("///") {
            line_cleaned.replace_range(start.., "");
        }
        if let Some(start) = line_cleaned.find("//") {
            line_cleaned.replace_range(start.., "");
        }

        if in_block_comment {
            if let Some(end) = line_cleaned.find("*/") {
                line_cleaned.replace_range(..=end + 1, "");
                in_block_comment = false;
            } else {
                continue;
            }
        }

        while let Some(start) = line_cleaned.find("/*") {
            if let Some(end) = line_cleaned[start..].find("*/") {
                line_cleaned.replace_range(start..start + end + 2, "");
            } else {
                line_cleaned.replace_range(start.., "");
                in_block_comment = true;
                break;
            }
        }

        result.push_str(&line_cleaned);
    }

    result
}

fn lockfile_v4_is_ident_start(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphabetic()
}

fn lockfile_v4_is_ident_continue(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphanumeric()
}

fn lockfile_v4_module_names_from_source(source: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let bytes = source.as_bytes();
    let mut index = 0;

    while index + b"module".len() <= bytes.len() {
        if !bytes[index..].starts_with(b"module")
            || (index > 0 && lockfile_v4_is_ident_continue(bytes[index - 1]))
        {
            index += 1;
            continue;
        }

        let mut cursor = index + b"module".len();
        if cursor >= bytes.len() || !bytes[cursor].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || !lockfile_v4_is_ident_start(bytes[cursor]) {
            index += 1;
            continue;
        }

        let name_start = cursor;
        cursor += 1;
        while cursor < bytes.len() && lockfile_v4_is_ident_continue(bytes[cursor]) {
            cursor += 1;
        }

        if cursor + 1 >= bytes.len() || bytes[cursor] != b':' || bytes[cursor + 1] != b':' {
            index += 1;
            continue;
        }

        let name = &source[name_start..cursor];
        if !name.starts_with("0x") && !name.starts_with("0X") {
            names.insert(name.to_string());
        }
        index = cursor + 2;
    }

    names
}

fn lockfile_v4_is_legacy_name_source_path(path: &str) -> bool {
    let Some(relative_path) = path.strip_prefix("sources/") else {
        return false;
    };
    relative_path.ends_with(".move")
        && relative_path
            .split('/')
            .filter(|part| !part.is_empty())
            .count()
            <= 5
}

fn lockfile_v4_module_names_from_sources(files: &BTreeMap<String, String>) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for (path, content) in files {
        if !lockfile_v4_is_legacy_name_source_path(path) {
            continue;
        }
        let clean = lockfile_v4_strip_move_comments(content);
        names.extend(lockfile_v4_module_names_from_source(&clean));
    }
    names
}

fn lockfile_v4_derive_legacy_modern_name(
    addresses: &BTreeMap<String, String>,
    files: &BTreeMap<String, String>,
) -> Option<String> {
    let zero_addresses = addresses
        .iter()
        .filter_map(|(name, address)| {
            lockfile_v4_is_zero_or_unassigned_address(address).then(|| name.clone())
        })
        .collect::<Vec<_>>();

    if zero_addresses.len() == 1 && is_move_named_address(&zero_addresses[0]) {
        return Some(zero_addresses[0].clone());
    }

    let module_names = lockfile_v4_module_names_from_sources(files);
    if module_names.len() == 1 {
        module_names.into_iter().next()
    } else {
        None
    }
}

fn lockfile_v4_chain_id(environment: &str) -> &str {
    match environment {
        "mainnet" => "35834a8a",
        "testnet" => "4c78adac",
        "devnet" => "2",
        other => other,
    }
}

fn lockfile_v4_env_publication(
    files: &BTreeMap<String, String>,
    environment: &str,
) -> (Option<String>, Option<String>) {
    let Some(lockfile_content) = files.get("Move.lock") else {
        return (None, None);
    };
    let Ok(value) = lockfile_content.parse::<toml::Value>() else {
        return (None, None);
    };
    let chain_id = lockfile_v4_chain_id(environment);
    let env = value
        .get("env")
        .and_then(|envs| envs.get(chain_id).or_else(|| envs.get(environment)))
        .and_then(|env| env.as_table());

    let original_id = env
        .and_then(|env| env.get("original-published-id"))
        .and_then(|value| value.as_str())
        .and_then(normalize_hex_address_string);
    let latest_id = env
        .and_then(|env| env.get("latest-published-id"))
        .and_then(|value| value.as_str())
        .and_then(normalize_hex_address_string);

    (original_id, latest_id)
}

fn lockfile_v4_published_toml_publication(
    files: &BTreeMap<String, String>,
    environment: &str,
) -> (Option<String>, Option<String>) {
    let Some(published_content) = files.get("Published.toml") else {
        return (None, None);
    };
    let Ok(value) = published_content.parse::<toml::Value>() else {
        return (None, None);
    };
    let env = value
        .get("published")
        .and_then(|published| published.get(environment))
        .and_then(|env| env.as_table());

    let published_at = env
        .and_then(|env| env.get("published-at"))
        .and_then(|value| value.as_str())
        .and_then(normalize_hex_address_string);
    let original_id = env
        .and_then(|env| env.get("original-id"))
        .and_then(|value| value.as_str())
        .and_then(normalize_hex_address_string);

    (published_at, original_id)
}

fn lockfile_v4_manifest_from_files(
    package_id: &str,
    files: &BTreeMap<String, String>,
    environment: &str,
) -> Result<(LockfileV4PackageManifest, String), String> {
    let move_toml = lockfile_v4_find_move_toml(files, environment)
        .ok_or_else(|| format!("Dependency '{}' did not provide Move.toml", package_id))?;
    let value = move_toml
        .parse::<toml::Value>()
        .map_err(|error| format!("Failed to parse Move.toml for '{}': {}", package_id, error))?;
    let package = value
        .get("package")
        .and_then(|package| package.as_table())
        .ok_or_else(|| format!("Move.toml for '{}' has no [package]", package_id))?;

    let mut name = package
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or(package_id)
        .to_string();
    let legacy_name = name.clone();
    let version = package
        .get("version")
        .and_then(|value| value.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let edition = package
        .get("edition")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let implicit_dependencies = package
        .get("implicit-dependencies")
        .or_else(|| package.get("implicit_dependencies"))
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let is_legacy = value
        .get("addresses")
        .and_then(|addresses| addresses.as_table())
        .is_some()
        || value
            .get("dev-addresses")
            .and_then(|addresses| addresses.as_table())
            .is_some()
        || value
            .get("dev-dependencies")
            .and_then(|dependencies| dependencies.as_table())
            .is_some();
    let manifest_published_at = package
        .get("published-at")
        .or_else(|| package.get("published_at"))
        .and_then(|value| value.as_str())
        .filter(|value| *value != "0x0")
        .and_then(normalize_hex_address_string);
    let manifest_original_id = package
        .get("original-id")
        .or_else(|| package.get("original_id"))
        .and_then(|value| value.as_str())
        .and_then(normalize_hex_address_string);

    let (lock_original_id, lock_latest_id) = lockfile_v4_env_publication(files, environment);
    let mut published_at = manifest_published_at
        .clone()
        .or(lock_latest_id.clone())
        .or(lock_original_id.clone());
    let mut original_id = manifest_original_id.or(lock_original_id);

    let (published_toml_latest, published_toml_original) =
        lockfile_v4_published_toml_publication(files, environment);
    if published_toml_latest.is_some() {
        published_at = published_toml_latest;
    }
    if published_toml_original.is_some() {
        original_id = published_toml_original;
    }

    let mut addresses = BTreeMap::new();
    if let Some(address_table) = value
        .get("addresses")
        .and_then(|addresses| addresses.as_table())
    {
        for (name, address) in address_table {
            if let Some(address_str) = address.as_str() {
                addresses.insert(
                    name.clone(),
                    normalize_hex_address_string(address_str)
                        .unwrap_or_else(|| address_str.to_string()),
                );
            }
        }
    }

    if is_legacy {
        name = lockfile_v4_derive_legacy_modern_name(&addresses, files)
            .unwrap_or_else(|| LOCKFILE_V4_NO_NAME_LEGACY_PACKAGE_NAME.to_string());
        for (address_name, address) in &addresses {
            if address.trim() == "_" && address_name != &name {
                return Err(format!(
                    "Found non instantiated named address `{}` (declared as `_`). All addresses in the `addresses` field must be instantiated.",
                    address_name
                ));
            }
        }
    }
    let implicit_dependencies = if is_legacy {
        lockfile_v4_legacy_implicit_dependencies(&legacy_name, &value, implicit_dependencies)
    } else {
        implicit_dependencies
    };
    let combined_dependencies = combined_dependencies_from_move_toml(
        move_toml,
        Some(if is_legacy {
            legacy_name.clone()
        } else {
            name.clone()
        }),
        environment,
    )?;

    let self_address_key = addresses
        .keys()
        .find(|key| key.eq_ignore_ascii_case(&name))
        .cloned();
    if let Some(self_key) = &self_address_key {
        if let Some(self_address) = addresses.get(self_key) {
            if self_address != "0x0000000000000000000000000000000000000000000000000000000000000000"
            {
                original_id = Some(self_address.clone());
            }
        }
    }

    let address_to_use = original_id.clone().or_else(|| published_at.clone());
    let package_has_named_self = !is_legacy || name != LOCKFILE_V4_NO_NAME_LEGACY_PACKAGE_NAME;
    if let Some(address) = address_to_use {
        if package_has_named_self && !addresses.contains_key(&name) && is_move_named_address(&name)
        {
            addresses.insert(name.clone(), address);
        }
    } else if package_has_named_self
        && !addresses.contains_key(&name)
        && is_move_named_address(&name)
    {
        addresses.insert(name.clone(), "0x0".to_string());
    }

    let dependencies = value
        .get("dependencies")
        .cloned()
        .and_then(|value| serde_json::to_value(value).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let dev_dependencies = value
        .get("dev-dependencies")
        .cloned()
        .and_then(|value| serde_json::to_value(value).ok());

    Ok((
        LockfileV4PackageManifest {
            name,
            legacy_name: is_legacy.then_some(legacy_name),
            version,
            edition,
            is_legacy,
            implicit_dependencies,
            published_at: published_at.clone(),
            original_id,
            latest_published_id: published_at,
            addresses,
            dependencies,
            dev_dependencies,
            combined_dependencies,
        },
        move_toml.to_string(),
    ))
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

fn lockfile_v4_toml_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("\"{}\"", escaped)
}

fn lockfile_v4_format_source(
    source: &LockfileV4Source,
    is_root: bool,
    package_id: &str,
) -> Result<String, String> {
    match source {
        LockfileV4Source::Root if is_root => Ok("source = { root = true }".to_string()),
        LockfileV4Source::Root => Err(format!(
            "Move.lock V4 generation package '{}' has root source outside the root package",
            package_id
        )),
        LockfileV4Source::Git { git, rev, subdir } => Ok(format!(
            "source = {{ git = {}, subdir = {}, rev = {} }}",
            lockfile_v4_toml_string(git),
            lockfile_v4_toml_string(subdir.as_deref().unwrap_or_default()),
            lockfile_v4_toml_string(rev)
        )),
        LockfileV4Source::Local { local } => Ok(format!(
            "source = {{ local = {} }}",
            lockfile_v4_toml_string(local)
        )),
        LockfileV4Source::Unsupported => Err(format!(
            "Move.lock V4 generation package '{}' has unsupported source",
            package_id
        )),
    }
}

fn lockfile_v4_source_matches_combined_dependency(
    source: &LockfileV4Source,
    dependency: &CombinedMoveDependency,
) -> bool {
    match source {
        LockfileV4Source::Git { git, rev, subdir } => match &dependency.source {
            CombinedDependencySource::Git {
                git: dep_git,
                rev: dep_rev,
                subdir: dep_subdir,
            } => {
                dep_git == git
                    && dep_rev.as_deref() == Some(rev.as_str())
                    && dep_subdir.as_deref().unwrap_or_default()
                        == subdir.as_deref().unwrap_or_default()
            }
            _ => false,
        },
        LockfileV4Source::Local { local } => match &dependency.source {
            CombinedDependencySource::Local { local: dep_local } => dep_local == local,
            _ => false,
        },
        LockfileV4Source::Root | LockfileV4Source::Unsupported => false,
    }
}

fn lockfile_v4_find_implicit_target(
    alias: &str,
    package_ids: &BTreeSet<String>,
    manifest_name_to_ids: &BTreeMap<String, Vec<String>>,
) -> Option<String> {
    let lower = alias.to_ascii_lowercase();
    let candidates: &[&str] = match lower.as_str() {
        "sui" => &["Sui"],
        "std" | "movestdlib" => &["MoveStdlib", "Std"],
        _ => return None,
    };

    for candidate in candidates {
        if package_ids.contains(*candidate) {
            return Some((*candidate).to_string());
        }
    }

    for candidate in candidates {
        if let Some(ids) = manifest_name_to_ids.get(*candidate) {
            if ids.len() == 1 {
                return ids.first().cloned();
            }
        }
    }

    None
}

fn lockfile_v4_resolve_dependency_target(
    current: &LockfileV4GenerateResolvedPackage,
    dependency: &CombinedMoveDependency,
    all_packages: &[LockfileV4GenerateResolvedPackage],
    package_ids: &BTreeSet<String>,
    manifest_name_to_ids: &BTreeMap<String, Vec<String>>,
) -> Result<String, String> {
    let alias = dependency.name.as_str();
    if let Some(target) = current.dep_alias_to_package_name.get(alias) {
        if package_ids.contains(target) {
            return Ok(target.clone());
        }
        return Err(format!(
            "Move.lock V4 generation package '{}' dependency '{}' references unknown package '{}'",
            current.id, alias, target
        ));
    }

    if matches!(dependency.source, CombinedDependencySource::System { .. }) {
        if let Some(target) =
            lockfile_v4_find_implicit_target(alias, package_ids, manifest_name_to_ids)
        {
            return Ok(target);
        }
    } else {
        let mut source_matches = all_packages
            .iter()
            .filter(|package| package.id != current.id)
            .filter(|package| {
                lockfile_v4_source_matches_combined_dependency(&package.source, dependency)
            })
            .map(|package| package.id.clone())
            .collect::<Vec<_>>();
        source_matches.sort();
        source_matches.dedup();
        if source_matches.len() == 1 {
            return Ok(source_matches.remove(0));
        }
        if source_matches.len() > 1 {
            return Err(format!(
                "Move.lock V4 generation package '{}' dependency '{}' matches multiple packages",
                current.id, alias
            ));
        }
    }

    if let Some(package_hint) = dependency
        .package_hint
        .as_ref()
        .or(dependency.rename_from.as_ref())
    {
        if package_ids.contains(package_hint.as_str()) {
            return Ok(package_hint.clone());
        }
        if let Some(ids) = manifest_name_to_ids.get(package_hint.as_str()) {
            if ids.len() == 1 {
                return ids.first().cloned().ok_or_else(|| {
                    format!(
                        "Move.lock V4 generation package '{}' dependency '{}' has no target",
                        current.id, alias
                    )
                });
            }
        }
    }

    if package_ids.contains(alias) {
        return Ok(alias.to_string());
    }

    if let Some(ids) = manifest_name_to_ids.get(alias) {
        if ids.len() == 1 {
            return ids.first().cloned().ok_or_else(|| {
                format!(
                    "Move.lock V4 generation package '{}' dependency '{}' has no target",
                    current.id, alias
                )
            });
        }
    }

    if dependency_name_is_implicit(alias) {
        if let Some(target) =
            lockfile_v4_find_implicit_target(alias, package_ids, manifest_name_to_ids)
        {
            return Ok(target);
        }
    }

    Err(format!(
        "Move.lock V4 generation package '{}' cannot resolve dependency '{}'",
        current.id, alias
    ))
}

fn lockfile_v4_generated_deps(
    package: &LockfileV4GenerateResolvedPackage,
    all_packages: &[LockfileV4GenerateResolvedPackage],
    package_ids: &BTreeSet<String>,
    manifest_name_to_ids: &BTreeMap<String, Vec<String>>,
) -> Result<BTreeMap<String, String>, String> {
    let mut deps = BTreeMap::new();

    for dependency in &package.combined_dependencies {
        let target = lockfile_v4_resolve_dependency_target(
            package,
            dependency,
            all_packages,
            package_ids,
            manifest_name_to_ids,
        )?;
        deps.insert(dependency.name.clone(), target);
    }

    Ok(deps)
}

fn lockfile_v4_format_deps(deps: &BTreeMap<String, String>) -> String {
    if deps.is_empty() {
        return "deps = {}".to_string();
    }

    let parts = deps
        .iter()
        .map(|(alias, target)| format!("{} = {}", alias, lockfile_v4_toml_string(target)))
        .collect::<Vec<_>>();
    format!("deps = {{ {} }}", parts.join(", "))
}

fn lockfile_v4_section_environment(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with("[pinned.") || !trimmed.ends_with(']') || trimmed.starts_with("[[") {
        return None;
    }

    let inner = trimmed.trim_start_matches('[').trim_end_matches(']');
    let rest = inner.strip_prefix("pinned.")?;
    rest.split('.').next().map(|value| value.to_string())
}

fn lockfile_v4_append_other_environment_sections(
    lines: &mut Vec<String>,
    existing_lockfile: &str,
    environment: &str,
) -> Result<(), HelperError> {
    if existing_lockfile.trim().is_empty() {
        return Ok(());
    }

    existing_lockfile.parse::<toml::Value>().map_err(|error| {
        HelperError::with_code(
            "malformed_lockfile",
            format!("Failed to parse existing Move.lock: {}", error),
        )
    })?;

    let mut current_section = vec![];
    let mut in_other_environment = false;

    let flush = |lines: &mut Vec<String>, section: &mut Vec<String>| {
        if !section.is_empty() {
            lines.append(section);
            lines.push(String::new());
        }
    };

    for line in existing_lockfile.lines() {
        if let Some(section_environment) = lockfile_v4_section_environment(line) {
            if in_other_environment {
                flush(lines, &mut current_section);
            }
            in_other_environment = section_environment != environment;
            current_section = if in_other_environment {
                vec![line.to_string()]
            } else {
                vec![]
            };
            continue;
        }

        if line.trim_start().starts_with('[') {
            if in_other_environment {
                flush(lines, &mut current_section);
            }
            in_other_environment = false;
            current_section.clear();
            continue;
        }

        if in_other_environment {
            current_section.push(line.to_string());
        }
    }

    if in_other_environment {
        flush(lines, &mut current_section);
    }

    Ok(())
}

fn lockfile_v4_generate_impl(input: LockfileV4GenerateInput) -> Result<String, HelperError> {
    if !matches!(input.root.source, LockfileV4Source::Root) {
        return Err(HelperError::new(
            "Move.lock V4 generation root package must have root source",
        ));
    }

    let mut root_dep_alias_to_package_name = input.root.dep_alias_to_package_name.clone();
    for package in &input.packages {
        for alias in &package.root_dependency_aliases {
            if let Some(existing) = root_dep_alias_to_package_name.get(alias) {
                if existing != &package.id {
                    return Err(HelperError::new(format!(
                        "Move.lock V4 generation root dependency alias '{}' resolves to both '{}' and '{}'",
                        alias, existing, package.id
                    )));
                }
            }
            root_dep_alias_to_package_name.insert(alias.clone(), package.id.clone());
        }
    }

    let mut packages = vec![];
    let root_manifest =
        lockfile_v4_manifest_from_files(&input.root.id, &input.root.files, &input.environment)?;
    let root_id = lockfile_v4_package_graph_id_name(&root_manifest.0);
    packages.push(LockfileV4GenerateResolvedPackage {
        id: root_id,
        source: input.root.source,
        manifest_name: root_manifest.0.name.clone(),
        graph_id_name: lockfile_v4_package_graph_id_name(&root_manifest.0),
        combined_dependencies: root_manifest.0.combined_dependencies.clone(),
        dep_alias_to_package_name: root_dep_alias_to_package_name,
    });

    for package in input.packages {
        if matches!(package.source, LockfileV4Source::Root) {
            return Err(HelperError::new(format!(
                "Move.lock V4 generation package '{}' has unsupported root source",
                package.id
            )));
        }
        let manifest =
            lockfile_v4_manifest_from_files(&package.id, &package.files, &input.environment)?;
        packages.push(LockfileV4GenerateResolvedPackage {
            id: package.id,
            source: package.source,
            manifest_name: manifest.0.name.clone(),
            graph_id_name: lockfile_v4_package_graph_id_name(&manifest.0),
            combined_dependencies: manifest.0.combined_dependencies.clone(),
            dep_alias_to_package_name: package.dep_alias_to_package_name,
        });
    }

    packages.sort_by(|left, right| left.id.cmp(&right.id));

    let mut package_ids = BTreeSet::new();
    let mut manifest_name_to_ids: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for package in &packages {
        if !package_ids.insert(package.id.clone()) {
            return Err(HelperError::new(format!(
                "Move.lock V4 generation has duplicate package id '{}'",
                package.id
            )));
        }
        manifest_name_to_ids
            .entry(package.manifest_name.clone())
            .or_default()
            .push(package.id.clone());
        if package.graph_id_name != package.manifest_name {
            manifest_name_to_ids
                .entry(package.graph_id_name.clone())
                .or_default()
                .push(package.id.clone());
        }
    }

    let mut lines = vec![
        "# Generated by move; do not edit".to_string(),
        "# This file should be checked in.".to_string(),
        String::new(),
        "[move]".to_string(),
        "version = 4".to_string(),
        String::new(),
    ];

    for package in &packages {
        let is_root = matches!(package.source, LockfileV4Source::Root);
        lines.push(format!("[pinned.{}.{}]", input.environment, package.id));
        lines.push(lockfile_v4_format_source(
            &package.source,
            is_root,
            &package.id,
        )?);
        lines.push(format!(
            "use_environment = {}",
            lockfile_v4_toml_string(&input.environment)
        ));
        let digest = compute_manifest_digest_from_combined(package.combined_dependencies.clone())
            .ok_or_else(|| {
            HelperError::new(format!(
                "Failed to compute manifest_digest for '{}'",
                package.id
            ))
        })?;
        lines.push(format!(
            "manifest_digest = {}",
            lockfile_v4_toml_string(&digest)
        ));
        let deps =
            lockfile_v4_generated_deps(package, &packages, &package_ids, &manifest_name_to_ids)?;
        lines.push(lockfile_v4_format_deps(&deps));
        lines.push(String::new());
    }

    if let Some(existing_lockfile) = input.existing_lockfile.as_deref() {
        lockfile_v4_append_other_environment_sections(
            &mut lines,
            existing_lockfile,
            &input.environment,
        )?;
    }

    Ok(lines.join("\n"))
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

    match lockfile_v4_generate_impl(input) {
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
            match lockfile_v4_manifest_from_files(&package.id, &files, &input.environment) {
                Ok(result) => result,
                Err(error) => return LockfileV4ValidationResult::Error(error),
            };
        if let Err(error) = lockfile_v4_validate_manifest_dependency_names(&manifest) {
            return LockfileV4ValidationResult::Error(error);
        }

        if let Some(expected_digest) = package.manifest_digest.as_ref() {
            let current_digest =
                compute_manifest_digest_from_combined(manifest.combined_dependencies.clone())
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
            .filter(|dep| combined_dependency_matches_modes(dep, &input.modes))
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

fn lockfile_v4_manifest_dep_names(manifest: &LockfileV4PackageManifest) -> Vec<String> {
    let mut deps = manifest
        .combined_dependencies
        .iter()
        .map(|dependency| dependency.name.clone())
        .collect::<Vec<_>>();
    deps.sort();
    deps
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
        if lockfile_v4_is_legacy_system_dep_name(&name) {
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
                .map(lockfile_v4_normalize_legacy_name_to_identifier)
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
    let selected_move_toml = lockfile_v4_find_move_toml(files, environment).map(str::to_string);
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

fn lockfile_v4_package_graph_id_name(manifest: &LockfileV4PackageManifest) -> String {
    manifest
        .legacy_name
        .as_deref()
        .map(lockfile_v4_normalize_legacy_name_to_identifier)
        .unwrap_or_else(|| manifest.name.clone())
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
        if package.manifest.name != LOCKFILE_V4_NO_NAME_LEGACY_PACKAGE_NAME {
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
            manifest_deps: lockfile_v4_manifest_dep_names(&package.manifest),
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

fn manifest_plan_dependency_subst(
    dep_table: &toml::Table,
) -> Option<BTreeMap<String, ManifestPackagePlanSubst>> {
    let subst_table = dep_table
        .get("addr-subst")
        .or_else(|| dep_table.get("addr_subst"))
        .and_then(|value| value.as_table())?;

    let mut subst = BTreeMap::new();
    for (name, value) in subst_table {
        let Some(raw_value) = value.as_str() else {
            continue;
        };
        if normalize_hex_address_string(raw_value).is_some()
            || raw_value.starts_with("0x")
            || raw_value.chars().all(|ch| ch.is_ascii_hexdigit())
        {
            subst.insert(
                name.clone(),
                ManifestPackagePlanSubst::Assign {
                    address: raw_value.to_string(),
                },
            );
        } else {
            subst.insert(
                name.clone(),
                ManifestPackagePlanSubst::RenameFrom {
                    name: raw_value.to_string(),
                },
            );
        }
    }

    if subst.is_empty() {
        None
    } else {
        Some(subst)
    }
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
        lockfile_v4_manifest_from_files(package_id_hint, &snapshot.files, environment)?;
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
        let id = lockfile_v4_package_graph_id_name(&manifest);
        name_to_suffix.insert(id.clone(), 1);
        id
    } else {
        manifest_graph_unique_id(
            &lockfile_v4_package_graph_id_name(&manifest),
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

    let root_move_toml = lockfile_v4_find_move_toml(&input.root.files, &input.environment)
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
