use blake2::digest::{Update, VariableOutput};
use blake2::Blake2bVar;
use move_compiler::{Compiler, editions::{Flavor, Edition}, shared::{NumericalAddress, PackageConfig, PackagePaths}};
use move_core_types::account_address::AccountAddress;
use std::collections::BTreeMap;
use vfs::{impls::memory::MemoryFS, VfsPath};
use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use base64::{Engine as _, engine::general_purpose};
use move_symbol_pool::Symbol;

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
pub fn sui_move_version() -> String {
    if let Some(version) = option_env!("SUI_MOVE_VERSION") {
        return version.to_string();
    }
    let lock_contents = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock"));
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
    let lock_contents = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock"));
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
        _ => {
            eprintln!("Warning: Unknown edition '{}', defaulting to legacy", edition_str);
            Edition::LEGACY
        }
    }
}

fn compile_impl(
    files_json: &str,
    dependencies_json: &str, // Package-grouped dependencies
    ansi_color: bool,
) -> MoveCompilerResult {
    #[cfg(debug_assertions)]
    console_error_panic_hook::set_once();

    // Parse root package files
    let files: BTreeMap<String, String> = match serde_json::from_str(files_json) {
        Ok(f) => f,
        Err(e) => return MoveCompilerResult {
            success: false,
            output: format!("Failed to parse files JSON: {}", e),
        },
    };

    // Parse dependency package groups
    let dep_packages: Vec<PackageGroup> = if dependencies_json.is_empty() {
        vec![]
    } else {
        match serde_json::from_str(dependencies_json) {
            Ok(p) => p,
            Err(e) => return MoveCompilerResult {
                success: false,
                output: format!("Failed to parse dependencies JSON: {}", e),
            },
        }
    };

    // Setup MemoryFS
    let fs = MemoryFS::new();
    let root = VfsPath::new(fs);

    // Helper to ensure parent directories exist
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

    // Write all files to VFS
    for (name, content) in &files {
        let path = match root.join(name) {
            Ok(p) => p,
            Err(e) => return MoveCompilerResult {
                success: false,
                output: format!("Invalid path {}: {}", name, e),
            },
        };

        if let Err(e) = ensure_parents(&path) {
            return MoveCompilerResult {
                success: false,
                output: format!("Failed to create directories for {}: {}", name, e),
            };
        }

        if let Err(e) = path.create_file().and_then(|mut f| {
            use std::io::Write;
            write!(f, "{}", content)?;
            Ok(())
        }) {
            return MoveCompilerResult {
                success: false,
                output: format!("Failed to create file {}: {}", name, e),
            };
        }
    }

    // Write dependency files to VFS
    for pkg in &dep_packages {
        for (name, content) in &pkg.files {
            let path = match root.join(name) {
                Ok(p) => p,
                Err(e) => return MoveCompilerResult {
                    success: false,
                    output: format!("Invalid dep path {}: {}", name, e),
                },
            };

            if let Err(e) = ensure_parents(&path) {
                return MoveCompilerResult {
                    success: false,
                    output: format!("Failed to create directories for dep {}: {}", name, e),
                };
            }

            if let Err(e) = path.create_file().and_then(|mut f| {
                use std::io::Write;
                write!(f, "{}", content)?;
                Ok(())
            }) {
                return MoveCompilerResult {
                    success: false,
                    output: format!("Failed to create dep file {}: {}", name, e),
                };
            }
        }
    }

    // Build PackagePaths for targets (root package)
    let mut root_named_address_map = BTreeMap::<String, NumericalAddress>::new();
    let mut root_edition = Edition::LEGACY;
    let mut root_published_at: Option<[u8; 32]> = None;

    if let Some(move_toml_content) = files.get("Move.toml") {
        if let Ok(toml_data) = toml::from_str::<MoveToml>(move_toml_content) {
            if let Some(ref pkg) = toml_data.package {
                if let Some(ref edition_str) = pkg.edition {
                    root_edition = parse_edition(edition_str);
                    eprintln!("📋 Root package edition: {} -> {:?}", edition_str, root_edition);
                }
                if let Some(ref published_at) = pkg.published_at {
                    root_published_at = parse_hex_address_to_bytes(published_at);
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

    let root_targets: Vec<Symbol> = files
        .keys()
        .filter(|name| !name.ends_with("Move.toml") && name.ends_with(".move"))
        .map(|s| Symbol::from(s.as_str()))
        .collect();

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

    // Build PackagePaths for dependencies
    let mut dep_package_paths = Vec::new();
    // Use Vec instead of BTreeSet to preserve insertion order (matches Sui CLI behavior)
    let mut dependency_ids: Vec<[u8; 32]> = Vec::new();

    for pkg_group in &dep_packages {
        let mut named_address_map = BTreeMap::<String, NumericalAddress>::new();
        let mut edition = Edition::LEGACY;
        let mut published_at: Option<[u8; 32]> = None;

        // Find Move.toml in this package
        let toml_key = pkg_group.files.keys()
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
                    // Use PackageGroup's name to look up the address
                    if let Some(addr_str) = toml_data.addresses.get(&pkg_group.name) {
                        // Skip 0x0 addresses
                        if addr_str != "0x0" && !addr_str.trim_start_matches("0x").chars().all(|c| c == '0') {
                            if let Some(bytes) = parse_hex_address_to_bytes(addr_str) {
                                if !dependency_ids.contains(&bytes) {
                                    eprintln!("📦 [{}] Using [addresses].{} = {}", pkg_group.name, pkg_group.name, addr_str);
                                    dependency_ids.push(bytes);
                                    found_address_id = true;
                                }
                            }
                        }
                    }

                    // Fallback to published-at if no valid address found in [addresses]
                    if !found_address_id {
                        if let Some(bytes) = published_at {
                            if !dependency_ids.contains(&bytes) {
                                if let Some(ref pkg) = toml_data.package {
                                    if let Some(ref pa) = pkg.published_at {
                                        eprintln!("📦 [{}] Using published-at = {}", pkg_group.name, pa);
                                    }
                                }
                                dependency_ids.push(bytes);
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

        // Use explicitly provided edition if available
        if let Some(ref edition_str) = pkg_group.edition {
            edition = parse_edition(edition_str);
            eprintln!("📋 Dependency '{}' override edition: {} -> {:?}", pkg_group.name, edition_str, edition);
        }

        let dep_files: Vec<Symbol> = pkg_group.files
            .keys()
            .filter(|name| !name.ends_with("Move.toml") && name.ends_with(".move"))
            .map(|s| Symbol::from(s.as_str()))
            .collect();

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

    // Build compiler with from_package_paths
    let compiler = match Compiler::from_package_paths(
        Some(root),
        vec![target_package],
        dep_package_paths,
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
            let mut modules = vec![];
            let mut module_bytes = vec![];

            for unit in units {
                let bytes = unit.named_module.serialize();
                module_bytes.push(bytes.clone());
                modules.push(general_purpose::STANDARD.encode(&bytes));
            }

            // Add root package's published-at if exists
            if let Some(bytes) = root_published_at {
                if !dependency_ids.contains(&bytes) {
                    dependency_ids.push(bytes);
                }
            }

            // dependency_ids is already a Vec, no need to convert
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
    compile_impl(files_json, dependencies_json, false)
}

#[wasm_bindgen]
pub fn compile_with_color(
    files_json: &str,
    dependencies_json: &str,
    ansi_color: bool,
) -> MoveCompilerResult {
    compile_impl(files_json, dependencies_json, ansi_color)
}
