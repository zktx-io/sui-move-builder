use base64::{engine::general_purpose, Engine as _};
use move_bytecode_utils::Modules;
use move_compiler::compiled_unit::AnnotatedCompiledModule;
use move_compiler::{linters::LintLevel, Compiler, Flags};
use move_core_types::{account_address::AccountAddress, language_storage::ModuleId};
use move_symbol_pool::Symbol;
use serde::Deserialize;
use std::collections::BTreeMap;
use sui_protocol_config::{Chain, ProtocolConfig, ProtocolVersion};
use sui_types::move_package::{FnInfo, FnInfoKey, FnInfoMap};
use sui_verifier::verifier as sui_bytecode_verifier;
use vfs::{impls::memory::MemoryFS, VfsPath};

use crate::package_model::{build_compiler_input, CompilerInput, CompilerInputMode, PackageGroup};
use crate::{CompileResult, WasmCompilationOutput};

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

pub(crate) fn setup_vfs(
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

pub(crate) struct CompilerBuildConfig {
    silence_warnings: bool,
    lint_level: LintLevel,
    modes: Vec<Symbol>,
}

pub(crate) fn compiler_build_config(
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

pub(crate) fn configure_compiler_for_sui(
    compiler: Compiler,
    build_config: &CompilerBuildConfig,
) -> Compiler {
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

pub(crate) fn compile_impl(
    files_json: &str,
    dependencies_json: &str,
    options_json: Option<String>,
) -> CompileResult {
    console_error_panic_hook::set_once();

    let options: WasmCompileOptions = match options_json {
        Some(json) => match serde_json::from_str(&json) {
            Ok(options) => options,
            Err(error) => {
                return CompileResult {
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
            return CompileResult {
                success: false,
                output: error,
            }
        }
    };

    let (root, files, dep_packages) = match setup_vfs(files_json, dependencies_json) {
        Ok(res) => res,
        Err(e) => {
            return CompileResult {
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
            return CompileResult {
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
            return CompileResult {
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
            return CompileResult {
                success: false,
                output: format!("Compiler initialization error: {}", e),
            }
        }
    };

    match res {
        Ok((units, warning_diags)) => {
            let fn_info = fn_info(&units);
            if let Err(e) = verify_bytecode(&units, &fn_info, false) {
                return CompileResult {
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
                    return CompileResult {
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

            CompileResult {
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
            CompileResult {
                success: false,
                output: String::from_utf8_lossy(&error_buffer).to_string(),
            }
        }
    }
}
