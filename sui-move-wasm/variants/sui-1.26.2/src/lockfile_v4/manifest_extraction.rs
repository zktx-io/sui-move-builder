use super::fetch_plan::find_move_toml;
use super::LockfileV4PackageManifest;
use crate::manifest_digest;
use std::collections::{BTreeMap, BTreeSet};

fn is_zero_or_unassigned_address(value: &str) -> bool {
    value.trim() == "_"
        || crate::normalize_hex_address_string(value)
            .map(|address| {
                address == "0x0000000000000000000000000000000000000000000000000000000000000000"
            })
            .unwrap_or(false)
}

pub(crate) const NO_NAME_LEGACY_PACKAGE_NAME: &str = "unnamed_legacy_package";

fn strip_move_comments(source: &str) -> String {
    let mut result = String::new();
    let mut in_block_comment = false;

    for line in source.lines() {
        let mut line_cleaned = line.to_string();

        if let Some(start) = line_cleaned.find("///") {
            line_cleaned.replace_range(start.., "");
        }
        if let Some(start) = line_cleaned.find("//") {
            line_cleaned.replace_range(start.., "");
        }

        if in_block_comment {
            if let Some(end) = line_cleaned.find("*/") {
                line_cleaned.replace_range(..=end + 1, "");
                in_block_comment = false;
            } else {
                continue;
            }
        }

        while let Some(start) = line_cleaned.find("/*") {
            if let Some(end) = line_cleaned[start..].find("*/") {
                line_cleaned.replace_range(start..start + end + 2, "");
            } else {
                line_cleaned.replace_range(start.., "");
                in_block_comment = true;
                break;
            }
        }

        result.push_str(&line_cleaned);
    }

    result
}

fn is_ident_start(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphabetic()
}

fn is_ident_continue(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphanumeric()
}

fn module_names_from_source(source: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let bytes = source.as_bytes();
    let mut index = 0;

    while index + b"module".len() <= bytes.len() {
        if !bytes[index..].starts_with(b"module")
            || (index > 0 && is_ident_continue(bytes[index - 1]))
        {
            index += 1;
            continue;
        }

        let mut cursor = index + b"module".len();
        if cursor >= bytes.len() || !bytes[cursor].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || !is_ident_start(bytes[cursor]) {
            index += 1;
            continue;
        }

        let name_start = cursor;
        cursor += 1;
        while cursor < bytes.len() && is_ident_continue(bytes[cursor]) {
            cursor += 1;
        }

        if cursor + 1 >= bytes.len() || bytes[cursor] != b':' || bytes[cursor + 1] != b':' {
            index += 1;
            continue;
        }

        let name = &source[name_start..cursor];
        if !name.starts_with("0x") && !name.starts_with("0X") {
            names.insert(name.to_string());
        }
        index = cursor + 2;
    }

    names
}

fn is_legacy_name_source_path(path: &str) -> bool {
    let Some(relative_path) = path.strip_prefix("sources/") else {
        return false;
    };
    relative_path.ends_with(".move")
        && relative_path
            .split('/')
            .filter(|part| !part.is_empty())
            .count()
            <= 5
}

fn module_names_from_sources(files: &BTreeMap<String, String>) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for (path, content) in files {
        if !is_legacy_name_source_path(path) {
            continue;
        }
        let clean = strip_move_comments(content);
        names.extend(module_names_from_source(&clean));
    }
    names
}

fn derive_legacy_modern_name(
    addresses: &BTreeMap<String, String>,
    files: &BTreeMap<String, String>,
) -> Option<String> {
    let zero_addresses = addresses
        .iter()
        .filter_map(|(name, address)| is_zero_or_unassigned_address(address).then(|| name.clone()))
        .collect::<Vec<_>>();

    if zero_addresses.len() == 1 && crate::is_move_named_address(&zero_addresses[0]) {
        return Some(zero_addresses[0].clone());
    }

    let module_names = module_names_from_sources(files);
    if module_names.len() == 1 {
        module_names.into_iter().next()
    } else {
        None
    }
}

fn chain_id(environment: &str) -> &str {
    match environment {
        "mainnet" => "35834a8a",
        "testnet" => "4c78adac",
        "devnet" => "2",
        other => other,
    }
}

fn env_publication(
    files: &BTreeMap<String, String>,
    environment: &str,
) -> (Option<String>, Option<String>) {
    let Some(lockfile_content) = files.get("Move.lock") else {
        return (None, None);
    };
    let Ok(value) = lockfile_content.parse::<toml::Value>() else {
        return (None, None);
    };
    let chain_id = chain_id(environment);
    let env = value
        .get("env")
        .and_then(|envs| envs.get(chain_id).or_else(|| envs.get(environment)))
        .and_then(|env| env.as_table());

    let original_id = env
        .and_then(|env| env.get("original-published-id"))
        .and_then(|value| value.as_str())
        .and_then(crate::normalize_hex_address_string);
    let latest_id = env
        .and_then(|env| env.get("latest-published-id"))
        .and_then(|value| value.as_str())
        .and_then(crate::normalize_hex_address_string);

    (original_id, latest_id)
}

fn published_toml_publication(
    files: &BTreeMap<String, String>,
    environment: &str,
) -> (Option<String>, Option<String>) {
    let Some(published_content) = files.get("Published.toml") else {
        return (None, None);
    };
    let Ok(value) = published_content.parse::<toml::Value>() else {
        return (None, None);
    };
    let env = value
        .get("published")
        .and_then(|published| published.get(environment))
        .and_then(|env| env.as_table());

    let published_at = env
        .and_then(|env| env.get("published-at"))
        .and_then(|value| value.as_str())
        .and_then(crate::normalize_hex_address_string);
    let original_id = env
        .and_then(|env| env.get("original-id"))
        .and_then(|value| value.as_str())
        .and_then(crate::normalize_hex_address_string);

    (published_at, original_id)
}

pub(crate) fn manifest_from_files(
    package_id: &str,
    files: &BTreeMap<String, String>,
    environment: &str,
) -> Result<(LockfileV4PackageManifest, String), String> {
    let move_toml = find_move_toml(files, environment)
        .ok_or_else(|| format!("Dependency '{}' did not provide Move.toml", package_id))?;
    let value = move_toml
        .parse::<toml::Value>()
        .map_err(|error| format!("Failed to parse Move.toml for '{}': {}", package_id, error))?;
    let package = value
        .get("package")
        .and_then(|package| package.as_table())
        .ok_or_else(|| format!("Move.toml for '{}' has no [package]", package_id))?;

    let mut name = package
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or(package_id)
        .to_string();
    let legacy_name = name.clone();
    let version = package
        .get("version")
        .and_then(|value| value.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let edition = package
        .get("edition")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let implicit_dependencies = package
        .get("implicit-dependencies")
        .or_else(|| package.get("implicit_dependencies"))
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let is_legacy = value
        .get("addresses")
        .and_then(|addresses| addresses.as_table())
        .is_some()
        || value
            .get("dev-addresses")
            .and_then(|addresses| addresses.as_table())
            .is_some()
        || value
            .get("dev-dependencies")
            .and_then(|dependencies| dependencies.as_table())
            .is_some();
    let manifest_published_at = package
        .get("published-at")
        .or_else(|| package.get("published_at"))
        .and_then(|value| value.as_str())
        .filter(|value| *value != "0x0")
        .and_then(crate::normalize_hex_address_string);
    let manifest_original_id = package
        .get("original-id")
        .or_else(|| package.get("original_id"))
        .and_then(|value| value.as_str())
        .and_then(crate::normalize_hex_address_string);

    let (lock_original_id, lock_latest_id) = env_publication(files, environment);
    let mut published_at = manifest_published_at
        .clone()
        .or(lock_latest_id.clone())
        .or(lock_original_id.clone());
    let mut original_id = manifest_original_id.or(lock_original_id);

    let (published_toml_latest, published_toml_original) =
        published_toml_publication(files, environment);
    if published_toml_latest.is_some() {
        published_at = published_toml_latest;
    }
    if published_toml_original.is_some() {
        original_id = published_toml_original;
    }

    let mut addresses = BTreeMap::new();
    if let Some(address_table) = value
        .get("addresses")
        .and_then(|addresses| addresses.as_table())
    {
        for (name, address) in address_table {
            if let Some(address_str) = address.as_str() {
                addresses.insert(
                    name.clone(),
                    crate::normalize_hex_address_string(address_str)
                        .unwrap_or_else(|| address_str.to_string()),
                );
            }
        }
    }

    if is_legacy {
        name = derive_legacy_modern_name(&addresses, files)
            .unwrap_or_else(|| NO_NAME_LEGACY_PACKAGE_NAME.to_string());
        for (address_name, address) in &addresses {
            if address.trim() == "_" && address_name != &name {
                return Err(format!(
                    "Found non instantiated named address `{}` (declared as `_`). All addresses in the `addresses` field must be instantiated.",
                    address_name
                ));
            }
        }
    }
    let implicit_dependencies = if is_legacy {
        manifest_digest::legacy_implicit_dependencies(&legacy_name, &value, implicit_dependencies)
    } else {
        implicit_dependencies
    };
    let combined_dependencies = manifest_digest::combined_dependencies_from_move_toml(
        move_toml,
        Some(if is_legacy {
            legacy_name.clone()
        } else {
            name.clone()
        }),
        environment,
    )?;

    let self_address_key = addresses
        .keys()
        .find(|key| key.eq_ignore_ascii_case(&name))
        .cloned();
    if let Some(self_key) = &self_address_key {
        if let Some(self_address) = addresses.get(self_key) {
            if self_address != "0x0000000000000000000000000000000000000000000000000000000000000000"
            {
                original_id = Some(self_address.clone());
            }
        }
    }

    let address_to_use = original_id.clone().or_else(|| published_at.clone());
    let package_has_named_self = !is_legacy || name != NO_NAME_LEGACY_PACKAGE_NAME;
    if let Some(address) = address_to_use {
        if package_has_named_self
            && !addresses.contains_key(&name)
            && crate::is_move_named_address(&name)
        {
            addresses.insert(name.clone(), address);
        }
    } else if package_has_named_self
        && !addresses.contains_key(&name)
        && crate::is_move_named_address(&name)
    {
        addresses.insert(name.clone(), "0x0".to_string());
    }

    let dependencies = value
        .get("dependencies")
        .cloned()
        .and_then(|value| serde_json::to_value(value).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let dev_dependencies = value
        .get("dev-dependencies")
        .cloned()
        .and_then(|value| serde_json::to_value(value).ok());

    Ok((
        LockfileV4PackageManifest {
            name,
            legacy_name: is_legacy.then_some(legacy_name),
            version,
            edition,
            is_legacy,
            implicit_dependencies,
            published_at: published_at.clone(),
            original_id,
            latest_published_id: published_at,
            addresses,
            dependencies,
            dev_dependencies,
            combined_dependencies,
        },
        move_toml.to_string(),
    ))
}

pub(crate) fn package_graph_id_name(manifest: &LockfileV4PackageManifest) -> String {
    manifest
        .legacy_name
        .as_deref()
        .map(manifest_digest::normalize_legacy_name_to_identifier)
        .unwrap_or_else(|| manifest.name.clone())
}

pub(crate) fn manifest_dep_names(manifest: &LockfileV4PackageManifest) -> Vec<String> {
    let mut deps = manifest
        .combined_dependencies
        .iter()
        .map(|dependency| dependency.name.clone())
        .collect::<Vec<_>>();
    deps.sort();
    deps
}
