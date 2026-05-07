use move_compiler::{
    diagnostics::warning_filters::WarningFiltersBuilder,
    editions::{Edition, Flavor},
    shared::{NumericalAddress, PackageConfig, PackagePaths},
};
use move_symbol_pool::Symbol;
use std::collections::{BTreeMap, HashSet};

use super::addresses::numerical_address;
use super::manifest::package_group_has_unpublished_addresses;
use super::output::{
    dependency_address_for_root_alias, dependency_addresses_for_compiler,
    dependency_output_id_entry, ensure_std_and_sui_addresses, root_dependency_aliases_for_package,
};
use super::snapshots::{resolved_package_snapshot, root_package_snapshot};
use super::source_discovery::{dependency_file_paths, source_paths_for_package};
use super::types::{
    CompilerInput, CompilerInputMode, PackageGroup, ResolvedPackageSnapshot, RootPackageSnapshot,
};

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

fn insert_root_named_address(
    named_address_map: &mut BTreeMap<String, NumericalAddress>,
    name: String,
    address: NumericalAddress,
) -> Result<(), String> {
    if let Some(existing) = named_address_map.get(&name) {
        if existing != &address {
            return Err(format!("Duplicate named address '{}'", name));
        }
        return Ok(());
    }
    named_address_map.insert(name, address);
    Ok(())
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
    let root_snapshot = root_package_snapshot(files, mode.set_unpublished_deps_to_zero())?;
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
        )?;

        if let Some((sort_name, bytes)) = dependency_output_id_entry(&snapshot) {
            if emitted_dependency_ids.insert(bytes) {
                dependency_ids_by_name.push((sort_name, bytes));
            }
        }

        let dependency_named_address_map = dependency_addresses_for_compiler(&snapshot);
        if root_snapshot.is_legacy && snapshot.is_explicit_root_dependency {
            for (name, address) in &snapshot.named_address_map {
                insert_root_named_address(&mut root_named_address_map, name.clone(), *address)?;
            }
        } else if snapshot.is_explicit_root_dependency {
            if let Some(address) = dependency_address_for_root_alias(&snapshot) {
                for alias in root_dependency_aliases_for_package(
                    pkg_group,
                    &snapshot,
                    &root_snapshot.dependency_aliases,
                ) {
                    insert_root_named_address(&mut root_named_address_map, alias, address)?;
                }
            }
        }
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
