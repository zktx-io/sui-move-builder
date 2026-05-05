use move_symbol_pool::Symbol;
use std::collections::HashSet;

use super::types::PackageGroup;

pub(crate) fn dependency_name_is_implicit(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "sui" || lower == "std" || lower == "movestdlib"
}

fn package_relative_path<'a>(path: &'a str, package_name: Option<&str>) -> &'a str {
    if let Some(package_name) = package_name {
        let prefix = format!("dependencies/{}/", package_name);
        path.strip_prefix(&prefix).unwrap_or(path)
    } else {
        path
    }
}

fn is_move_source_for_mode(path: &str, test_mode: bool, package_name: Option<&str>) -> bool {
    if !path.ends_with(".move") {
        return false;
    }

    let relative_path = package_relative_path(path, package_name);
    relative_path.starts_with("sources/")
        || relative_path.starts_with("scripts/")
        || (test_mode
            && (relative_path.starts_with("tests/") || relative_path.starts_with("examples/")))
}

fn source_discovery_sort_key<'a>(path: &'a str, package_name: Option<&str>) -> (u8, &'a [u8]) {
    let relative_path = package_relative_path(path, package_name);
    let rank = if relative_path.starts_with("sources/") {
        0
    } else if relative_path.starts_with("scripts/") {
        1
    } else if relative_path.starts_with("examples/") {
        2
    } else if relative_path.starts_with("tests/") {
        3
    } else {
        4
    };
    (rank, relative_path.as_bytes())
}

pub(super) fn source_paths_for_package(
    files: &std::collections::BTreeMap<String, String>,
    test_mode: bool,
    package_name: Option<&str>,
    excluded_paths: Option<&HashSet<&str>>,
) -> Vec<Symbol> {
    let mut paths: Vec<Symbol> = files
        .keys()
        .filter(|name| is_move_source_for_mode(name, test_mode, package_name))
        .filter(|name| {
            excluded_paths
                .map(|excluded| !excluded.contains(name.as_str()))
                .unwrap_or(true)
        })
        .map(|path| Symbol::from(path.as_str()))
        .collect();

    paths.sort_by(|a, b| {
        let pa = a.as_str();
        let pb = b.as_str();
        source_discovery_sort_key(pa, package_name)
            .cmp(&source_discovery_sort_key(pb, package_name))
    });
    paths
}

pub(super) fn dependency_file_paths(dep_packages: &[PackageGroup]) -> HashSet<&str> {
    let mut paths = HashSet::new();
    for pkg_group in dep_packages {
        for path in pkg_group.files.keys() {
            paths.insert(path.as_str());
        }
    }
    paths
}
