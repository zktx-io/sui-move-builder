use std::{fs, path::PathBuf};

const SYSTEM_GIT_REPO: &str = "https://github.com/MystenLabs/sui.git";

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
    let Some(packages) = latest.get("packages").and_then(|value| value.as_array()) else {
        return;
    };

    println!(
        "cargo:rustc-env=SUI_SYSTEM_PACKAGE_REPO={}",
        SYSTEM_GIT_REPO
    );
    println!("cargo:rustc-env=SUI_SYSTEM_PACKAGE_REV={}", rev);
    for package in packages {
        let name = package.get("name").and_then(|value| value.as_str());
        let path = package.get("path").and_then(|value| value.as_str());
        match (name, path) {
            (Some("MoveStdlib"), Some(path)) => {
                println!("cargo:rustc-env=SUI_SYSTEM_STDLIB_SUBDIR={}", path);
            }
            (Some("Sui"), Some(path)) => {
                println!("cargo:rustc-env=SUI_SYSTEM_SUI_SUBDIR={}", path);
            }
            (Some("SuiSystem"), Some(path)) => {
                println!("cargo:rustc-env=SUI_SYSTEM_SUI_SYSTEM_SUBDIR={}", path);
            }
            (Some("Bridge"), Some(path)) => {
                println!("cargo:rustc-env=SUI_SYSTEM_BRIDGE_SUBDIR={}", path);
            }
            _ => {}
        }
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
