use crate::manifest::SourceManifest;
use move_compiler::{
    diagnostics::warning_filters::WarningFiltersBuilder,
    editions::{Edition, Flavor},
    shared::{NumericalAddress, PackageConfig, PackagePaths},
};
use move_core_types::account_address::AccountAddress;
use move_symbol_pool::Symbol;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use sui_types::{BRIDGE_ADDRESS, SUI_SYSTEM_ADDRESS};

#[derive(Default, Deserialize)]
struct PackageGroupManifest {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct PackageGroup {
    pub(crate) name: String,
    pub(crate) files: BTreeMap<String, String>,
    #[serde(default)]
    edition: Option<String>,
    #[serde(default, rename = "addressMapping")]
    address_mapping: Option<BTreeMap<String, String>>,
    #[serde(default, rename = "publishedIdForOutput")]
    published_id_for_output: Option<String>,
    #[serde(default)]
    manifest: Option<PackageGroupManifest>,
    #[serde(default, rename = "rootDependencyAliases")]
    root_dependency_aliases: Vec<String>,
}

pub(crate) enum CompilerInputMode {
    Build {
        test_mode: bool,
        root_as_zero: bool,
        set_unpublished_deps_to_zero: bool,
    },
    #[cfg_attr(not(feature = "testing"), allow(dead_code))]
    TestRunner,
}

impl CompilerInputMode {
    fn root_test_mode(&self) -> bool {
        match self {
            Self::Build { test_mode, .. } => *test_mode,
            Self::TestRunner => true,
        }
    }

    fn dependency_test_mode(&self) -> bool {
        match self {
            Self::Build { test_mode, .. } => *test_mode,
            Self::TestRunner => true,
        }
    }

    fn root_as_zero(&self) -> bool {
        match self {
            Self::Build { root_as_zero, .. } => *root_as_zero,
            Self::TestRunner => false,
        }
    }

    fn set_unpublished_deps_to_zero(&self) -> bool {
        match self {
            Self::Build {
                set_unpublished_deps_to_zero,
                ..
            } => *set_unpublished_deps_to_zero,
            Self::TestRunner => false,
        }
    }
}

struct RootPackageSnapshot {
    name: String,
    edition: Edition,
    flavor: Flavor,
    named_address_map: BTreeMap<String, NumericalAddress>,
    root_address_names: BTreeSet<String>,
    dependency_aliases: BTreeSet<String>,
}

struct ResolvedPackageSnapshot {
    package_id: String,
    manifest_name: Option<String>,
    edition: Edition,
    flavor: Flavor,
    named_address_map: BTreeMap<String, NumericalAddress>,
    dependency_id_for_output: Option<[u8; 32]>,
    is_explicit_root_dependency: bool,
}

pub(crate) struct CompilerInput {
    pub(crate) root_package_name: String,
    pub(crate) package_paths: Vec<PackagePaths<Symbol, String>>,
    pub(crate) dependency_ids_by_name: Vec<(String, [u8; 32])>,
}

pub(crate) fn parse_hex_address_to_bytes(addr: &str) -> Option<[u8; 32]> {
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

fn dependency_aliases_from_move_toml(move_toml_content: &str) -> BTreeSet<String> {
    let Ok(value) = toml::from_str::<toml::Value>(move_toml_content) else {
        return BTreeSet::new();
    };

    value
        .get("dependencies")
        .and_then(|deps| deps.as_table())
        .map(|deps| deps.keys().cloned().collect())
        .unwrap_or_default()
}

fn package_manifest_name(pkg_group: &PackageGroup) -> Option<String> {
    if let Some(name) = pkg_group
        .manifest
        .as_ref()
        .and_then(|manifest| manifest.name.as_ref())
        .filter(|name| !name.is_empty())
    {
        return Some(name.clone());
    }

    let toml_key = pkg_group
        .files
        .keys()
        .find(|path| path.ends_with("Move.toml"))?;
    let move_toml_content = pkg_group.files.get(toml_key)?;
    toml::from_str::<SourceManifest>(move_toml_content)
        .ok()
        .map(|manifest| manifest.package.name)
}

fn is_explicit_root_dependency(
    pkg_group: &PackageGroup,
    manifest_name: Option<&str>,
    root_dependency_aliases: &BTreeSet<String>,
) -> bool {
    root_dependency_aliases.contains(&pkg_group.name)
        || manifest_name
            .map(|name| root_dependency_aliases.contains(name))
            .unwrap_or(false)
        || pkg_group
            .root_dependency_aliases
            .iter()
            .any(|alias| root_dependency_aliases.contains(alias))
}

fn should_emit_dependency_id(bytes: &[u8; 32], is_explicit_root_dependency: bool) -> bool {
    if bytes.iter().all(|byte| *byte == 0) {
        return false;
    }

    let address = AccountAddress::new(*bytes);
    if (address == SUI_SYSTEM_ADDRESS || address == BRIDGE_ADDRESS) && !is_explicit_root_dependency
    {
        return false;
    }

    true
}

pub(crate) fn parse_edition(edition_str: &str) -> Edition {
    match edition_str {
        "legacy" => Edition::LEGACY,
        "2024" | "2024.alpha" => Edition::E2024_ALPHA,
        "2024.beta" => Edition::E2024_BETA,
        _ => Edition::LEGACY,
    }
}

pub(crate) fn is_system_package_name(package_name: &str) -> bool {
    let lower = package_name.to_ascii_lowercase();
    lower == "sui"
        || lower.starts_with("sui_")
        || lower == "suisystem"
        || lower.starts_with("suisystem_")
        || lower == "bridge"
        || lower.starts_with("bridge_")
        || lower == "std"
        || lower == "movestdlib"
        || lower.starts_with("movestdlib_")
}

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

fn numerical_address(addr: &str) -> Option<NumericalAddress> {
    NumericalAddress::parse_str(addr).ok()
}

fn zero_numerical_address() -> Option<NumericalAddress> {
    numerical_address("0x0")
}

fn source_address_is_unpublished(addr_opt: Option<&String>) -> bool {
    match addr_opt.map(|addr| addr.trim()) {
        None => true,
        Some("_") => true,
        _ => false,
    }
}

fn manifest_has_unpublished_addresses(manifest: &SourceManifest) -> bool {
    manifest
        .addresses
        .as_ref()
        .map(|addresses| {
            addresses
                .values()
                .any(|addr_opt| source_address_is_unpublished(addr_opt.as_ref()))
        })
        .unwrap_or(false)
}

fn package_group_has_unpublished_addresses(pkg_group: &PackageGroup) -> bool {
    pkg_group
        .address_mapping
        .as_ref()
        .map(|address_mapping| address_mapping.values().any(|addr| addr.trim() == "_"))
        .unwrap_or(false)
        || parse_source_manifest(&pkg_group.files)
            .as_ref()
            .map(manifest_has_unpublished_addresses)
            .unwrap_or(false)
}

fn parse_source_manifest(files: &BTreeMap<String, String>) -> Option<SourceManifest> {
    let toml_key = files.keys().find(|path| path.ends_with("Move.toml"))?;
    let move_toml_content = files.get(toml_key)?;
    toml::from_str::<SourceManifest>(move_toml_content).ok()
}

fn address_map_from_manifest(
    manifest: &SourceManifest,
    set_unpublished_deps_to_zero: bool,
) -> BTreeMap<String, NumericalAddress> {
    let mut named_address_map = BTreeMap::new();
    if let Some(addresses) = &manifest.addresses {
        for (name, addr_opt) in addresses {
            if let Some(addr) = addr_opt {
                if let Some(address) = numerical_address(addr) {
                    named_address_map.insert(name.as_str().to_string(), address);
                } else if set_unpublished_deps_to_zero && source_address_is_unpublished(Some(addr))
                {
                    if let Some(zero) = zero_numerical_address() {
                        named_address_map.insert(name.as_str().to_string(), zero);
                    }
                }
            } else if set_unpublished_deps_to_zero && source_address_is_unpublished(None) {
                if let Some(zero) = zero_numerical_address() {
                    named_address_map.insert(name.as_str().to_string(), zero);
                }
            }
        }
    }
    named_address_map
}

fn root_package_snapshot(
    files: &BTreeMap<String, String>,
    set_unpublished_deps_to_zero: bool,
) -> RootPackageSnapshot {
    let mut snapshot = RootPackageSnapshot {
        name: "root".to_string(),
        edition: Edition::LEGACY,
        flavor: Flavor::Sui,
        named_address_map: BTreeMap::new(),
        root_address_names: BTreeSet::new(),
        dependency_aliases: BTreeSet::new(),
    };

    if let Some(move_toml_content) = files.get("Move.toml") {
        snapshot.dependency_aliases = dependency_aliases_from_move_toml(move_toml_content);
    }

    if let Some(manifest) = parse_source_manifest(files) {
        snapshot.name = manifest.package.name.to_string();
        if let Some(edition) = manifest.package.edition.as_ref() {
            snapshot.edition = parse_edition(edition);
        }
        if let Some(flavor) = manifest.package.flavor {
            snapshot.flavor = flavor;
        }
        snapshot.named_address_map =
            address_map_from_manifest(&manifest, set_unpublished_deps_to_zero);
        snapshot.root_address_names.insert(snapshot.name.clone());
        snapshot
            .root_address_names
            .insert(snapshot.name.to_ascii_lowercase());
        let root_address = manifest
            .package
            .original_id
            .as_deref()
            .and_then(parse_hex_address_to_bytes)
            .or_else(|| {
                manifest
                    .package
                    .published_at
                    .as_deref()
                    .and_then(parse_hex_address_to_bytes)
            });
        if let (Some(addresses), Some(root_address)) = (&manifest.addresses, root_address) {
            for (name, address) in addresses {
                if address
                    .as_deref()
                    .and_then(parse_hex_address_to_bytes)
                    .is_some_and(|bytes| bytes == root_address)
                {
                    snapshot
                        .root_address_names
                        .insert(name.as_str().to_string());
                }
            }
        }
    }

    snapshot
}

fn resolved_package_snapshot(
    pkg_group: &PackageGroup,
    root_dependency_aliases: &BTreeSet<String>,
    set_unpublished_deps_to_zero: bool,
) -> ResolvedPackageSnapshot {
    let manifest = parse_source_manifest(&pkg_group.files);
    let manifest_name = pkg_group
        .manifest
        .as_ref()
        .and_then(|manifest| manifest.name.as_ref())
        .filter(|name| !name.is_empty())
        .cloned()
        .or_else(|| {
            manifest
                .as_ref()
                .map(|manifest| manifest.package.name.clone())
        });

    let mut edition = manifest
        .as_ref()
        .and_then(|manifest| manifest.package.edition.as_ref())
        .map(|edition| parse_edition(edition))
        .unwrap_or(Edition::LEGACY);
    let flavor = manifest
        .as_ref()
        .and_then(|manifest| manifest.package.flavor)
        .unwrap_or(Flavor::Sui);
    if let Some(edition_override) = pkg_group.edition.as_ref() {
        edition = parse_edition(edition_override);
    }

    let mut named_address_map = BTreeMap::new();
    let mut fallback_dep_id = None;

    if let Some(ref addr_map) = pkg_group.address_mapping {
        for (name, addr_str) in addr_map {
            if let Some(address) = numerical_address(addr_str) {
                if name == &pkg_group.name && fallback_dep_id.is_none() {
                    fallback_dep_id = parse_hex_address_to_bytes(addr_str);
                }
                named_address_map.insert(name.clone(), address);
            } else if set_unpublished_deps_to_zero && addr_str.trim() == "_" {
                if let Some(zero) = zero_numerical_address() {
                    if name == &pkg_group.name && fallback_dep_id.is_none() {
                        fallback_dep_id = Some([0u8; 32]);
                    }
                    named_address_map.insert(name.clone(), zero);
                }
            }
        }
    } else if let Some(manifest) = manifest.as_ref() {
        named_address_map = address_map_from_manifest(manifest, set_unpublished_deps_to_zero);

        let mut found_address_id = false;
        if let Some(addresses) = &manifest.addresses {
            if let Some(addr_opt) = addresses.get(pkg_group.name.as_str()) {
                if let Some(addr) = addr_opt {
                    fallback_dep_id = parse_hex_address_to_bytes(addr);
                    found_address_id = fallback_dep_id.is_some();
                    if !found_address_id
                        && set_unpublished_deps_to_zero
                        && source_address_is_unpublished(Some(addr))
                    {
                        fallback_dep_id = Some([0u8; 32]);
                        found_address_id = true;
                    }
                } else if set_unpublished_deps_to_zero && source_address_is_unpublished(None) {
                    fallback_dep_id = Some([0u8; 32]);
                    found_address_id = true;
                }
            }
        }

        if !found_address_id {
            if let Some(published_at) = manifest.package.published_at.as_ref() {
                fallback_dep_id = parse_hex_address_to_bytes(published_at);
            }
        }
    }

    let dependency_id_for_output = pkg_group
        .published_id_for_output
        .as_ref()
        .and_then(|id| parse_hex_address_to_bytes(id))
        .or(fallback_dep_id);

    ResolvedPackageSnapshot {
        package_id: pkg_group.name.clone(),
        manifest_name,
        edition,
        flavor,
        named_address_map,
        dependency_id_for_output,
        is_explicit_root_dependency: is_explicit_root_dependency(
            pkg_group,
            package_manifest_name(pkg_group).as_deref(),
            root_dependency_aliases,
        ),
    }
}

fn source_paths_for_package(
    files: &BTreeMap<String, String>,
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

fn ensure_std_and_sui_addresses(root_named_address_map: &mut BTreeMap<String, NumericalAddress>) {
    if !root_named_address_map.contains_key("std") {
        if let Some(address) = numerical_address("0x1") {
            root_named_address_map.insert("std".to_string(), address);
        }
    }
    if !root_named_address_map.contains_key("sui") {
        if let Some(address) = numerical_address("0x2") {
            root_named_address_map.insert("sui".to_string(), address);
        }
    }
}

fn dependency_file_paths(dep_packages: &[PackageGroup]) -> HashSet<&str> {
    let mut paths = HashSet::new();
    for pkg_group in dep_packages {
        for path in pkg_group.files.keys() {
            paths.insert(path.as_str());
        }
    }
    paths
}

fn compiler_package_config(is_dependency: bool, edition: Edition, flavor: Flavor) -> PackageConfig {
    PackageConfig {
        is_dependency,
        edition,
        flavor,
        warning_filter: WarningFiltersBuilder::new_for_source(),
        ..PackageConfig::default()
    }
}

fn package_paths_for_compiler(
    package_id: &str,
    is_dependency: bool,
    edition: Edition,
    flavor: Flavor,
    paths: Vec<Symbol>,
    named_address_map: BTreeMap<String, NumericalAddress>,
) -> PackagePaths<Symbol, String> {
    PackagePaths {
        name: Some((
            Symbol::from(package_id),
            compiler_package_config(is_dependency, edition, flavor),
        )),
        paths,
        named_address_map,
    }
}

fn merge_dependency_addresses(
    root_named_address_map: &mut BTreeMap<String, NumericalAddress>,
    dependency_named_address_map: &BTreeMap<String, NumericalAddress>,
) {
    for (name, addr) in dependency_named_address_map {
        if !root_named_address_map.contains_key(name) {
            root_named_address_map.insert(name.clone(), *addr);
        }
    }
}

fn dependency_output_id_entry(snapshot: &ResolvedPackageSnapshot) -> Option<(String, [u8; 32])> {
    let bytes = snapshot.dependency_id_for_output?;
    if !should_emit_dependency_id(&bytes, snapshot.is_explicit_root_dependency) {
        return None;
    }

    let sort_name = snapshot
        .manifest_name
        .clone()
        .unwrap_or_else(|| snapshot.package_id.clone());
    Some((sort_name, bytes))
}

fn dependency_addresses_for_compiler(
    snapshot: &ResolvedPackageSnapshot,
) -> BTreeMap<String, NumericalAddress> {
    let mut named_address_map = snapshot.named_address_map.clone();
    ensure_std_and_sui_addresses(&mut named_address_map);
    named_address_map
}

fn dependency_package_paths(
    pkg_group: &PackageGroup,
    snapshot: &ResolvedPackageSnapshot,
    mode: &CompilerInputMode,
    named_address_map: BTreeMap<String, NumericalAddress>,
) -> PackagePaths<Symbol, String> {
    let paths = source_paths_for_package(
        &pkg_group.files,
        mode.dependency_test_mode(),
        Some(snapshot.package_id.as_str()),
        None,
    );

    package_paths_for_compiler(
        snapshot.package_id.as_str(),
        true,
        snapshot.edition,
        snapshot.flavor,
        paths,
        named_address_map,
    )
}

fn root_package_paths(
    snapshot: &RootPackageSnapshot,
    paths: Vec<Symbol>,
    named_address_map: BTreeMap<String, NumericalAddress>,
) -> PackagePaths<Symbol, String> {
    package_paths_for_compiler(
        snapshot.name.as_str(),
        false,
        snapshot.edition,
        snapshot.flavor,
        paths,
        named_address_map,
    )
}

fn apply_root_as_zero(
    named_address_map: &mut BTreeMap<String, NumericalAddress>,
    snapshot: &RootPackageSnapshot,
) {
    let Some(zero) = numerical_address("0x0") else {
        return;
    };
    for name in &snapshot.root_address_names {
        if named_address_map.contains_key(name) {
            named_address_map.insert(name.clone(), zero);
        }
    }
}

pub(crate) fn build_compiler_input(
    files: &BTreeMap<String, String>,
    dep_packages: &[PackageGroup],
    mode: CompilerInputMode,
) -> Result<CompilerInput, String> {
    let root_snapshot = root_package_snapshot(files, mode.set_unpublished_deps_to_zero());
    let dependency_paths = dependency_file_paths(dep_packages);
    let root_targets =
        source_paths_for_package(files, mode.root_test_mode(), None, Some(&dependency_paths));

    let mut root_named_address_map = root_snapshot.named_address_map.clone();
    let mut dep_package_paths = Vec::new();
    let mut dependency_ids_by_name = Vec::new();
    let mut emitted_dependency_ids = HashSet::<[u8; 32]>::new();

    for pkg_group in dep_packages {
        if !mode.set_unpublished_deps_to_zero()
            && package_group_has_unpublished_addresses(pkg_group)
        {
            return Err(format!(
                "Dependency '{}' contains unpublished addresses. Enable withUnpublishedDependencies to compile it as 0x0.",
                pkg_group.name
            ));
        }

        let snapshot = resolved_package_snapshot(
            pkg_group,
            &root_snapshot.dependency_aliases,
            mode.set_unpublished_deps_to_zero(),
        );

        if let Some((sort_name, bytes)) = dependency_output_id_entry(&snapshot) {
            if emitted_dependency_ids.insert(bytes) {
                dependency_ids_by_name.push((sort_name, bytes));
            }
        }

        let dependency_named_address_map = dependency_addresses_for_compiler(&snapshot);
        merge_dependency_addresses(&mut root_named_address_map, &dependency_named_address_map);
        dep_package_paths.push(dependency_package_paths(
            pkg_group,
            &snapshot,
            &mode,
            dependency_named_address_map,
        ));
    }

    if mode.root_as_zero() {
        apply_root_as_zero(&mut root_named_address_map, &root_snapshot);
    }
    ensure_std_and_sui_addresses(&mut root_named_address_map);
    let target_package = root_package_paths(&root_snapshot, root_targets, root_named_address_map);

    let mut package_paths = vec![target_package];
    package_paths.extend(dep_package_paths);

    Ok(CompilerInput {
        root_package_name: root_snapshot.name,
        package_paths,
        dependency_ids_by_name,
    })
}
