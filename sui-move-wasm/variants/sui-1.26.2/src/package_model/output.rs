use move_compiler::shared::NumericalAddress;
use move_core_types::account_address::AccountAddress;
use std::collections::{BTreeMap, BTreeSet};
use sui_types::{BRIDGE_ADDRESS, SUI_SYSTEM_ADDRESS};

use super::addresses::{numerical_address, numerical_address_from_bytes};
use super::types::{PackageGroup, ResolvedPackageSnapshot};

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

pub(super) fn ensure_std_and_sui_addresses(
    root_named_address_map: &mut BTreeMap<String, NumericalAddress>,
) {
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

pub(super) fn dependency_output_id_entry(
    snapshot: &ResolvedPackageSnapshot,
) -> Option<(String, [u8; 32])> {
    let bytes = snapshot.dependency_id_for_output?;
    if !should_emit_dependency_id(&bytes, snapshot.is_explicit_root_dependency) {
        return None;
    }

    Some((snapshot.display_name.clone(), bytes))
}

pub(super) fn dependency_addresses_for_compiler(
    snapshot: &ResolvedPackageSnapshot,
) -> BTreeMap<String, NumericalAddress> {
    let mut named_address_map = snapshot.named_address_map.clone();
    ensure_std_and_sui_addresses(&mut named_address_map);
    named_address_map
}

pub(super) fn dependency_address_for_root_alias(
    snapshot: &ResolvedPackageSnapshot,
) -> Option<NumericalAddress> {
    snapshot
        .dependency_id_for_output
        .as_ref()
        .map(numerical_address_from_bytes)
        .or_else(|| {
            snapshot
                .named_address_map
                .get(&snapshot.display_name)
                .cloned()
        })
        .or_else(|| {
            snapshot
                .named_address_map
                .get(&snapshot.package_id)
                .cloned()
        })
}

pub(super) fn root_dependency_aliases_for_package(
    pkg_group: &PackageGroup,
    snapshot: &ResolvedPackageSnapshot,
    root_dependency_aliases: &BTreeSet<String>,
) -> BTreeSet<String> {
    let mut aliases = BTreeSet::new();
    aliases.extend(pkg_group.root_dependency_aliases.iter().cloned());
    if root_dependency_aliases.contains(&pkg_group.name) {
        aliases.insert(pkg_group.name.clone());
    }
    if root_dependency_aliases.contains(&snapshot.display_name) {
        aliases.insert(snapshot.display_name.clone());
    }
    if root_dependency_aliases.contains(&snapshot.package_id) {
        aliases.insert(snapshot.package_id.clone());
    }
    aliases
}
