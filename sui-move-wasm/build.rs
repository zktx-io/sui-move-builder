use std::{fs, path::PathBuf};

const SYSTEM_GIT_REPO: &str = "https://github.com/MystenLabs/sui.git";
const SYSTEM_STDLIB_ID: &str = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SYSTEM_SUI_ID: &str = "0x0000000000000000000000000000000000000000000000000000000000000002";
const SYSTEM_SUI_SYSTEM_ID: &str =
    "0x0000000000000000000000000000000000000000000000000000000000000003";
const SYSTEM_BRIDGE_ID: &str = "0x000000000000000000000000000000000000000000000000000000000000000b";
const SYSTEM_STDLIB_SUBDIR: &str = "crates/sui-framework/packages/move-stdlib";
const SYSTEM_SUI_SUBDIR: &str = "crates/sui-framework/packages/sui-framework";
const SYSTEM_SUI_SYSTEM_SUBDIR: &str = "crates/sui-framework/packages/sui-system";
const SYSTEM_BRIDGE_SUBDIR: &str = "crates/sui-framework/packages/bridge";

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

fn workspace_package_version(toml_contents: &str) -> Option<String> {
    let mut in_workspace_package = false;
    for line in toml_contents.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_workspace_package = trimmed == "[workspace.package]";
            continue;
        }
        if in_workspace_package && trimmed.starts_with("version = \"") {
            let mut parts = trimmed.split('"');
            parts.next();
            if let Some(version) = parts.next() {
                return Some(version.to_string());
            }
        }
    }
    None
}

fn framework_snapshot_manifest_path(manifest_dir: &std::path::Path) -> Option<PathBuf> {
    for ancestor in manifest_dir.ancestors() {
        for candidate in [
            ancestor.join("crates/sui-framework-snapshot/manifest.json"),
            ancestor.join("source/crates/sui-framework-snapshot/manifest.json"),
            ancestor.join(".sui-build/source/crates/sui-framework-snapshot/manifest.json"),
        ] {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn emit_system_package_subdir(name: &str, path: &str) -> bool {
    match name {
        "MoveStdlib" => {
            println!("cargo:rustc-env=SUI_SYSTEM_STDLIB_SUBDIR={}", path);
            true
        }
        "Sui" => {
            println!("cargo:rustc-env=SUI_SYSTEM_SUI_SUBDIR={}", path);
            true
        }
        "SuiSystem" => {
            println!("cargo:rustc-env=SUI_SYSTEM_SUI_SYSTEM_SUBDIR={}", path);
            true
        }
        "Bridge" => {
            println!("cargo:rustc-env=SUI_SYSTEM_BRIDGE_SUBDIR={}", path);
            true
        }
        _ => false,
    }
}

fn normalize_package_id(value: &str) -> Option<String> {
    let trimmed = value.trim().to_ascii_lowercase();
    let hex = trimmed.strip_prefix("0x").unwrap_or(trimmed.as_str());
    if hex.is_empty() || hex.len() > 64 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("0x{:0>64}", hex))
}

fn emit_system_package_id_subdir(package_id: &str) -> bool {
    let Some(package_id) = normalize_package_id(package_id) else {
        return false;
    };
    match package_id.as_str() {
        SYSTEM_STDLIB_ID => {
            println!(
                "cargo:rustc-env=SUI_SYSTEM_STDLIB_SUBDIR={}",
                SYSTEM_STDLIB_SUBDIR
            );
            true
        }
        SYSTEM_SUI_ID => {
            println!(
                "cargo:rustc-env=SUI_SYSTEM_SUI_SUBDIR={}",
                SYSTEM_SUI_SUBDIR
            );
            true
        }
        SYSTEM_SUI_SYSTEM_ID => {
            println!(
                "cargo:rustc-env=SUI_SYSTEM_SUI_SYSTEM_SUBDIR={}",
                SYSTEM_SUI_SYSTEM_SUBDIR
            );
            true
        }
        SYSTEM_BRIDGE_ID => {
            println!(
                "cargo:rustc-env=SUI_SYSTEM_BRIDGE_SUBDIR={}",
                SYSTEM_BRIDGE_SUBDIR
            );
            true
        }
        _ => false,
    }
}

fn emit_system_package_snapshot(manifest_dir: &std::path::Path) {
    let Some(path) = framework_snapshot_manifest_path(manifest_dir) else {
        println!(
            "cargo:warning=sui-move-wasm could not find crates/sui-framework-snapshot/manifest.json"
        );
        return;
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        println!(
            "cargo:warning=sui-move-wasm could not read {}",
            path.to_string_lossy()
        );
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        println!(
            "cargo:warning=sui-move-wasm could not parse {}",
            path.to_string_lossy()
        );
        return;
    };
    let Some(entries) = value.as_object() else {
        return;
    };
    let Some((_, latest)) = entries
        .iter()
        .filter_map(|(key, value)| key.parse::<u64>().ok().map(|version| (version, value)))
        .max_by_key(|(version, _)| *version)
    else {
        return;
    };
    let Some(rev) = latest.get("git_revision").and_then(|value| value.as_str()) else {
        return;
    };

    println!(
        "cargo:rustc-env=SUI_SYSTEM_PACKAGE_REPO={}",
        SYSTEM_GIT_REPO
    );
    println!("cargo:rustc-env=SUI_SYSTEM_PACKAGE_REV={}", rev);

    let mut emitted_package_count = 0;
    if let Some(packages) = latest.get("packages").and_then(|value| value.as_array()) {
        for package in packages {
            let name = package.get("name").and_then(|value| value.as_str());
            let path = package.get("path").and_then(|value| value.as_str());
            if let (Some(name), Some(path)) = (name, path) {
                if emit_system_package_subdir(name, path) {
                    emitted_package_count += 1;
                }
            }
        }
    } else if let Some(package_ids) = latest.get("package_ids").and_then(|value| value.as_array()) {
        for package_id in package_ids {
            let Some(package_id) = package_id.as_str() else {
                continue;
            };
            if emit_system_package_id_subdir(package_id) {
                emitted_package_count += 1;
            }
        }
    }
    if emitted_package_count == 0 {
        println!(
            "cargo:warning=sui-move-wasm found framework snapshot {}, but it did not expose supported system package entries",
            path.to_string_lossy()
        );
    }
    println!("cargo:rerun-if-changed={}", path.to_string_lossy());
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    emit_system_package_snapshot(&manifest_dir);
    let repo_root = manifest_dir.join("../..");
    let lock_path = repo_root.join("Cargo.lock");
    if let Ok(lock_contents) = fs::read_to_string(&lock_path) {
        if let Some(version) = package_version_from_lock(&lock_contents, "sui-move") {
            println!("cargo:rustc-env=SUI_MOVE_VERSION={}", version);
        }
        if let Some(version) = package_version_from_lock(&lock_contents, "sui") {
            println!("cargo:rustc-env=SUI_VERSION={}", version);
        }
    } else {
        let toml_path = repo_root.join("Cargo.toml");
        if let Ok(toml_contents) = fs::read_to_string(&toml_path) {
            if let Some(version) = workspace_package_version(&toml_contents) {
                println!("cargo:rustc-env=SUI_MOVE_VERSION={}", version);
                println!("cargo:rustc-env=SUI_VERSION={}", version);
            }
        }
    }
}
