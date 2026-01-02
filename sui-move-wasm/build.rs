use std::{fs, path::PathBuf};

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

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
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
