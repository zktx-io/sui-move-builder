use blake2::digest::{Update, VariableOutput};
use blake2::Blake2bVar;
use move_compiler::{Compiler, editions::Flavor, shared::{NumericalAddress, PackageConfig}};
use move_core_types::account_address::AccountAddress;
use std::collections::BTreeMap;
use vfs::{impls::memory::MemoryFS, VfsPath};
use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use base64::{Engine as _, engine::general_purpose};

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

#[wasm_bindgen]
fn compile_impl(
    files_json: &str,
    dependencies_json: &str, // Optional: dependency content map
    ansi_color: bool,
) -> MoveCompilerResult {
    console_error_panic_hook::set_once();
    let files: BTreeMap<String, String> = match serde_json::from_str(files_json) {
        Ok(f) => f,
        Err(e) => return MoveCompilerResult {
            success: false,
            output: format!("Failed to parse files JSON: {}", e),
        },
    };

    // Parse named addresses from Move.toml if it exists
    let mut named_address_map = BTreeMap::<String, NumericalAddress>::new();
    if let Some(move_toml_content) = files.get("Move.toml") {
        if let Ok(toml_data) = toml::from_str::<MoveToml>(move_toml_content) {
            for (name, addr_str) in toml_data.addresses {
                // Parse hex address
                // Handle 0x prefix
                let addr_str_clean = addr_str.trim_start_matches("0x");
                let addr_str_normalized = if addr_str_clean.len() % 2 != 0 {
                    format!("0{}", addr_str_clean)
                } else {
                    addr_str_clean.to_string()
                };
                let addr_str_lower = addr_str_normalized.to_ascii_lowercase();
                let addr_str_padded = format!("0x{:0>64}", addr_str_lower);
                
                if let Ok(bytes) = hex::decode(&addr_str_normalized) {
                    // NumericalAddress needs [u8; 32] or 16 depending on move version but usually 32 for Sui
                    // Sui uses 32 bytes
                    if bytes.len() <= 32 {
                        let mut addr_bytes = [0u8; 32];
                        let start = 32 - bytes.len();
                        addr_bytes[start..].copy_from_slice(&bytes);
                        named_address_map.insert(name.clone(), NumericalAddress::new(addr_bytes, move_compiler::shared::NumberFormat::Hex));
                    }
                }
            }
        }
    }
    
    // Setup MemoryFS
    let fs = MemoryFS::new();
    let root = VfsPath::new(fs);
    
    // Helper to ensure parent directories exist
    let ensure_parents = |path: &VfsPath| -> Result<(), String> {
        let parent = path.parent();
        let mut ancestors = vec![];
        let mut curr_path = parent;
        
        // Walk up to root collecting paths
        loop {
            ancestors.push(curr_path.clone());
            if curr_path.as_str() == "/" { break; }
            
            let next = curr_path.parent();
            if next.as_str() == curr_path.as_str() { break; }
            curr_path = next;
        }
        
        // Walk down creating directories
        while let Some(p) = ancestors.pop() {
            if !p.exists().map_err(|e| e.to_string())? {
                p.create_dir().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    };

    let mut targets = vec![];
    
    for (name, content) in files {
        if name == "Move.toml" { continue; }

        let path = root.join(&name).map_err(|e| format!("Invalid path {}: {}", name, e));
        let path = match path {
            Ok(p) => p,
            Err(e) => return MoveCompilerResult {
                success: false,
                output: e,
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
        if !name.ends_with("Move.toml") {
             targets.push(name);
        }
    }
    // Dependencies handling
    let mut deps: Vec<String> = vec![];
    let mut dependency_ids = std::collections::BTreeSet::new();
     if !dependencies_json.is_empty() {
        let dep_files: BTreeMap<String, String> = match serde_json::from_str(dependencies_json) {
            Ok(f) => f,
             Err(e) => return MoveCompilerResult {
                success: false,
                output: format!("Failed to parse dependencies JSON: {}", e),
            },
        };
        for (name, content) in dep_files {
             if name.ends_with("Move.toml") {
                 if let Ok(toml_data) = toml::from_str::<MoveToml>(&content) {
                     if let Some(pkg) = toml_data.package {
                         if let Some(published_at) = pkg.published_at {
                             if let Some(bytes) = parse_hex_address_to_bytes(&published_at) {
                                 dependency_ids.insert(bytes);
                             }
                         }
                     }
                 }
             }
             let path = root.join(&name).map_err(|e| format!("Invalid path {}: {}", name, e));
             let path = match path {
                Ok(p) => p,
                Err(e) => return MoveCompilerResult {
                    success: false,
                    output: e,
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
                    success: false, // Treat dep error as failure
                    output: format!("Failed to create dep file {}: {}", name, e),
                };
            }
            if !name.ends_with("Move.toml") {
                deps.push(name);
            }
        }
    }

    let compiler = Compiler::from_files(
        Some(root),
        targets,
        deps,
        named_address_map,
    )
    .set_default_config(PackageConfig {
        flavor: Flavor::Sui,
        ..PackageConfig::default()
    });

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

             let dependency_ids_vec: Vec<[u8; 32]> = dependency_ids.iter().copied().collect();
             let mut components: Vec<Vec<u8>> = vec![];
             for bytes in &module_bytes {
                 let digest = blake2b256(bytes);
                 components.push(digest.to_vec());
             }
             for dep in &dependency_ids_vec {
                 components.push(dep.to_vec());
             }
             components.sort();
             let mut package_hasher =
                 Blake2bVar::new(32).expect("blake2b-256 should be supported");
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
            // Compilation failed
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
