use base64::{engine::general_purpose, Engine as _};
use move_bytecode_utils::Modules;
use move_compiler::compiled_unit::AnnotatedCompiledModule;
use move_compiler::{linters::LintLevel, Compiler, Flags};
use move_core_types::{account_address::AccountAddress, language_storage::ModuleId};
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
use sui_protocol_config::ProtocolConfig;
use sui_protocol_config::{Chain, ProtocolVersion};
use sui_types::move_package::{FnInfo, FnInfoKey, FnInfoMap};
#[cfg(feature = "testing")]
use sui_types::{
    base_types::{SuiAddress, TxContext},
    digests::TransactionDigest,
    in_memory_storage::InMemoryStorage,
    metrics::LimitsMetrics,
};
use sui_verifier::verifier as sui_bytecode_verifier;
use vfs::{impls::memory::MemoryFS, VfsPath};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmCompileResult {
    success: bool,
    output: String, // JSON string of compiled units or errors
}

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

mod manifest;
mod package_model;
use move_symbol_pool::Symbol;
use package_model::{
    build_compiler_input, dependency_name_is_implicit, is_system_package_name,
    parse_hex_address_to_bytes, CompilerInput, CompilerInputMode, PackageGroup,
};

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

// Ported from sui-move-build/src/lib.rs
fn fn_info(units: &[AnnotatedCompiledModule]) -> FnInfoMap {
    let mut fn_info_map = BTreeMap::new();
    for u in units {
        let mod_addr = u.named_module.address.into_inner();
        let mod_is_test = u.attributes.is_test_or_test_only();
        for (_, s, info) in &u.function_infos {
            let fn_name = s.as_str().to_string();
            let is_test = mod_is_test || info.attributes.is_test_or_test_only();
            fn_info_map.insert(FnInfoKey { fn_name, mod_addr }, FnInfo { is_test });
        }
    }
    fn_info_map
}

// Ported from sui-move-build/src/lib.rs
fn verify_bytecode(
    units: &[AnnotatedCompiledModule],
    fn_info: &FnInfoMap,
    test_mode: bool,
) -> Result<(), String> {
    let verifier_config = ProtocolConfig::get_for_version(ProtocolVersion::MAX, Chain::Unknown)
        .verifier_config(/* signing_limits */ None);

    for unit in units {
        let m = &unit.named_module.module;
        move_bytecode_verifier::verify_module_unmetered(m)
            .map_err(|err| format!("Module Verification Failure: {}", err))?;

        if !test_mode {
            sui_bytecode_verifier::sui_verify_module_unmetered(m, fn_info, &verifier_config)
                .map_err(|err| format!("Sui Module Verification Failure: {}", err))?;
        }
    }
    Ok(())
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

fn setup_vfs(
    files_json: &str,
    dependencies_json: &str,
) -> Result<(VfsPath, BTreeMap<String, String>, Vec<PackageGroup>), String> {
    let files: BTreeMap<String, String> = serde_json::from_str(files_json)
        .map_err(|e| format!("Failed to parse files JSON: {}", e))?;

    let dep_packages: Vec<PackageGroup> = if dependencies_json.is_empty() {
        vec![]
    } else {
        serde_json::from_str(dependencies_json)
            .map_err(|e| format!("Failed to parse dependencies JSON: {}", e))?
    };

    let fs = MemoryFS::new();
    let root = VfsPath::new(fs);

    let ensure_parents = |path: &VfsPath| -> Result<(), String> {
        let parent = path.parent();
        let mut ancestors = vec![];
        let mut curr_path = parent;

        loop {
            ancestors.push(curr_path.clone());
            if curr_path.as_str() == "/" {
                break;
            }
            let next = curr_path.parent();
            if next.as_str() == curr_path.as_str() {
                break;
            }
            curr_path = next;
        }

        while let Some(p) = ancestors.pop() {
            if !p.exists().map_err(|e| e.to_string())? {
                p.create_dir().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    };

    for (name, content) in &files {
        let path = root
            .join(name)
            .map_err(|e| format!("Invalid path {}: {}", name, e))?;
        ensure_parents(&path)?;
        path.create_file()
            .and_then(|mut f| {
                use std::io::Write;
                write!(f, "{}", content)?;
                Ok(())
            })
            .map_err(|e| format!("Failed to create file {}: {}", name, e))?;
    }

    for pkg in &dep_packages {
        for (name, content) in &pkg.files {
            let path = root
                .join(name)
                .map_err(|e| format!("Invalid dep path {}: {}", name, e))?;
            ensure_parents(&path)?;
            path.create_file()
                .and_then(|mut f| {
                    use std::io::Write;
                    write!(f, "{}", content)?;
                    Ok(())
                })
                .map_err(|e| format!("Failed to create dep file {}: {}", name, e))?;
        }
    }

    Ok((root, files, dep_packages))
}

fn compile_impl(
    files_json: &str,
    dependencies_json: &str,
    options_json: Option<String>,
) -> WasmCompileResult {
    console_error_panic_hook::set_once();

    let options: WasmCompileOptions = match options_json {
        Some(json) => match serde_json::from_str(&json) {
            Ok(options) => options,
            Err(error) => {
                return WasmCompileResult {
                    success: false,
                    output: format!("Invalid compile options: {}", error),
                }
            }
        },
        None => WasmCompileOptions::default(),
    };

    let ansi_color = options.ansi_color;
    if ansi_color {
        colored::control::set_override(true);
    } else {
        colored::control::set_override(false);
    }

    let lint_level = match parse_lint_level(options.lint_flag.as_deref()) {
        Ok(level) => level,
        Err(error) => {
            return WasmCompileResult {
                success: false,
                output: error,
            }
        }
    };

    let (root, files, dep_packages) = match setup_vfs(files_json, dependencies_json) {
        Ok(res) => res,
        Err(e) => {
            return WasmCompileResult {
                success: false,
                output: e,
            }
        }
    };

    let compiler_input = match build_compiler_input(
        &files,
        &dep_packages,
        CompilerInputMode::Build {
            root_as_zero: options.compile_intent.root_as_zero(),
            set_unpublished_deps_to_zero: options.with_unpublished_dependencies,
        },
    ) {
        Ok(input) => input,
        Err(error) => {
            return WasmCompileResult {
                success: false,
                output: error,
            }
        }
    };
    let CompilerInput {
        root_package_name,
        package_paths,
        dependency_ids_by_name,
    } = compiler_input;

    let mut compiler = match Compiler::from_package_paths(Some(root), package_paths, Vec::new()) {
        Ok(c) => c,
        Err(e) => {
            return WasmCompileResult {
                success: false,
                output: format!("Failed to create compiler: {}", e),
            }
        }
    };

    let build_config = compiler_build_config(options.silence_warnings, lint_level, options.modes);
    compiler = configure_compiler_for_sui(compiler, &build_config);

    let (compiler_files, res) = match compiler.build() {
        Ok(res) => res,
        Err(e) => {
            return WasmCompileResult {
                success: false,
                output: format!("Compiler initialization error: {}", e),
            }
        }
    };

    match res {
        Ok((units, warning_diags)) => {
            let fn_info = fn_info(&units);
            if let Err(e) = verify_bytecode(&units, &fn_info, false) {
                return WasmCompileResult {
                    success: false,
                    output: format!("Bytecode Verification Failed: {}", e),
                };
            }

            // Do not filter dependencies based on bytecode usage. CLI uses all resolved dependencies (Linkage Table)
            // for digest calculation. Filtering causes digest mismatch.
            //
            // ORIGINAL SOURCE REFERENCE:
            // - move-package-alt/src/graph/linkage.rs:40 - LinkageTable maps OriginalID -> PackageInfo
            // - sui-move-build/src/lib.rs - dump_bytecode_as_base64() uses complete linkage table
            // - Digest calculation includes ALL dependencies in the linkage table, not just used ones
            let mut dependency_ids_by_name = dependency_ids_by_name.clone();
            dependency_ids_by_name.sort_by(|(name_a, id_a), (name_b, id_b)| {
                name_a.cmp(name_b).then_with(|| id_a.cmp(id_b))
            });
            let dependency_ids_vec: Vec<[u8; 32]> = dependency_ids_by_name
                .into_iter()
                .map(|(_, id)| id)
                .collect();
            let mut module_infos: Vec<(
                ModuleId,
                move_compiler::compiled_unit::NamedCompiledModule,
            )> = Vec::new();
            for unit in units {
                let pkg_name = unit
                    .named_module
                    .package_name
                    .map(|s| s.to_string())
                    .unwrap_or("".to_string());

                let is_root = pkg_name == "root"
                    || pkg_name == root_package_name
                    || unit.named_module.package_name.is_none();

                if is_root {
                    let id = unit.named_module.module.self_id();
                    module_infos.push((id, unit.named_module));
                }
            }

            // Use Move utility to mirror CLI dependency ordering.
            let module_set = Modules::new(module_infos.iter().map(|(_, m)| &m.module));
            let ordered_ids: Vec<ModuleId> = match module_set.compute_topological_order() {
                Ok(iter) => iter.map(|m| m.self_id()).collect(),
                Err(e) => {
                    return WasmCompileResult {
                        success: false,
                        output: format!("Failed to compute module ordering: {}", e),
                    }
                }
            };

            let mut ordered_modules: Vec<(
                ModuleId,
                move_compiler::compiled_unit::NamedCompiledModule,
            )> = Vec::new();
            for id in ordered_ids {
                if let Some((_, module)) = module_infos.iter().find(|(mid, _)| *mid == id).cloned()
                {
                    ordered_modules.push((id, module));
                }
            }
            for pair in module_infos {
                if !ordered_modules.iter().any(|(mid, _)| *mid == pair.0) {
                    ordered_modules.push(pair);
                }
            }
            let module_infos = ordered_modules;

            // Serialize in compiler-provided order (already dependency-topological).
            let mut modules = vec![];
            let mut module_bytes = vec![];
            for (_idx, (_id, module)) in module_infos.iter().enumerate() {
                let bytes = module.serialize();
                module_bytes.push(bytes.clone());
                modules.push(general_purpose::STANDARD.encode(&bytes));
            }

            // Canonical Digest Calculation
            let dep_object_ids: Vec<sui_types::base_types::ObjectID> = dependency_ids_vec
                .iter()
                .map(|bytes| sui_types::base_types::ObjectID::new(*bytes))
                .collect();

            let package_digest =
                sui_types::move_package::MovePackage::compute_digest_for_modules_and_deps(
                    &module_bytes,
                    &dep_object_ids,
                    true, // hash_modules matches default behavior usually
                );

            let output_data = WasmCompilationOutput {
                modules,
                dependencies: dependency_ids_vec
                    .iter()
                    .map(|bytes| AccountAddress::new(*bytes).to_canonical_string(true))
                    .collect(),
                digest: package_digest.to_vec(),
                warnings: {
                    if !options.silence_warnings && !warning_diags.is_empty() {
                        let warning_buffer =
                            move_compiler::diagnostics::report_diagnostics_to_buffer(
                                &compiler_files,
                                warning_diags,
                                ansi_color,
                            );
                        String::from_utf8(warning_buffer).ok()
                    } else {
                        None
                    }
                },
            };

            WasmCompileResult {
                success: true,
                output: serde_json::to_string(&output_data).unwrap_or_default(),
            }
        }
        Err(diags) => {
            let error_buffer = move_compiler::diagnostics::report_diagnostics_to_buffer(
                &compiler_files,
                diags,
                ansi_color,
            );
            WasmCompileResult {
                success: false,
                output: String::from_utf8_lossy(&error_buffer).to_string(),
            }
        }
    }
}

#[wasm_bindgen]
pub fn compile(
    files_json: &str,
    dependencies_json: &str,
    options_json: Option<String>,
) -> WasmCompileResult {
    compile_impl(files_json, dependencies_json, options_json)
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

    let (root, files, dep_packages) = match setup_vfs(files_json, dependencies_json) {
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
    let build_config = compiler_build_config(false, LintLevel::None, test_modes);
    let compiler = configure_compiler_for_sui(compiler, &build_config);
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

#[derive(Deserialize)]
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
    addresses: Option<BTreeMap<String, String>>,
    #[serde(default)]
    use_environment: Option<String>,
}

#[derive(Serialize)]
struct RepinTriggers {
    deps: BTreeMap<String, ReplacementDependency>,
}

fn digest_dependency(dep: DigestDepInfo) -> (String, ReplacementDependency) {
    let dep_info: Option<DefaultDependency> = if let Some(repo) = dep.git {
        Some(DefaultDependency {
            dependency_info: ManifestDependencyInfo::Git(ManifestGitDependency {
                repo,
                rev: dep.rev,
                subdir: std::path::PathBuf::from(dep.subdir.unwrap_or_default()),
            }),
            is_override: dep.is_override.unwrap_or(false),
            rename_from: None,
            modes: None,
        })
    } else if let Some(local_path) = dep.local {
        Some(DefaultDependency {
            dependency_info: ManifestDependencyInfo::Local(LocalDepInfo {
                local: std::path::PathBuf::from(local_path),
            }),
            is_override: dep.is_override.unwrap_or(false),
            rename_from: None,
            modes: None,
        })
    } else if let Some(system_name) = dep.system {
        Some(DefaultDependency {
            dependency_info: ManifestDependencyInfo::System(SystemDependency {
                system: system_name,
            }),
            is_override: dep.is_override.unwrap_or(true),
            rename_from: None,
            modes: None,
        })
    } else {
        None
    };

    (
        dep.name,
        ReplacementDependency {
            dependency: dep_info,
            addresses: None,
            use_environment: dep.use_environment,
        },
    )
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

fn dep_info_from_toml(name: String, value: &toml::Value, environment: &str) -> DigestDepInfo {
    let mut info = DigestDepInfo {
        name: name.clone(),
        git: None,
        subdir: None,
        rev: None,
        local: None,
        system: None,
        is_override: None,
        use_environment: Some(environment.to_string()),
    };

    if let Some(table) = value.as_table() {
        info.git = table
            .get("git")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        info.subdir = table
            .get("subdir")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        info.rev = table
            .get("rev")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        info.local = table
            .get("local")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        info.system = table
            .get("system")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        info.is_override = table.get("override").and_then(|value| value.as_bool());
    }

    if info.git.is_none() && info.local.is_none() && info.system.is_none() {
        let lower = name.to_ascii_lowercase();
        if lower == "sui" || lower == "std" || lower == "movestdlib" {
            info.system = Some(if lower == "movestdlib" {
                "std".to_string()
            } else {
                lower
            });
            info.is_override = Some(true);
        }
    }

    info
}

fn digest_deps_from_move_toml(
    move_toml: &str,
    package_name_override: Option<String>,
    environment: &str,
) -> Option<Vec<DigestDepInfo>> {
    let parsed = move_toml.parse::<toml::Value>().ok()?;
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

    let mut deps = vec![];
    let mut has_implicit = false;
    if let Some(dep_table) = parsed.get("dependencies").and_then(|deps| deps.as_table()) {
        for (name, value) in dep_table {
            if dependency_name_is_implicit(name) {
                has_implicit = true;
            }
            deps.push(dep_info_from_toml(name.to_string(), value, environment));
        }
    }

    if !has_implicit && !is_system_package_name(&package_name) {
        deps.push(DigestDepInfo {
            name: "sui".to_string(),
            git: None,
            subdir: None,
            rev: None,
            local: None,
            system: Some("sui".to_string()),
            is_override: Some(true),
            use_environment: Some(environment.to_string()),
        });
        deps.push(DigestDepInfo {
            name: "std".to_string(),
            git: None,
            subdir: None,
            rev: None,
            local: None,
            system: Some("std".to_string()),
            is_override: Some(true),
            use_environment: Some(environment.to_string()),
        });
    }

    Some(deps)
}

/// Compute manifest digest from a Move.toml manifest. This is the preferred
/// WASM entrypoint because Rust owns the Move.toml dependency semantics.
#[wasm_bindgen]
pub fn compute_manifest_digest_from_move_toml(
    move_toml: &str,
    package_name_override: Option<String>,
    environment: &str,
) -> String {
    digest_deps_from_move_toml(move_toml, package_name_override, environment)
        .and_then(compute_manifest_digest_from_deps)
        .unwrap_or_default()
}

/// Backward-compatible JSON entrypoint. New code should prefer
/// `compute_manifest_digest_from_move_toml`.
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
    root_package_name: String,
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
}

struct LockfileV4GenerateResolvedPackage {
    id: String,
    source: LockfileV4Source,
    move_toml: String,
    manifest_name: String,
    dep_alias_to_package_name: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4ValidatedGraph {
    root_id: String,
    lockfile_order: Vec<String>,
    packages: Vec<LockfileV4ValidatedPackage>,
    edges: Vec<LockfileV4ValidatedEdge>,
}

#[derive(Serialize)]
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
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    edition: Option<String>,
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LockfileV4ValidatedEdge {
    from: String,
    to: String,
    alias: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    modes: Vec<String>,
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

#[derive(Clone, Serialize)]
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

#[derive(Debug)]
struct HelperError {
    message: String,
    code: Option<&'static str>,
}

impl HelperError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    fn with_code(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
        }
    }
}

impl From<String> for HelperError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

fn lockfile_v4_error_response(error: String, code: Option<&'static str>) -> String {
    let mut response = serde_json::json!({
        "status": "error",
        "error": error,
    });
    if let Some(code) = code {
        response["code"] = serde_json::json!(code);
    }
    response.to_string()
}

fn lockfile_v4_error(error: impl Into<String>) -> String {
    lockfile_v4_error_response(error.into(), None)
}

fn lockfile_v4_error_with_code(code: &'static str, error: impl Into<String>) -> String {
    lockfile_v4_error_response(error.into(), Some(code))
}

fn lockfile_v4_error_from_helper(error: HelperError) -> String {
    lockfile_v4_error_response(error.message, error.code)
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

#[wasm_bindgen]
pub fn lockfile_v4_fetch_plan(move_lock_toml: &str, environment: &str) -> String {
    match lockfile_v4_plan_from_toml(move_lock_toml, environment) {
        Ok(Some((root_id, lockfile_order, packages))) => serde_json::json!({
            "status": "ok",
            "rootId": root_id,
            "lockfileOrder": lockfile_order,
            "packages": packages,
        })
        .to_string(),
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

fn dependency_value_matches_modes(dep_value: &toml::Value, modes: &[String]) -> bool {
    let Some(dep_table) = dep_value.as_table() else {
        return true;
    };
    let Some(dep_modes) = dep_table.get("modes").and_then(|value| value.as_array()) else {
        return true;
    };
    dep_modes.iter().any(|mode| match mode.as_str() {
        Some(dep_mode) => modes.iter().any(|active| active == dep_mode),
        None => false,
    })
}

fn dependency_value_mode_names(dep_value: &toml::Value) -> Vec<String> {
    dep_value
        .as_table()
        .and_then(|table| table.get("modes"))
        .and_then(|value| value.as_array())
        .map(|modes| {
            modes
                .iter()
                .filter_map(|mode| mode.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn lockfile_v4_dependency_values_for_filter(
    move_toml: &str,
    modes: Option<&[String]>,
) -> Result<BTreeMap<String, toml::Value>, String> {
    let parsed = move_toml
        .parse::<toml::Value>()
        .map_err(|error| format!("Failed to parse Move.toml dependencies: {}", error))?;
    Ok(parsed
        .get("dependencies")
        .and_then(|deps| deps.as_table())
        .map(|deps| {
            deps.iter()
                .filter(|(_, value)| {
                    modes
                        .map(|modes| dependency_value_matches_modes(value, modes))
                        .unwrap_or(true)
                })
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default())
}

fn lockfile_v4_add_present_implicit_aliases(
    package_deps: &BTreeMap<String, String>,
    aliases: &mut BTreeSet<String>,
) {
    for alias in package_deps.keys() {
        if dependency_name_is_implicit(alias) {
            aliases.insert(alias.clone());
        }
    }
}

fn lockfile_v4_dependency_aliases_for_lockfile(move_toml: &str) -> BTreeSet<String> {
    let Ok(value) = move_toml.parse::<toml::Value>() else {
        return BTreeSet::new();
    };

    value
        .get("dependencies")
        .and_then(|deps| deps.as_table())
        .map(|deps| deps.iter().map(|(name, _)| name.clone()).collect())
        .unwrap_or_default()
}

fn lockfile_v4_dependency_aliases_for_modes(move_toml: &str, modes: &[String]) -> BTreeSet<String> {
    let Ok(values) = lockfile_v4_dependency_values_for_filter(move_toml, Some(modes)) else {
        return BTreeSet::new();
    };
    values.keys().cloned().collect::<BTreeSet<_>>()
}

fn lockfile_v4_dependency_modes_by_alias(move_toml: &str) -> BTreeMap<String, Vec<String>> {
    let Ok(values) = lockfile_v4_dependency_values_for_filter(move_toml, None) else {
        return BTreeMap::new();
    };
    values
        .iter()
        .map(|(alias, value)| (alias.clone(), dependency_value_mode_names(value)))
        .collect()
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

    let name = package
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or(package_id)
        .to_string();
    let version = package
        .get("version")
        .and_then(|value| value.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let edition = package
        .get("edition")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
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
    if let Some(address) = address_to_use {
        if !addresses.contains_key(&name) && is_move_named_address(&name) {
            addresses.insert(name.clone(), address);
        }
    } else if !addresses.contains_key(&name) && is_move_named_address(&name) {
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
            version,
            edition,
            published_at: published_at.clone(),
            original_id,
            latest_published_id: published_at,
            addresses,
            dependencies,
            dev_dependencies,
        },
        move_toml.to_string(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootPublicationMetadataInput {
    environment: String,
    files: BTreeMap<String, String>,
}

#[wasm_bindgen]
pub fn root_publication_metadata(input_json: &str) -> String {
    let input: RootPublicationMetadataInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return serde_json::json!({
                "status": "error",
                "error": format!("Invalid root publication metadata input: {}", error),
            })
            .to_string()
        }
    };

    match lockfile_v4_manifest_from_files("root", &input.files, &input.environment) {
        Ok((manifest, _)) => serde_json::json!({
            "status": "ok",
            "packageName": manifest.name,
            "publishedAt": manifest.published_at,
            "originalId": manifest.original_id,
        })
        .to_string(),
        Err(error) => serde_json::json!({
            "status": "error",
            "error": error,
        })
        .to_string(),
    }
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
    }
}

fn lockfile_v4_dependency_values_for_lockfile(
    move_toml: &str,
) -> Result<BTreeMap<String, toml::Value>, String> {
    lockfile_v4_dependency_values_for_filter(move_toml, None)
}

fn lockfile_v4_source_matches_dependency(
    source: &LockfileV4Source,
    dependency_value: &toml::Value,
) -> bool {
    let Some(table) = dependency_value.as_table() else {
        return false;
    };

    match source {
        LockfileV4Source::Git { git, rev, subdir } => {
            let dep_git = table.get("git").and_then(|value| value.as_str());
            let dep_rev = table.get("rev").and_then(|value| value.as_str());
            let dep_subdir = table
                .get("subdir")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            dep_git == Some(git.as_str())
                && dep_rev == Some(rev.as_str())
                && dep_subdir == subdir.as_deref().unwrap_or_default()
        }
        LockfileV4Source::Local { local } => table
            .get("local")
            .and_then(|value| value.as_str())
            .map(|dep_local| dep_local == local)
            .unwrap_or(false),
        LockfileV4Source::Root => false,
    }
}

fn lockfile_v4_dependency_package_hint(dependency_value: &toml::Value) -> Option<String> {
    dependency_value
        .as_table()
        .and_then(|table| {
            table
                .get("package")
                .or_else(|| table.get("rename-from"))
                .or_else(|| table.get("rename_from"))
        })
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
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
    alias: &str,
    dependency_value: &toml::Value,
    all_packages: &[LockfileV4GenerateResolvedPackage],
    package_ids: &BTreeSet<String>,
    manifest_name_to_ids: &BTreeMap<String, Vec<String>>,
) -> Result<String, String> {
    if let Some(target) = current.dep_alias_to_package_name.get(alias) {
        if package_ids.contains(target) {
            return Ok(target.clone());
        }
        return Err(format!(
            "Move.lock V4 generation package '{}' dependency '{}' references unknown package '{}'",
            current.id, alias, target
        ));
    }

    let mut source_matches = all_packages
        .iter()
        .filter(|package| package.id != current.id)
        .filter(|package| lockfile_v4_source_matches_dependency(&package.source, dependency_value))
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

    if let Some(package_hint) = lockfile_v4_dependency_package_hint(dependency_value) {
        if package_ids.contains(&package_hint) {
            return Ok(package_hint);
        }
        if let Some(ids) = manifest_name_to_ids.get(&package_hint) {
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
    let dependency_values = lockfile_v4_dependency_values_for_lockfile(&package.move_toml)?;
    let has_implicit = dependency_values
        .keys()
        .any(|name| dependency_name_is_implicit(name));
    let mut deps = BTreeMap::new();

    for (alias, value) in &dependency_values {
        let target = lockfile_v4_resolve_dependency_target(
            package,
            alias,
            value,
            all_packages,
            package_ids,
            manifest_name_to_ids,
        )?;
        deps.insert(alias.clone(), target);
    }

    if !has_implicit && !is_system_package_name(&package.id) {
        for alias in ["sui", "std"] {
            let target =
                lockfile_v4_find_implicit_target(alias, package_ids, manifest_name_to_ids)
                    .ok_or_else(|| {
                        format!(
                            "Move.lock V4 generation package '{}' needs implicit dependency '{}' but no package was provided",
                            package.id, alias
                        )
                    })?;
            deps.entry(alias.to_string()).or_insert(target);
        }
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

    let mut packages = vec![];
    let root_manifest =
        lockfile_v4_manifest_from_files(&input.root.id, &input.root.files, &input.environment)?;
    packages.push(LockfileV4GenerateResolvedPackage {
        id: input.root.id,
        source: input.root.source,
        move_toml: root_manifest.1,
        manifest_name: root_manifest.0.name,
        dep_alias_to_package_name: input.root.dep_alias_to_package_name,
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
            move_toml: manifest.1,
            manifest_name: manifest.0.name,
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
        let digest = compute_manifest_digest_from_move_toml(
            &package.move_toml,
            Some(package.id.clone()),
            &input.environment,
        );
        if digest.is_empty() {
            return Err(HelperError::new(format!(
                "Failed to compute manifest_digest for '{}'",
                package.id
            )));
        }
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

        let (manifest, move_toml) =
            match lockfile_v4_manifest_from_files(&package.id, &files, &input.environment) {
                Ok(result) => result,
                Err(error) => return LockfileV4ValidationResult::Error(error),
            };

        if let Some(expected_digest) = package.manifest_digest.as_ref() {
            let package_name = if matches!(package.source, LockfileV4Source::Root) {
                input.root_package_name.clone()
            } else {
                manifest.name.clone()
            };
            let current_digest = compute_manifest_digest_from_move_toml(
                &move_toml,
                Some(package_name),
                &input.environment,
            );
            if !current_digest.eq_ignore_ascii_case(expected_digest) {
                return LockfileV4ValidationResult::OutOfDate(package.id.clone());
            }
        } else {
            return LockfileV4ValidationResult::OutOfDate(package.id.clone());
        }

        let mut lockfile_deps = lockfile_v4_dependency_aliases_for_lockfile(&move_toml);
        lockfile_v4_add_present_implicit_aliases(&package.deps, &mut lockfile_deps);
        for alias in &lockfile_deps {
            if !package.deps.contains_key(alias) {
                return LockfileV4ValidationResult::Error(format!(
                    "Move.lock V4 pinned.{}.{} is missing dependency '{}'",
                    input.environment, package.id, alias
                ));
            }
        }

        let dep_modes_by_alias = lockfile_v4_dependency_modes_by_alias(&move_toml);
        let mut active_aliases = lockfile_v4_dependency_aliases_for_modes(&move_toml, &input.modes);
        lockfile_v4_add_present_implicit_aliases(&package.deps, &mut active_aliases);
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
        .dependencies
        .as_object()
        .map(|deps| deps.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    deps.sort();
    deps
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

fn lockfile_v4_reachable_ids(graph: &LockfileV4ValidatedGraph) -> BTreeSet<String> {
    let mut edges_by_from: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in &graph.edges {
        edges_by_from
            .entry(edge.from.clone())
            .or_default()
            .push(edge.to.clone());
    }

    let mut reachable = BTreeSet::new();
    let mut stack = vec![graph.root_id.clone()];
    while let Some(id) = stack.pop() {
        if !reachable.insert(id.clone()) {
            continue;
        }
        if let Some(targets) = edges_by_from.get(&id) {
            for target in targets {
                stack.push(target.clone());
            }
        }
    }
    reachable
}

fn lockfile_v4_package_groups_from_validated_with_orders(
    input: &LockfileV4ValidateInput,
    graph: LockfileV4ValidatedGraph,
    dependency_order: &[String],
    lockfile_order: &[String],
) -> Result<LockfileV4PackageGroups, String> {
    let packages_by_id = graph
        .packages
        .iter()
        .map(|package| (package.id.clone(), package))
        .collect::<BTreeMap<_, _>>();
    let input_by_id = input
        .packages
        .iter()
        .map(|package| (package.id.clone(), package))
        .collect::<BTreeMap<_, _>>();

    let root_package = packages_by_id.get(&graph.root_id).ok_or_else(|| {
        format!(
            "Move.lock V4 graph is missing root package '{}'",
            graph.root_id
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

    let mut global_address_map = BTreeMap::new();
    for package in &graph.packages {
        if let Some(compile_id) = lockfile_v4_package_compile_id(&package.id, &package.manifest) {
            if is_move_named_address(&package.manifest.name) {
                global_address_map.insert(package.manifest.name.clone(), compile_id.clone());
            }
            if is_move_named_address(&package.id) {
                global_address_map.insert(package.id.clone(), compile_id);
            }
        }
    }

    let mut root_files = lockfile_v4_compiler_files(&root_input_files, &input.environment, None);
    if let Some(root_move_toml) = root_files.get("Move.toml").cloned() {
        root_files.insert(
            "Move.toml".to_string(),
            lockfile_v4_move_toml_with_addresses(&root_move_toml, &root_package.manifest.addresses),
        );
    }

    let mut root_aliases_by_target: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in graph.edges.iter().filter(|edge| edge.from == graph.root_id) {
        root_aliases_by_target
            .entry(edge.to.clone())
            .or_default()
            .push(edge.alias.clone());
    }
    for aliases in root_aliases_by_target.values_mut() {
        aliases.sort();
    }

    let reachable = lockfile_v4_reachable_ids(&graph);
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

        let mut address_mapping = package.manifest.addresses.clone();
        for (name, address) in &global_address_map {
            address_mapping.insert(name.clone(), address.clone());
        }

        let group = LockfileV4PackageGroup {
            name: package.id.clone(),
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
        active_group.dep_alias_to_package_name = package.active_dep_alias_to_package_name.clone();
        active_groups_by_id.insert(package.id.clone(), active_group);
        groups_by_id.insert(package.id.clone(), group);
    }

    let dependencies = dependency_order
        .iter()
        .filter(|package_id| *package_id != &graph.root_id && reachable.contains(*package_id))
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
    lockfile_v4_package_groups_from_validated_with_orders(input, graph, &order, &order)
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

fn manifest_plan_infer_sui_framework_subdir(package_name: &str) -> Option<&'static str> {
    match package_name {
        "Sui" | "sui" | "SuiFramework" => Some("crates/sui-framework/packages/sui-framework"),
        "MoveStdlib" => Some("crates/sui-framework/packages/move-stdlib"),
        "SuiSystem" => Some("crates/sui-framework/packages/sui-system"),
        "Bridge" => Some("crates/sui-framework/packages/bridge"),
        _ => None,
    }
}

fn manifest_plan_is_sui_repo(git: &str) -> bool {
    git.contains("github.com/MystenLabs/sui")
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

fn manifest_plan_dependency_source(
    package_name: &str,
    dep_name: &str,
    dep_table: &toml::Table,
    parent_source: &LockfileV4Source,
) -> Result<ManifestPackagePlanSource, HelperError> {
    if let Some(git) = dep_table.get("git").and_then(|value| value.as_str()) {
        let rev = dep_table
            .get("rev")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                HelperError::new(format!(
                    "Dependency '{}.{}' has git source without rev",
                    package_name, dep_name
                ))
            })?;
        let subdir = dep_table
            .get("subdir")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .or_else(|| {
                if manifest_plan_is_sui_repo(git) {
                    manifest_plan_infer_sui_framework_subdir(dep_name).map(str::to_string)
                } else {
                    None
                }
            });
        return Ok(ManifestPackagePlanSource::Git {
            git: git.to_string(),
            rev: rev.to_string(),
            subdir,
            is_implicit: false,
        });
    }

    if let Some(local) = dep_table.get("local").and_then(|value| value.as_str()) {
        return match parent_source {
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
                local: local.to_string(),
            }),
        };
    }

    Err(HelperError::with_code(
        "unsupported_dependency_source",
        format!(
            "Dependency '{}.{}' has unsupported source form",
            package_name, dep_name
        ),
    ))
}

fn manifest_plan_dependencies_from_move_toml(
    move_toml: &str,
    package_name: &str,
    parent_source: &LockfileV4Source,
) -> Result<Vec<ManifestPackagePlanDependency>, HelperError> {
    let value = move_toml.parse::<toml::Value>().map_err(|error| {
        HelperError::with_code(
            "manifest_parse_failed",
            format!(
                "Failed to parse Move.toml for '{}': {}",
                package_name, error
            ),
        )
    })?;
    let Some(deps_table) = value.get("dependencies").and_then(|deps| deps.as_table()) else {
        return Ok(vec![]);
    };

    let mut dependencies = vec![];
    for (dep_name, dep_value) in deps_table {
        let dep_table = dep_value.as_table().ok_or_else(|| {
            HelperError::with_code(
                "unsupported_dependency_source",
                format!(
                    "Dependency '{}.{}' must be a table with a supported source",
                    package_name, dep_name
                ),
            )
        })?;
        dependencies.push(ManifestPackagePlanDependency {
            name: dep_name.clone(),
            source: manifest_plan_dependency_source(
                package_name,
                dep_name,
                dep_table,
                parent_source,
            )?,
            modes: manifest_plan_dependency_modes(package_name, dep_name, dep_table)?,
            subst: manifest_plan_dependency_subst(dep_table),
        });
    }

    Ok(dependencies)
}

fn manifest_plan_dependency_modes(
    package_name: &str,
    dep_name: &str,
    dep_table: &toml::value::Table,
) -> Result<Vec<String>, HelperError> {
    let Some(modes_value) = dep_table.get("modes") else {
        return Ok(vec![]);
    };
    let modes_array = modes_value.as_array().ok_or_else(|| {
        HelperError::with_code(
            "invalid_dependency_modes",
            format!(
                "Dependency '{}.{}' modes must be an array of strings",
                package_name, dep_name
            ),
        )
    })?;

    let mut modes = Vec::new();
    for mode in modes_array {
        let mode = mode.as_str().ok_or_else(|| {
            HelperError::with_code(
                "invalid_dependency_modes",
                format!(
                    "Dependency '{}.{}' modes must be an array of strings",
                    package_name, dep_name
                ),
            )
        })?;
        modes.push(mode.to_string());
    }
    Ok(modes)
}

fn manifest_plan_add_implicit_dependencies(
    is_root: bool,
    framework_rev: &Option<String>,
    package_name: &str,
    dependencies: &mut Vec<ManifestPackagePlanDependency>,
) -> Result<(), String> {
    if !is_root || is_system_package_name(package_name) {
        return Ok(());
    }
    if dependencies
        .iter()
        .any(|dep| dep.name == "Sui" || dep.name == "sui")
    {
        return Ok(());
    }

    let framework_rev = framework_rev.as_ref().ok_or_else(|| {
        "manifest graph resolution requires frameworkRev for implicit Sui dependency".to_string()
    })?;
    dependencies.push(ManifestPackagePlanDependency {
        name: "Sui".to_string(),
        source: ManifestPackagePlanSource::Git {
            git: "https://github.com/MystenLabs/sui.git".to_string(),
            rev: framework_rev.clone(),
            subdir: Some("crates/sui-framework/packages/sui-framework".to_string()),
            is_implicit: true,
        },
        modes: vec![],
        subst: None,
    });
    Ok(())
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
    framework_rev: &Option<String>,
    package_id_hint: &str,
    snapshot: &ManifestGraphPackageSnapshot,
    is_root: bool,
) -> Result<
    (
        LockfileV4PackageManifest,
        Vec<ManifestPackagePlanDependency>,
    ),
    HelperError,
> {
    let (manifest, move_toml) =
        lockfile_v4_manifest_from_files(package_id_hint, &snapshot.files, environment)?;
    let mut dependencies =
        manifest_plan_dependencies_from_move_toml(&move_toml, &manifest.name, &snapshot.source)?;
    manifest_plan_add_implicit_dependencies(
        is_root,
        framework_rev,
        &manifest.name,
        &mut dependencies,
    )?;
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
        is_root,
    )?;
    let package_id = if is_root {
        let id = manifest.name.clone();
        name_to_suffix.insert(id.clone(), 1);
        id
    } else {
        manifest_graph_unique_id(&manifest.name, name_to_suffix)
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
                    parent_package_name: nodes[node_index].manifest.name.clone(),
                    parent_source: nodes[node_index].source.clone(),
                });
            None
        };

        if let Some(target_id) = target_id {
            resolved_edges.push((dependency.name, target_id, dependency.modes));
        }
    }

    for (alias, target_id, modes) in resolved_edges {
        nodes[node_index]
            .dep_alias_to_package_name
            .insert(alias.clone(), target_id.clone());
        edges.push(LockfileV4ValidatedEdge {
            from: package_id.clone(),
            to: target_id,
            alias,
            modes,
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

fn manifest_graph_compiler_order(
    root_id: &str,
    nodes: &[ManifestGraphNode],
    edges: &[LockfileV4ValidatedEdge],
) -> Vec<String> {
    let node_by_id = nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let mut edges_by_from: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in edges {
        edges_by_from
            .entry(edge.from.clone())
            .or_default()
            .push(edge.to.clone());
    }

    let mut linkage: BTreeMap<String, (usize, String)> = BTreeMap::new();
    fn visit_linkage(
        id: &str,
        depth: usize,
        node_by_id: &BTreeMap<String, &ManifestGraphNode>,
        edges_by_from: &BTreeMap<String, Vec<String>>,
        linkage: &mut BTreeMap<String, (usize, String)>,
    ) {
        let Some(node) = node_by_id.get(id) else {
            return;
        };
        let linkage_key = node
            .manifest
            .original_id
            .clone()
            .or_else(|| node.manifest.published_at.clone())
            .unwrap_or_else(|| node.id.clone());
        if let Some((existing_depth, _)) = linkage.get(&linkage_key) {
            if *existing_depth <= depth {
                return;
            }
        }
        linkage.insert(linkage_key, (depth, node.id.clone()));
        if let Some(targets) = edges_by_from.get(id) {
            for target in targets {
                visit_linkage(target, depth + 1, node_by_id, edges_by_from, linkage);
            }
        }
    }
    visit_linkage(root_id, 0, &node_by_id, &edges_by_from, &mut linkage);

    let mut visited = BTreeSet::new();
    let mut order = Vec::new();
    fn collect(
        id: &str,
        node_by_id: &BTreeMap<String, &ManifestGraphNode>,
        edges_by_from: &BTreeMap<String, Vec<String>>,
        linkage: &BTreeMap<String, (usize, String)>,
        visited: &mut BTreeSet<String>,
        order: &mut Vec<String>,
    ) {
        if !visited.insert(id.to_string()) {
            return;
        }
        let Some(node) = node_by_id.get(id) else {
            return;
        };
        if let Some(targets) = edges_by_from.get(id) {
            let mut sorted_targets = targets.clone();
            sorted_targets.sort();
            for target in sorted_targets {
                let Some(target_node) = node_by_id.get(&target) else {
                    continue;
                };
                let linkage_key = target_node
                    .manifest
                    .original_id
                    .clone()
                    .or_else(|| target_node.manifest.published_at.clone())
                    .unwrap_or_else(|| target_node.id.clone());
                if let Some((_, linked_id)) = linkage.get(&linkage_key) {
                    collect(
                        linked_id,
                        node_by_id,
                        edges_by_from,
                        linkage,
                        visited,
                        order,
                    );
                }
            }
        }
        order.push(node.id.clone());
    }
    collect(
        root_id,
        &node_by_id,
        &edges_by_from,
        &linkage,
        &mut visited,
        &mut order,
    );
    order
}

fn manifest_graph_resolve_package_groups_impl(
    input: ManifestGraphInput,
) -> Result<serde_json::Value, HelperError> {
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
        return Ok(serde_json::json!({
            "status": "needFetch",
            "requests": requests.into_values().collect::<Vec<_>>(),
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
    let compiler_order = manifest_graph_compiler_order(&root_id, &nodes, &active_edges);
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
        root_package_name: root_id.clone(),
        root_move_toml,
        modes: input.modes,
        packages: validate_packages,
    };
    let graph = LockfileV4ValidatedGraph {
        root_id,
        lockfile_order: lockfile_order.clone(),
        packages: validated_packages,
        edges: active_edges,
    };
    let groups = lockfile_v4_package_groups_from_validated_with_orders(
        &validate_input,
        graph,
        &compiler_order,
        &lockfile_order,
    )?;

    Ok(serde_json::json!({
        "status": "ok",
        "rootFiles": groups.root_files,
        "dependencies": groups.dependencies,
        "lockfileDependencies": groups.lockfile_dependencies,
    }))
}

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

    match lockfile_v4_package_groups_from_validated(&input, graph) {
        Ok(groups) => serde_json::json!({
            "status": "ok",
            "rootFiles": groups.root_files,
            "dependencies": groups.dependencies,
            "lockfileDependencies": groups.lockfile_dependencies,
        })
        .to_string(),
        Err(error) => lockfile_v4_error(error),
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CompileIntent {
    Dump,
    Publish,
    Upgrade,
}

impl Default for CompileIntent {
    fn default() -> Self {
        Self::Dump
    }
}

impl CompileIntent {
    fn root_as_zero(self) -> bool {
        matches!(self, Self::Dump | Self::Upgrade)
    }
}

#[derive(Deserialize, Default)]
struct WasmCompileOptions {
    #[serde(default, rename = "silenceWarnings")]
    silence_warnings: bool,
    #[serde(default, rename = "withUnpublishedDependencies")]
    with_unpublished_dependencies: bool,
    #[serde(default)]
    modes: Vec<String>,
    #[serde(default, rename = "lintFlag")]
    lint_flag: Option<String>,
    #[serde(default, rename = "ansiColor")]
    ansi_color: bool,
    #[serde(default, rename = "compileIntent")]
    compile_intent: CompileIntent,
}

fn parse_lint_level(lint_flag: Option<&str>) -> Result<LintLevel, String> {
    match lint_flag.unwrap_or("none") {
        "none" => Ok(LintLevel::None),
        "default" => Ok(LintLevel::Default),
        "all" => Ok(LintLevel::All),
        value => Err(format!(
            "Invalid lintFlag '{}'. Expected one of: none, default, all",
            value
        )),
    }
}

struct CompilerBuildConfig {
    silence_warnings: bool,
    lint_level: LintLevel,
    modes: Vec<Symbol>,
}

fn compiler_build_config(
    silence_warnings: bool,
    lint_level: LintLevel,
    modes: Vec<String>,
) -> CompilerBuildConfig {
    CompilerBuildConfig {
        silence_warnings,
        lint_level,
        modes: modes
            .into_iter()
            .map(|mode| Symbol::from(mode.as_str()))
            .collect(),
    }
}

fn compiler_flags_for_build_config(build_config: &CompilerBuildConfig) -> Flags {
    let flags = if build_config
        .modes
        .iter()
        .any(|mode| mode.as_str() == "test")
    {
        Flags::testing()
    } else {
        Flags::empty()
    };

    flags
        .set_warnings_are_errors(false)
        .set_json_errors(false)
        .set_silence_warnings(build_config.silence_warnings)
        .set_modes(build_config.modes.clone())
}

fn configure_compiler_for_sui(compiler: Compiler, build_config: &CompilerBuildConfig) -> Compiler {
    let lint_level = build_config.lint_level;
    let mut compiler = compiler.set_flags(compiler_flags_for_build_config(build_config));

    let (filter_attr_name, filters) = move_compiler::sui_mode::linters::known_filters();
    compiler = compiler
        .add_custom_known_filters(filter_attr_name, filters)
        .add_visitors(move_compiler::sui_mode::linters::linter_visitors(
            lint_level,
        ));

    let (filter_attr_name, filters) = move_compiler::linters::known_filters();
    compiler
        .add_custom_known_filters(filter_attr_name, filters)
        .add_visitors(move_compiler::linters::linter_visitors(lint_level))
}
