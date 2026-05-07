use crate::manifest::SourceManifest;
use move_compiler::{editions::Edition, shared::NumericalAddress};
use serde::Serialize;
use sha2::Digest;
use std::collections::{BTreeMap, BTreeSet};

use super::addresses::{numerical_address, source_address_is_unpublished, zero_numerical_address};
use super::types::{PackageGroup, PackageGroupSource};

pub(super) fn dependency_aliases_from_move_toml(move_toml_content: &str) -> BTreeSet<String> {
    let Ok(value) = toml::from_str::<toml::Value>(move_toml_content) else {
        return BTreeSet::new();
    };

    value
        .get("dependencies")
        .and_then(|deps| deps.as_table())
        .map(|deps| deps.keys().cloned().collect())
        .unwrap_or_default()
}

pub(super) fn move_toml_uses_legacy_manifest(move_toml_content: &str) -> bool {
    let Ok(value) = toml::from_str::<toml::Value>(move_toml_content) else {
        return false;
    };
    value
        .get("addresses")
        .or_else(|| value.get("dev-addresses"))
        .or_else(|| value.get("dev-dependencies"))
        .is_some()
}

pub(super) fn package_manifest_name(pkg_group: &PackageGroup) -> Option<String> {
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

pub(super) fn is_explicit_root_dependency(
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

pub(super) fn parse_edition(edition_str: &str) -> Result<Edition, String> {
    match edition_str {
        "legacy" => Ok(Edition::LEGACY),
        "2024" => Ok(Edition::E2024),
        "2024.alpha" => Ok(Edition::E2024_ALPHA),
        "2024.beta" => Ok(Edition::E2024_BETA),
        value => Err(format!(
            "Invalid Move edition '{}'. Supported editions: legacy, 2024.alpha, 2024.beta, 2024",
            value
        )),
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum LockfileDependencyInfoForHash {
    Git {
        git: String,
        subdir: std::path::PathBuf,
        rev: String,
    },
    Local {
        local: std::path::PathBuf,
    },
    Root {
        root: bool,
    },
}

fn lockfile_dependency_info_for_hash(
    source: Option<&PackageGroupSource>,
) -> Option<LockfileDependencyInfoForHash> {
    match source {
        Some(PackageGroupSource::Git { git, rev, subdir }) => {
            Some(LockfileDependencyInfoForHash::Git {
                git: git.clone(),
                subdir: std::path::PathBuf::from(subdir.clone().unwrap_or_default()),
                rev: rev.clone(),
            })
        }
        Some(PackageGroupSource::Local { local }) => Some(LockfileDependencyInfoForHash::Local {
            local: std::path::PathBuf::from(local),
        }),
        Some(PackageGroupSource::Root) | None => {
            Some(LockfileDependencyInfoForHash::Root { root: true })
        }
        Some(PackageGroupSource::Unsupported) => None,
    }
}

pub(super) fn dummy_address_for_package_group(
    pkg_group: &PackageGroup,
) -> Option<NumericalAddress> {
    let lockfile_info = lockfile_dependency_info_for_hash(pkg_group.source.as_ref())?;
    let document = toml_edit::ser::to_document(&lockfile_info).ok()?;
    let digest = sha2::Sha256::digest(document.to_string().as_bytes());
    let digest_bytes = digest.as_slice();
    let mut first_eight = [0u8; 8];
    first_eight.copy_from_slice(&digest_bytes[..8]);
    let truncated = (u64::from_be_bytes(first_eight) as u16).to_be_bytes();
    let mut bytes = [0u8; 32];
    bytes[30..].copy_from_slice(&truncated);
    Some(NumericalAddress::new(
        bytes,
        move_core_types::parsing::parser::NumberFormat::Hex,
    ))
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

pub(super) fn package_group_has_unpublished_addresses(pkg_group: &PackageGroup) -> bool {
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

pub(super) fn parse_source_manifest(files: &BTreeMap<String, String>) -> Option<SourceManifest> {
    let move_toml_content = source_manifest_content(files)?;
    toml::from_str::<SourceManifest>(move_toml_content).ok()
}

pub(super) fn source_manifest_content(files: &BTreeMap<String, String>) -> Option<&str> {
    let toml_key = files.keys().find(|path| path.ends_with("Move.toml"))?;
    files.get(toml_key).map(String::as_str)
}

pub(super) fn address_map_from_manifest(
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
