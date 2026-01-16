use base64::{Engine as _, engine::general_purpose};
use blake2::digest::{Update, VariableOutput};
use blake2::Blake2bVar;
use move_bytecode_utils::Modules;
use move_compiler::{Compiler, editions::{Flavor, Edition}, shared::{NumericalAddress, PackageConfig, PackagePaths}, diagnostics::report_diagnostics_to_buffer};
use move_core_types::{account_address::AccountAddress, language_storage::ModuleId};
use move_symbol_pool::Symbol;
use move_unit_test::{UnitTestingConfig, extensions::set_extension_hook};
use move_vm_runtime::native_extensions::NativeContextExtensions;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::Arc;
use sui_protocol_config::ProtocolConfig;
use sui_types::{
    base_types::{SuiAddress, TxContext},
    digests::TransactionDigest,
    gas_model::tables::initial_cost_schedule_for_unit_tests,
    in_memory_storage::InMemoryStorage,
    metrics::LimitsMetrics,
};
use vfs::{impls::memory::MemoryFS, VfsPath};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct MoveCompilerResult {
    success: bool,
    output: String, // JSON string of compiled units or errors
}

#[wasm_bindgen]
impl MoveCompilerResult {
    #[wasm_bindgen(getter)]
    pub fn success(&self) -> bool {
        self.success
    }

    #[wasm_bindgen(getter)]
    pub fn output(&self) -> String {
        self.output.clone()
    }
}

#[derive(Serialize)]
pub struct CompilationOutput {
    modules: Vec<String>, // Base64 encoded bytecode
    dependencies: Vec<String>, // Hex encoded dependency IDs
    digest: Vec<u8>, // Blake2b-256 package digest
}

#[derive(Deserialize)]
struct MoveToml {
    #[serde(default)]
    addresses: BTreeMap<String, String>,
    #[serde(default)]
    package: Option<MoveTomlPackage>,
}

#[derive(Deserialize)]
struct MoveTomlPackage {
    #[serde(rename = "published-at")]
    published_at: Option<String>,
    #[serde(default)]
    edition: Option<String>,
}

// New structure for package-grouped dependencies
#[derive(Deserialize)]
struct PackageGroup {
    name: String,
    files: BTreeMap<String, String>,
    #[serde(default)]
    edition: Option<String>,
    #[serde(default)]
    addressMapping: Option<BTreeMap<String, String>>,
    #[serde(default)]
    publishedIdForOutput: Option<String>,
}

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
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
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

fn parse_hex_address_to_bytes(addr: &str) -> Option<[u8; 32]> {
    let addr_clean = addr.trim().trim_start_matches("0x");
    if addr_clean.is_empty() {
        return None;
    }
    let addr_str_normalized = if addr_clean.len() % 2 != 0 {
        format!("0{}", addr_clean)
    } else {
        addr_clean.to_string()
    };
    let bytes = hex::decode(addr_str_normalized).ok()?;
    if bytes.len() > 32 {
        return None;
    }
    let mut addr_bytes = [0u8; 32];
    let start = 32 - bytes.len();
    addr_bytes[start..].copy_from_slice(&bytes);
    Some(addr_bytes)
}

fn blake2b256(input: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2bVar::new(32).expect("blake2b-256 should be supported");
    hasher.update(input);
    let mut out = [0u8; 32];
    hasher
        .finalize_variable(&mut out)
        .expect("blake2b-256 output length is fixed");
    out
}

fn parse_edition(edition_str: &str) -> Edition {
    match edition_str {
        "legacy" => Edition::LEGACY,
        "2024" | "2024.alpha" => Edition::E2024_ALPHA,
        "2024.beta" => Edition::E2024_BETA,
        _ => Edition::LEGACY,
    }
}

#[wasm_bindgen]
pub struct MoveTestResult {
    passed: bool,
    output: String,
}

#[wasm_bindgen]
impl MoveTestResult {
    #[wasm_bindgen(getter)]
    pub fn passed(&self) -> bool {
        self.passed
    }

    #[wasm_bindgen(getter)]
    pub fn output(&self) -> String {
        self.output.clone()
    }
}

// Create a separate test store per-thread (though Wasm is usually single-threaded).
thread_local! {
    static TEST_STORE_INNER: RefCell<InMemoryStorage> = RefCell::new(InMemoryStorage::default());
}

static TEST_STORE: Lazy<sui_move_natives::test_scenario::InMemoryTestStore> = Lazy::new(|| {
    sui_move_natives::test_scenario::InMemoryTestStore(&TEST_STORE_INNER)
});

static SET_EXTENSION_HOOK: Lazy<()> =
    Lazy::new(|| set_extension_hook(Box::new(new_testing_object_and_natives_cost_runtime)));

fn new_testing_object_and_natives_cost_runtime(ext: &mut NativeContextExtensions) {
    let registry = prometheus::Registry::new();
    let metrics = Arc::new(LimitsMetrics::new(&registry));
    let store = Lazy::force(&TEST_STORE);
    let protocol_config = ProtocolConfig::get_for_max_version_UNSAFE();

    ext.add(sui_move_natives::object_runtime::ObjectRuntime::new(
        store,
        BTreeMap::new(),
        false,
        Box::leak(Box::new(ProtocolConfig::get_for_max_version_UNSAFE())),
        metrics,
        0,
    ));
    ext.add(sui_move_natives::NativesCostTable::from_protocol_config(&protocol_config));
    let tx_context = TxContext::new_from_components(
        &SuiAddress::ZERO,
        &TransactionDigest::default(),
        &0,
        0,
        0,
        0,
        0,
        None,
        &protocol_config,
    );
    ext.add(sui_move_natives::transaction_context::TransactionContext::new_for_testing(Rc::new(RefCell::new(
        tx_context,
    ))));
    ext.add(store);
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
            if curr_path.as_str() == "/" { break; }
            let next = curr_path.parent();
            if next.as_str() == curr_path.as_str() { break; }
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
        let path = root.join(name).map_err(|e| format!("Invalid path {}: {}", name, e))?;
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
            let path = root.join(name).map_err(|e| format!("Invalid dep path {}: {}", name, e))?;
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
) -> MoveCompilerResult {
    #[cfg(debug_assertions)]
    #[cfg(debug_assertions)]
    console_error_panic_hook::set_once();


    // START ANSI SUPPORT
    colored::control::set_override(true);
    let ansi_color = true;
    // END ANSI SUPPORT

    let (root, files, dep_packages) = match setup_vfs(files_json, dependencies_json) {
        Ok(res) => res,
        Err(e) => return MoveCompilerResult { success: false, output: e },
    };

    // Build PackagePaths for targets (root package)
    let mut root_named_address_map = BTreeMap::<String, NumericalAddress>::new();
    let mut root_edition = Edition::LEGACY;
    let mut _root_published_at: Option<[u8; 32]> = None;

    if let Some(move_toml_content) = files.get("Move.toml") {
        if let Ok(toml_data) = toml::from_str::<MoveToml>(move_toml_content) {
            if let Some(ref pkg) = toml_data.package {
                if let Some(ref edition_str) = pkg.edition {
                    root_edition = parse_edition(edition_str);
                }
                if let Some(ref published_at) = pkg.published_at {
                    _root_published_at = parse_hex_address_to_bytes(published_at);
                }
            }

            for (name, addr_str) in toml_data.addresses {
                let addr_str_clean = addr_str.trim_start_matches("0x");
                let addr_str_normalized = if addr_str_clean.len() % 2 != 0 {
                    format!("0{}", addr_str_clean)
                } else {
                    addr_str_clean.to_string()
                };

                if let Ok(bytes) = hex::decode(&addr_str_normalized) {
                    if bytes.len() <= 32 {
                        let mut addr_bytes = [0u8; 32];
                        let start = 32 - bytes.len();
                        addr_bytes[start..].copy_from_slice(&bytes);
                        root_named_address_map.insert(
                            name.clone(),
                            NumericalAddress::new(addr_bytes, move_compiler::shared::NumberFormat::Hex)
                        );
                    }
                }
            }
        }
    }

    let mut root_targets: Vec<Symbol> = files
        .keys()
        .filter(|name| !name.ends_with("Move.toml") && name.ends_with(".move"))
        .map(|s| Symbol::from(s.as_str()))
        .collect();
    // Sort to mimic CLI: sources/* before tests/*, then lexical.
    root_targets.sort_by(|a, b| {
        let pa = a.as_str();
        let pb = b.as_str();
        let wa = pa.starts_with("tests/") as u8;
        let wb = pb.starts_with("tests/") as u8;
        (wa, pa.as_bytes()).cmp(&(wb, pb.as_bytes()))
    });
    log(&format!(
        "ROOT_INPUT: {:?}",
        root_targets
            .iter()
            .map(|s| s.as_str().to_string())
            .collect::<Vec<_>>()
    ));


    // Build PackagePaths for dependencies
    let mut dep_package_paths = Vec::new();
    // Use Vec instead of BTreeSet to preserve insertion order (matches Sui CLI behavior)
    let mut dependency_ids: Vec<[u8; 32]> = Vec::new();

    for pkg_group in &dep_packages {
        let mut named_address_map = BTreeMap::<String, NumericalAddress>::new();
        let mut edition = Edition::LEGACY;
        let mut published_at: Option<[u8; 32]> = None;
        let mut fallback_dep_id: Option<[u8; 32]> = None;

        // Dependency ID for output prefers latest-published-id.
        let mut dep_id_for_output = pkg_group
            .publishedIdForOutput
            .as_ref()
            .and_then(|id| parse_hex_address_to_bytes(id));

        // Prefer address mapping supplied from JS to avoid extra parsing work in WASM.
        if let Some(ref addr_map) = pkg_group.addressMapping {
            for (name, addr_str) in addr_map {
                if let Some(bytes) = parse_hex_address_to_bytes(addr_str) {
                    named_address_map.insert(
                        name.clone(),
                        NumericalAddress::new(bytes, move_compiler::shared::NumberFormat::Hex)
                    );
                    if name == &pkg_group.name && fallback_dep_id.is_none() {
                        fallback_dep_id = Some(bytes);
                    }
                }
            }
        } else {
            // Fallback: parse Move.toml if mapping not provided
            let toml_key = pkg_group
                .files
                .keys()
                .find(|k| k.ends_with("Move.toml"))
                .cloned();

            if let Some(toml_key) = toml_key {
                if let Some(move_toml_content) = pkg_group.files.get(&toml_key) {
                    if let Ok(toml_data) = toml::from_str::<MoveToml>(move_toml_content) {
                        if let Some(ref pkg) = toml_data.package {
                            if let Some(ref edition_str) = pkg.edition {
                                edition = parse_edition(edition_str);
                            }
                            if let Some(ref pa) = pkg.published_at {
                                published_at = parse_hex_address_to_bytes(pa);
                            }
                        }

                        // Check [addresses] section for package's own address (priority over published-at)
                        let mut found_address_id = false;
                        if let Some(addr_str) = toml_data.addresses.get(&pkg_group.name) {
                            if addr_str != "0x0"
                                && !addr_str.trim_start_matches("0x").chars().all(|c| c == '0')
                            {
                                if let Some(bytes) = parse_hex_address_to_bytes(addr_str) {
                                    if fallback_dep_id.is_none() {
                                        fallback_dep_id = Some(bytes);
                                        found_address_id = true;
                                    }
                                }
                            }
                        }

                        if !found_address_id {
                            if let Some(bytes) = published_at {
                                if fallback_dep_id.is_none() {
                                    fallback_dep_id = Some(bytes);
                                }
                            }
                        }

                        for (name, addr_str) in toml_data.addresses {
                            let addr_str_clean = addr_str.trim_start_matches("0x");
                            let addr_str_normalized = if addr_str_clean.len() % 2 != 0 {
                                format!("0{}", addr_str_clean)
                            } else {
                                addr_str_clean.to_string()
                            };

                            if let Ok(bytes) = hex::decode(&addr_str_normalized) {
                                if bytes.len() <= 32 {
                                    let mut addr_bytes = [0u8; 32];
                                    let start = 32 - bytes.len();
                                    addr_bytes[start..].copy_from_slice(&bytes);
                                    named_address_map.insert(
                                        name.clone(),
                                        NumericalAddress::new(addr_bytes, move_compiler::shared::NumberFormat::Hex)
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        // Use explicitly provided edition if available
        if let Some(ref edition_str) = pkg_group.edition {
            edition = parse_edition(edition_str);
        }

        let dep_files: Vec<Symbol> = pkg_group.files
            .keys()
            .filter(|name| !name.ends_with("Move.toml") && name.ends_with(".move"))
            .map(|s| Symbol::from(s.as_str()))
            .collect();
        let mut dep_files_sorted = dep_files.clone();
        // Sort with package-prefixed key; put tests/ after sources/ lexically.
        dep_files_sorted.sort_by(|a, b| {
            let pa = a.as_str();
            let pb = b.as_str();
            let wa = pa.starts_with("tests/") as u8;
            let wb = pb.starts_with("tests/") as u8;
            (wa, pa.as_bytes()).cmp(&(wb, pb.as_bytes()))
        });
        // Priority: publishedIdForOutput > addressMapping/Move.toml derived address
        if dep_id_for_output.is_none() {
            dep_id_for_output = fallback_dep_id;
        }
        if let Some(bytes) = dep_id_for_output {
            if !dependency_ids.contains(&bytes) {
                dependency_ids.push(bytes);
            }
        }

        // Merge dependency addresses into root map (MATCHES TEST_IMPL)
        for (name, addr) in &named_address_map {
             if !root_named_address_map.contains_key(name) {
                 root_named_address_map.insert(name.clone(), *addr);
             }
        }

        dep_package_paths.push(PackagePaths {
            name: Some((
                Symbol::from(pkg_group.name.as_str()),
                PackageConfig {
                    is_dependency: true,
                    edition,
                    flavor: Flavor::Sui,
                    ..PackageConfig::default()
                },
            )),
            paths: dep_files,
            named_address_map,
        });
    }

    // FALLBACK: Ensure std and sui are always defined
    if !root_named_address_map.contains_key("std") {
        if let Some(bytes) = parse_hex_address_to_bytes("0x1") {
            root_named_address_map.insert("std".to_string(), NumericalAddress::new(bytes, move_compiler::shared::NumberFormat::Hex));
        }
    }
    if !root_named_address_map.contains_key("sui") {
        if let Some(bytes) = parse_hex_address_to_bytes("0x2") {
            root_named_address_map.insert("sui".to_string(), NumericalAddress::new(bytes, move_compiler::shared::NumberFormat::Hex));
        }
    }

    log(&format!("Rust: root address map keys: {:?}", root_named_address_map.keys()));

    let target_package = PackagePaths {
        name: Some((
            Symbol::from("root"),
            PackageConfig {
                is_dependency: false,
                edition: root_edition,
                flavor: Flavor::Sui,
                ..PackageConfig::default()
            },
        )),
        paths: root_targets,
        named_address_map: root_named_address_map,
    };

    let mut all_targets = vec![target_package];
    // Force is_dependency=false for all deps to ensure full compilation visibility
    for mut dep in dep_package_paths {
        if let Some((_name, config)) = &mut dep.name {
             config.is_dependency = false;
        }
        all_targets.push(dep);
    }

    // Build compiler with from_package_paths
    // PATCHED: Treat all dependencies as targets (2nd arg) to ensures they are compiled/linked.
    // Address merging ensures they are resolved correctly.
    // Build compiler with from_package_paths
    // PATCHED: Treat all dependencies as targets (2nd arg) to ensures they are compiled/linked.
    // Address merging ensures they are resolved correctly.
    let compiler = match Compiler::from_package_paths(
        Some(root),
        all_targets,
        Vec::new(),
    ) {
        Ok(c) => c,
        Err(e) => return MoveCompilerResult {
            success: false,
            output: format!("Failed to create compiler: {}", e),
        },
    };

    let (files, res) = match compiler.build() {
        Ok(res) => res,
        Err(e) => return MoveCompilerResult {
            success: false,
            output: format!("Compiler initialization error: {}", e),
        },
    };

    match res {
        Ok((units, _warnings)) => {
            // Build module list with IDs
            let mut module_infos: Vec<(ModuleId, move_compiler::compiled_unit::NamedCompiledModule)> =
                Vec::new();
            for unit in units {
                let id = unit.named_module.module.self_id();
                module_infos.push((id, unit.named_module));
            }

            let fmt_id = |id: &ModuleId| {
                format!(
                    "{}::{}",
                    id.address().to_canonical_string(true),
                    id.name()
                )
            };

            // Use Move utility to mirror CLI dependency ordering.
            let module_set = Modules::new(module_infos.iter().map(|(_, m)| &m.module));
            let ordered_ids: Vec<ModuleId> = match module_set.compute_topological_order() {
                Ok(iter) => iter.map(|m| m.self_id()).collect(),
                Err(e) => {
                    return MoveCompilerResult {
                        success: false,
                        output: format!("Failed to compute module ordering: {}", e),
                    }
                }
            };

            let mut ordered_modules: Vec<(ModuleId, move_compiler::compiled_unit::NamedCompiledModule)> =
                Vec::new();
            for id in ordered_ids {
                if let Some((_, module)) = module_infos.iter().find(|(mid, _)| *mid == id).cloned() {
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
            for (_idx, (id, module)) in module_infos.iter().enumerate() {
                let _id_str = fmt_id(id);
                let mut deps_for_log: Vec<String> = Vec::new();
                for dep in module.module.immediate_dependencies() {
                    let dep_str = fmt_id(&dep);
                    deps_for_log.push(dep_str);
                }
                deps_for_log.sort();
                let bytes = module.serialize();
                module_bytes.push(bytes.clone());
                modules.push(general_purpose::STANDARD.encode(&bytes));
                let _digest = blake2b256(&bytes);
            }

            // Use dependency IDs exactly as provided by JS (package graph order).
            let dependency_ids_vec = dependency_ids;
            let mut components: Vec<Vec<u8>> = vec![];
            for bytes in &module_bytes {
                let digest = blake2b256(bytes);
                components.push(digest.to_vec());
            }
            for dep in &dependency_ids_vec {
                components.push(dep.to_vec());
            }
            components.sort();

            let mut package_hasher = Blake2bVar::new(32).expect("blake2b-256 should be supported");
            for component in components {
                package_hasher.update(&component);
            }
            let mut package_digest = [0u8; 32];
            package_hasher
                .finalize_variable(&mut package_digest)
                .expect("blake2b-256 output length is fixed");

            let output_data = CompilationOutput {
                modules,
                dependencies: dependency_ids_vec
                    .iter()
                    .map(|bytes| AccountAddress::new(*bytes).to_canonical_string(true))
                    .collect(),
                digest: package_digest.to_vec(),
            };

            MoveCompilerResult {
                success: true,
                output: serde_json::to_string(&output_data).unwrap_or_default(),
            }
        }
        Err(diags) => {
            let error_buffer = move_compiler::diagnostics::report_diagnostics_to_buffer(&files, diags, ansi_color);
            MoveCompilerResult {
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
) -> MoveCompilerResult {
    compile_impl(files_json, dependencies_json)
}


fn test_impl(
    files_json: &str,
    dependencies_json: &str,
) -> MoveTestResult {
    #[cfg(debug_assertions)]
    console_error_panic_hook::set_once();
    
    // START ANSI SUPPORT
    colored::control::set_override(true);
    let ansi_color = true;
    // END ANSI SUPPORT
    
    let (root, files, dep_packages) = match setup_vfs(files_json, dependencies_json) {
        Ok(res) => {
            res
        },
        Err(e) => {
            log(&format!("Rust: VFS setup failed: {}", e));
            return MoveTestResult { passed: false, output: e };
        }
    };

    // 1. Build PackagePaths for targets (root package)
    let mut root_named_address_map = BTreeMap::<String, NumericalAddress>::new();
    let mut root_edition = Edition::LEGACY;


    if let Some(move_toml_content) = files.get("Move.toml") {
        if let Ok(toml_data) = toml::from_str::<MoveToml>(move_toml_content) {
            if let Some(ref pkg) = toml_data.package {
                if let Some(ref edition_str) = pkg.edition {
                    root_edition = parse_edition(edition_str);
                }
            }
            for (name, addr_str) in toml_data.addresses {
                if let Some(bytes) = parse_hex_address_to_bytes(&addr_str) {
                    root_named_address_map.insert(
                        name.clone(),
                        NumericalAddress::new(bytes, move_compiler::shared::NumberFormat::Hex)
                    );
                }
            }
        }
    }

    let root_targets: Vec<Symbol> = files
        .keys()
        .filter(|name| !name.ends_with("Move.toml") && name.ends_with(".move"))
        .map(|s| Symbol::from(s.as_str()))
        .collect();


    // 2. Build PackagePaths for dependencies
    let mut dep_package_paths = Vec::new();
    for pkg_group in &dep_packages {
        let mut named_address_map = BTreeMap::<String, NumericalAddress>::new();
        let mut edition = Edition::LEGACY;

        if let Some(ref addr_map) = pkg_group.addressMapping {
            for (name, addr_str) in addr_map {
                if let Some(bytes) = parse_hex_address_to_bytes(addr_str) {
                    named_address_map.insert(
                        name.clone(),
                        NumericalAddress::new(bytes, move_compiler::shared::NumberFormat::Hex)
                    );
                }
            }
        }

        if let Some(ref edition_str) = pkg_group.edition {
            edition = parse_edition(edition_str);
        }

        let dep_files: Vec<Symbol> = pkg_group.files
            .keys()
            .filter(|name| !name.ends_with("Move.toml") && name.ends_with(".move"))
            .map(|s| Symbol::from(s.as_str()))
            .collect();

        // Merge dependency addresses into root map
        for (name, addr) in &named_address_map {
             if !root_named_address_map.contains_key(name) {
                 root_named_address_map.insert(name.clone(), *addr);
             }
        }

        dep_package_paths.push(PackagePaths {
            name: Some((
                Symbol::from(pkg_group.name.as_str()),
                PackageConfig {
                    is_dependency: true,
                    edition,
                    flavor: Flavor::Sui,
                    ..PackageConfig::default()
                },
            )),
            paths: dep_files,
            named_address_map,
        });
    }

    // FALLBACK: Ensure std and sui are always defined
    if !root_named_address_map.contains_key("std") {
        if let Some(bytes) = parse_hex_address_to_bytes("0x1") {
            root_named_address_map.insert("std".to_string(), NumericalAddress::new(bytes, move_compiler::shared::NumberFormat::Hex));
        }
    }
    if !root_named_address_map.contains_key("sui") {
        if let Some(bytes) = parse_hex_address_to_bytes("0x2") {
            root_named_address_map.insert("sui".to_string(), NumericalAddress::new(bytes, move_compiler::shared::NumberFormat::Hex));
        }
    }

    let target_package = PackagePaths {
        name: Some((
            Symbol::from("root"),
            PackageConfig {
                is_dependency: false,
                edition: root_edition,
                flavor: Flavor::Sui,
                ..PackageConfig::default()
            },
        )),
        paths: root_targets,
        named_address_map: root_named_address_map,
    };

    // PATCHED: Treat all dependencies as targets to ensure their bytecode is emitted.
    // This is necessary for the test runner to find them in the linking phase.
    let mut all_targets = vec![target_package];
    all_targets.extend(dep_package_paths);

    // 3. Construct TestPlan
    // 3. Construct TestPlan
    let compiler = match Compiler::from_package_paths(
        Some(root),
        all_targets,
        Vec::new(),
    ) {
        Ok(c) => {
            c
        },
        Err(e) => {
            log(&format!("Rust: Compiler creation failed: {}", e));
            return MoveTestResult { passed: false, output: format!("Failed to create compiler: {}", e) }
        },
    };


    let flags = move_compiler::Flags::testing();
    let (files_info, comments_and_compiler_res) = match compiler.set_flags(flags).run::<{ move_compiler::PASS_CFGIR }>() {
        Ok(res) => {
             res
        },
        Err(e) => {
             log(&format!("Rust: compiler passes failed: {}", e));
             return MoveTestResult { passed: false, output: format!("Compiler error: {}", e) }
        },
    };

    log("Rust: checking compilation result...");
    let compiler = match comments_and_compiler_res {
        Ok(c) => {
            log("Rust: compilation successful");
            c
        },
        Err((_severity, diags)) => {
            log("Rust: compilation failed diagnostics");
            let buffer = move_compiler::diagnostics::report_diagnostics_to_buffer(&files_info, diags, ansi_color);
            return MoveTestResult { passed: false, output: String::from_utf8_lossy(&buffer).to_string() };
        }
    };

    let (compiler, cfgir) = compiler.into_ast();
    let compilation_env = compiler.compilation_env();
    let mut test_tests = move_compiler::unit_test::plan_builder::construct_test_plan(compilation_env, None, &cfgir);
    
    // PATCHED: Filter out dependency tests. We only want to run tests for the root package.
    // test_tests is Option<Vec<ModuleTestPlan>>
    if let Some(plans) = &mut test_tests {
         plans.retain(|plan| {
             // Heuristic: Filter out frameworks (0x1, 0x2).
             let s = format!("{:?}", plan.module_id.address()); 
             !s.ends_with("0000000000000000000000000000000000000000000000000000000000000001") &&
             !s.ends_with("0000000000000000000000000000000000000000000000000000000000000002")
         });
    }
    let mapped_files = compilation_env.mapped_files().clone();

    // Reconstruct/continue compilation to get units
    let compilation_result = compiler.at_cfgir(cfgir).build();
    let (units, _) = match compilation_result {
        Ok(res) => res,
        Err((_severity, diags)) => {
             let buffer = move_compiler::diagnostics::report_diagnostics_to_buffer(&files_info, diags, ansi_color);
             return MoveTestResult { passed: false, output: String::from_utf8_lossy(&buffer).to_string() };
        }
    };

    let units: Vec<_> = units.into_iter().map(|unit| unit.named_module).collect();

    let test_plan = match test_tests {
        Some(tests) => {
            move_compiler::unit_test::TestPlan::new(tests, mapped_files, units, vec![])
        },
        None => {
            return MoveTestResult { passed: true, output: "No tests found".to_string() }
        },
    };

    // 4. Run tests and capture output
    Lazy::force(&SET_EXTENSION_HOOK);

    let config = UnitTestingConfig {
        num_threads: 1, // Crucial for Wasm
        gas_limit: Some(1_000_000),
        report_stacktrace_on_abort: true,
        ..UnitTestingConfig::default_with_bound(None)
    };

    let natives = sui_move_natives::all_natives(
        false,
        &ProtocolConfig::get_for_max_version_UNSAFE(),
    );

    let mut output_buffer = std::io::Cursor::new(Vec::new());
    let (output_buffer, passed) = match config.run_and_report_unit_tests(
        test_plan,
        Some(natives),
        Some(initial_cost_schedule_for_unit_tests()),
        output_buffer,
    ) {
        Ok(res) => res,
        Err(e) => return MoveTestResult { passed: false, output: format!("Test runner error: {}", e) },
    };

    let output_str = String::from_utf8_lossy(output_buffer.get_ref()).to_string();

    MoveTestResult {
        passed,
        output: output_str,
    }
}

#[wasm_bindgen]
pub fn test(
    files_json: &str,
    dependencies_json: &str,
) -> MoveTestResult {
    test_impl(files_json, dependencies_json)
}
