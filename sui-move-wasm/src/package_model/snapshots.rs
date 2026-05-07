use move_compiler::editions::{Edition, Flavor};
use std::collections::{BTreeMap, BTreeSet};

use super::addresses::{
    numerical_address, parse_hex_address_to_bytes, source_address_is_unpublished,
};
use super::manifest::{
    address_map_from_manifest, dependency_aliases_from_move_toml, dummy_address_for_package_group,
    is_explicit_root_dependency, move_toml_uses_legacy_manifest, package_manifest_name,
    parse_edition, parse_source_manifest, source_manifest_content,
};
use super::types::{PackageGroup, ResolvedPackageSnapshot, RootPackageSnapshot};

pub(super) fn root_package_snapshot(
    files: &BTreeMap<String, String>,
    set_unpublished_deps_to_zero: bool,
) -> Result<RootPackageSnapshot, String> {
    let mut snapshot = RootPackageSnapshot {
        name: "root".to_string(),
        edition: Edition::default(),
        flavor: Flavor::Sui,
        is_legacy: false,
        named_address_map: BTreeMap::new(),
        root_address_names: BTreeSet::new(),
        dependency_aliases: BTreeSet::new(),
    };

    if let Some(move_toml_content) = source_manifest_content(files) {
        snapshot.dependency_aliases = dependency_aliases_from_move_toml(move_toml_content);
        snapshot.is_legacy = move_toml_uses_legacy_manifest(move_toml_content);
    }

    if let Some(manifest) = parse_source_manifest(files) {
        snapshot.name = manifest.package.name.to_string();
        if let Some(edition) = manifest.package.edition.as_ref() {
            snapshot.edition = parse_edition(edition)?;
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

    Ok(snapshot)
}

pub(super) fn resolved_package_snapshot(
    pkg_group: &PackageGroup,
    root_dependency_aliases: &BTreeSet<String>,
    set_unpublished_deps_to_zero: bool,
) -> Result<ResolvedPackageSnapshot, String> {
    let manifest = parse_source_manifest(&pkg_group.files);
    let mut edition = manifest
        .as_ref()
        .and_then(|manifest| manifest.package.edition.as_ref())
        .map(|edition| parse_edition(edition))
        .transpose()?
        .unwrap_or_default();
    let flavor = manifest
        .as_ref()
        .and_then(|manifest| manifest.package.flavor)
        .unwrap_or(Flavor::Sui);
    if let Some(edition_override) = pkg_group.edition.as_ref() {
        edition = parse_edition(edition_override)?;
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
                if let Some(dummy) = dummy_address_for_package_group(pkg_group) {
                    if name == &pkg_group.name && fallback_dep_id.is_none() {
                        fallback_dep_id = Some(dummy.into_bytes());
                    }
                    named_address_map.insert(name.clone(), dummy);
                }
            }
        }
    } else if let Some(manifest) = manifest.as_ref() {
        named_address_map = address_map_from_manifest(manifest, false);
        if set_unpublished_deps_to_zero {
            if let (Some(addresses), Some(dummy)) = (
                &manifest.addresses,
                dummy_address_for_package_group(pkg_group),
            ) {
                for (name, addr_opt) in addresses {
                    if source_address_is_unpublished(addr_opt.as_ref()) {
                        named_address_map.insert(name.as_str().to_string(), dummy);
                    }
                }
            }
        }

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
                        fallback_dep_id = dummy_address_for_package_group(pkg_group)
                            .map(|addr| addr.into_bytes());
                        found_address_id = true;
                    }
                } else if set_unpublished_deps_to_zero && source_address_is_unpublished(None) {
                    fallback_dep_id =
                        dummy_address_for_package_group(pkg_group).map(|addr| addr.into_bytes());
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

    Ok(ResolvedPackageSnapshot {
        package_id: pkg_group.name.clone(),
        display_name: pkg_group
            .display_name
            .clone()
            .unwrap_or_else(|| pkg_group.name.clone()),
        edition,
        flavor,
        named_address_map,
        dependency_id_for_output,
        is_explicit_root_dependency: is_explicit_root_dependency(
            pkg_group,
            package_manifest_name(pkg_group).as_deref(),
            root_dependency_aliases,
        ),
    })
}
