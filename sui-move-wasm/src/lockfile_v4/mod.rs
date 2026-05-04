use crate::helper::HelperError;
use crate::manifest_digest::{self, CombinedDependencySource, CombinedMoveDependency};
use crate::package_model::dependency_name_is_implicit;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum LockfileV4Source {
    Root,
    Git {
        git: String,
        rev: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
    },
    Local {
        local: String,
    },
    #[serde(other)]
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4PlanPackage {
    pub(crate) id: String,
    pub(crate) source: LockfileV4Source,
    #[serde(default)]
    pub(crate) deps: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) manifest_digest: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4ValidateInput {
    pub(crate) environment: String,
    pub(crate) root_move_toml: String,
    #[serde(default)]
    pub(crate) modes: Vec<String>,
    pub(crate) packages: Vec<LockfileV4ValidatePackage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4ValidatePackage {
    pub(crate) id: String,
    pub(crate) source: LockfileV4Source,
    #[serde(default)]
    pub(crate) deps: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) manifest_digest: Option<String>,
    #[serde(default)]
    pub(crate) files: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4GenerateInput {
    pub(crate) environment: String,
    #[serde(default)]
    pub(crate) existing_lockfile: Option<String>,
    pub(crate) root: LockfileV4GeneratePackage,
    pub(crate) packages: Vec<LockfileV4GeneratePackage>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4GeneratePackage {
    pub(crate) id: String,
    pub(crate) source: LockfileV4Source,
    #[serde(default)]
    pub(crate) files: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) dep_alias_to_package_name: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) root_dependency_aliases: Vec<String>,
}

struct LockfileV4GenerateResolvedPackage {
    id: String,
    source: LockfileV4Source,
    manifest_name: String,
    graph_id_name: String,
    combined_dependencies: Vec<CombinedMoveDependency>,
    dep_alias_to_package_name: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4ValidatedGraph {
    pub(crate) root_id: String,
    pub(crate) lockfile_order: Vec<String>,
    pub(crate) packages: Vec<LockfileV4ValidatedPackage>,
    pub(crate) edges: Vec<LockfileV4ValidatedEdge>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4ValidatedPackage {
    pub(crate) id: String,
    pub(crate) source: LockfileV4Source,
    pub(crate) manifest: LockfileV4PackageManifest,
    #[serde(default)]
    pub(crate) dep_alias_to_package_name: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) active_dep_alias_to_package_name: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4PackageManifest {
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "legacyName")]
    pub(crate) legacy_name: Option<String>,
    pub(crate) version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) edition: Option<String>,
    #[serde(default, rename = "isLegacy")]
    pub(crate) is_legacy: bool,
    #[serde(skip_serializing_if = "manifest_plan_is_true")]
    pub(crate) implicit_dependencies: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) original_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) latest_published_id: Option<String>,
    pub(crate) addresses: BTreeMap<String, String>,
    pub(crate) dependencies: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) dev_dependencies: Option<serde_json::Value>,
    #[serde(skip_serializing)]
    pub(crate) combined_dependencies: Vec<CombinedMoveDependency>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4ValidatedEdge {
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) alias: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) modes: Vec<String>,
    #[serde(
        rename = "isOverride",
        default,
        skip_serializing_if = "manifest_plan_is_false"
    )]
    pub(crate) is_override: bool,
}

pub(crate) enum LockfileV4ValidationResult {
    Ok(LockfileV4ValidatedGraph),
    OutOfDate(String),
    Error(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4PackageGroups {
    pub(crate) root_files: BTreeMap<String, String>,
    pub(crate) dependencies: Vec<LockfileV4PackageGroup>,
    pub(crate) lockfile_dependencies: Vec<LockfileV4PackageGroup>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4PackageGroup {
    pub(crate) name: String,
    pub(crate) display_name: String,
    pub(crate) files: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) edition: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) address_mapping: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) published_id_for_output: Option<String>,
    pub(crate) source: LockfileV4Source,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) manifest_deps: Vec<String>,
    pub(crate) manifest: LockfileV4PackageGroupManifest,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) dep_alias_to_package_name: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) root_dependency_aliases: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockfileV4PackageGroupManifest {
    pub(crate) name: String,
    pub(crate) dependencies: serde_json::Value,
}

fn manifest_plan_is_false(value: &bool) -> bool {
    !*value
}

fn manifest_plan_is_true(value: &bool) -> bool {
    *value
}

fn parse_source(
    environment: &str,
    package_id: &str,
    source_value: Option<&toml::Value>,
) -> Result<LockfileV4Source, HelperError> {
    let source = source_value
        .and_then(|value| value.as_table())
        .ok_or_else(|| {
            HelperError::new(format!(
                "Move.lock V4 pinned.{}.{} has no source",
                environment, package_id
            ))
        })?;

    if source.contains_key("root") {
        return Ok(LockfileV4Source::Root);
    }

    if let Some(git) = source.get("git").and_then(|value| value.as_str()) {
        let rev = source
            .get("rev")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                HelperError::new(format!(
                    "Move.lock V4 pinned.{}.{} git source is missing rev",
                    environment, package_id
                ))
            })?;
        return Ok(LockfileV4Source::Git {
            git: git.to_string(),
            rev: rev.to_string(),
            subdir: source
                .get("subdir")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
        });
    }

    if let Some(local) = source.get("local").and_then(|value| value.as_str()) {
        return Ok(LockfileV4Source::Local {
            local: local.to_string(),
        });
    }

    Err(HelperError::with_code(
        "unsupported_dependency_source",
        format!(
            "Move.lock V4 pinned.{}.{} has unsupported source",
            environment, package_id
        ),
    ))
}

fn parse_deps(pin: &toml::Table) -> BTreeMap<String, String> {
    let mut deps = BTreeMap::new();
    if let Some(dep_table) = pin.get("deps").and_then(|value| value.as_table()) {
        for (alias, target) in dep_table {
            if let Some(target_id) = target.as_str() {
                deps.insert(alias.clone(), target_id.to_string());
            }
        }
    }
    deps
}

pub(crate) fn find_move_toml<'a>(
    files: &'a BTreeMap<String, String>,
    environment: &str,
) -> Option<&'a str> {
    let network_toml = format!("Move.{}.toml", environment);
    files
        .get(&network_toml)
        .or_else(|| {
            files
                .iter()
                .find(|(path, _)| path.ends_with(&network_toml))
                .map(|(_, content)| content)
        })
        .or_else(|| files.get("Move.toml"))
        .or_else(|| {
            files
                .iter()
                .find(|(path, _)| path.ends_with("Move.toml"))
                .map(|(_, content)| content)
        })
        .map(|value| value.as_str())
}

pub(crate) fn plan_from_toml(
    move_lock_toml: &str,
    environment: &str,
) -> Result<Option<(String, Vec<String>, Vec<LockfileV4PlanPackage>)>, HelperError> {
    let parsed = move_lock_toml.parse::<toml::Value>().map_err(|error| {
        HelperError::with_code(
            "malformed_lockfile",
            format!("Failed to parse Move.lock: {}", error),
        )
    })?;
    if let Some(version) = parsed
        .get("move")
        .and_then(|move_section| move_section.get("version"))
        .and_then(|value| value.as_integer())
    {
        if version > 4 {
            return Err(HelperError::with_code(
                "unsupported_lockfile_version",
                format!(
                    "Move.lock version {} is newer than the supported V4 schema",
                    version
                ),
            ));
        }
    }

    let pinned_env = match parsed
        .get("pinned")
        .and_then(|pinned| pinned.get(environment))
        .and_then(|value| value.as_table())
    {
        Some(table) => table,
        None => return Ok(None),
    };

    let mut root_ids = Vec::new();
    let mut lockfile_order = Vec::new();
    let mut packages = Vec::new();
    for (package_id, pin_value) in pinned_env {
        let pin = pin_value.as_table().ok_or_else(|| {
            HelperError::new(format!(
                "Move.lock V4 pinned.{}.{} is not a table",
                environment, package_id
            ))
        })?;
        let source = parse_source(environment, package_id, pin.get("source"))?;
        if matches!(source, LockfileV4Source::Root) {
            root_ids.push(package_id.clone());
        }
        lockfile_order.push(package_id.clone());
        packages.push(LockfileV4PlanPackage {
            id: package_id.clone(),
            source,
            deps: parse_deps(pin),
            manifest_digest: pin
                .get("manifest_digest")
                .or_else(|| pin.get("manifest-digest"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
        });
    }
    if root_ids.is_empty() {
        return Err(HelperError::new(format!(
            "Move.lock V4 pinned.{} has no root package entry",
            environment
        )));
    }
    if root_ids.len() > 1 {
        return Err(HelperError::new(format!(
            "Move.lock V4 pinned.{} has multiple root package entries",
            environment
        )));
    }

    Ok(Some((root_ids.remove(0), lockfile_order, packages)))
}

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

fn toml_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("\"{}\"", escaped)
}

fn format_source(
    source: &LockfileV4Source,
    is_root: bool,
    package_id: &str,
) -> Result<String, String> {
    match source {
        LockfileV4Source::Root if is_root => Ok("source = { root = true }".to_string()),
        LockfileV4Source::Root => Err(format!(
            "Move.lock V4 generation package '{}' has root source outside the root package",
            package_id
        )),
        LockfileV4Source::Git { git, rev, subdir } => Ok(format!(
            "source = {{ git = {}, subdir = {}, rev = {} }}",
            toml_string(git),
            toml_string(subdir.as_deref().unwrap_or_default()),
            toml_string(rev)
        )),
        LockfileV4Source::Local { local } => {
            Ok(format!("source = {{ local = {} }}", toml_string(local)))
        }
        LockfileV4Source::Unsupported => Err(format!(
            "Move.lock V4 generation package '{}' has unsupported source",
            package_id
        )),
    }
}

fn source_matches_combined_dependency(
    source: &LockfileV4Source,
    dependency: &CombinedMoveDependency,
) -> bool {
    match source {
        LockfileV4Source::Git { git, rev, subdir } => match &dependency.source {
            CombinedDependencySource::Git {
                git: dep_git,
                rev: dep_rev,
                subdir: dep_subdir,
            } => {
                dep_git == git
                    && dep_rev.as_deref() == Some(rev.as_str())
                    && dep_subdir.as_deref().unwrap_or_default()
                        == subdir.as_deref().unwrap_or_default()
            }
            _ => false,
        },
        LockfileV4Source::Local { local } => match &dependency.source {
            CombinedDependencySource::Local { local: dep_local } => dep_local == local,
            _ => false,
        },
        LockfileV4Source::Root | LockfileV4Source::Unsupported => false,
    }
}

fn find_implicit_target(
    alias: &str,
    package_ids: &BTreeSet<String>,
    manifest_name_to_ids: &BTreeMap<String, Vec<String>>,
) -> Option<String> {
    let lower = alias.to_ascii_lowercase();
    let candidates: &[&str] = match lower.as_str() {
        "sui" => &["Sui"],
        "std" | "movestdlib" => &["MoveStdlib", "Std"],
        _ => return None,
    };

    for candidate in candidates {
        if package_ids.contains(*candidate) {
            return Some((*candidate).to_string());
        }
    }

    for candidate in candidates {
        if let Some(ids) = manifest_name_to_ids.get(*candidate) {
            if ids.len() == 1 {
                return ids.first().cloned();
            }
        }
    }

    None
}

fn resolve_dependency_target(
    current: &LockfileV4GenerateResolvedPackage,
    dependency: &CombinedMoveDependency,
    all_packages: &[LockfileV4GenerateResolvedPackage],
    package_ids: &BTreeSet<String>,
    manifest_name_to_ids: &BTreeMap<String, Vec<String>>,
) -> Result<String, String> {
    let alias = dependency.name.as_str();
    if let Some(target) = current.dep_alias_to_package_name.get(alias) {
        if package_ids.contains(target) {
            return Ok(target.clone());
        }
        return Err(format!(
            "Move.lock V4 generation package '{}' dependency '{}' references unknown package '{}'",
            current.id, alias, target
        ));
    }

    if matches!(dependency.source, CombinedDependencySource::System { .. }) {
        if let Some(target) = find_implicit_target(alias, package_ids, manifest_name_to_ids) {
            return Ok(target);
        }
    } else {
        let mut source_matches = all_packages
            .iter()
            .filter(|package| package.id != current.id)
            .filter(|package| source_matches_combined_dependency(&package.source, dependency))
            .map(|package| package.id.clone())
            .collect::<Vec<_>>();
        source_matches.sort();
        source_matches.dedup();
        if source_matches.len() == 1 {
            return Ok(source_matches.remove(0));
        }
        if source_matches.len() > 1 {
            return Err(format!(
                "Move.lock V4 generation package '{}' dependency '{}' matches multiple packages",
                current.id, alias
            ));
        }
    }

    if let Some(package_hint) = dependency
        .package_hint
        .as_ref()
        .or(dependency.rename_from.as_ref())
    {
        if package_ids.contains(package_hint.as_str()) {
            return Ok(package_hint.clone());
        }
        if let Some(ids) = manifest_name_to_ids.get(package_hint.as_str()) {
            if ids.len() == 1 {
                return ids.first().cloned().ok_or_else(|| {
                    format!(
                        "Move.lock V4 generation package '{}' dependency '{}' has no target",
                        current.id, alias
                    )
                });
            }
        }
    }

    if package_ids.contains(alias) {
        return Ok(alias.to_string());
    }

    if let Some(ids) = manifest_name_to_ids.get(alias) {
        if ids.len() == 1 {
            return ids.first().cloned().ok_or_else(|| {
                format!(
                    "Move.lock V4 generation package '{}' dependency '{}' has no target",
                    current.id, alias
                )
            });
        }
    }

    if dependency_name_is_implicit(alias) {
        if let Some(target) = find_implicit_target(alias, package_ids, manifest_name_to_ids) {
            return Ok(target);
        }
    }

    Err(format!(
        "Move.lock V4 generation package '{}' cannot resolve dependency '{}'",
        current.id, alias
    ))
}

fn generated_deps(
    package: &LockfileV4GenerateResolvedPackage,
    all_packages: &[LockfileV4GenerateResolvedPackage],
    package_ids: &BTreeSet<String>,
    manifest_name_to_ids: &BTreeMap<String, Vec<String>>,
) -> Result<BTreeMap<String, String>, String> {
    let mut deps = BTreeMap::new();

    for dependency in &package.combined_dependencies {
        let target = resolve_dependency_target(
            package,
            dependency,
            all_packages,
            package_ids,
            manifest_name_to_ids,
        )?;
        deps.insert(dependency.name.clone(), target);
    }

    Ok(deps)
}

fn format_deps(deps: &BTreeMap<String, String>) -> String {
    if deps.is_empty() {
        return "deps = {}".to_string();
    }

    let parts = deps
        .iter()
        .map(|(alias, target)| format!("{} = {}", alias, toml_string(target)))
        .collect::<Vec<_>>();
    format!("deps = {{ {} }}", parts.join(", "))
}

fn section_environment(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with("[pinned.") || !trimmed.ends_with(']') || trimmed.starts_with("[[") {
        return None;
    }

    let inner = trimmed.trim_start_matches('[').trim_end_matches(']');
    let rest = inner.strip_prefix("pinned.")?;
    rest.split('.').next().map(|value| value.to_string())
}

fn append_other_environment_sections(
    lines: &mut Vec<String>,
    existing_lockfile: &str,
    environment: &str,
) -> Result<(), HelperError> {
    if existing_lockfile.trim().is_empty() {
        return Ok(());
    }

    existing_lockfile.parse::<toml::Value>().map_err(|error| {
        HelperError::with_code(
            "malformed_lockfile",
            format!("Failed to parse existing Move.lock: {}", error),
        )
    })?;

    let mut current_section = vec![];
    let mut in_other_environment = false;

    let flush = |lines: &mut Vec<String>, section: &mut Vec<String>| {
        if !section.is_empty() {
            lines.append(section);
            lines.push(String::new());
        }
    };

    for line in existing_lockfile.lines() {
        if let Some(section_environment) = section_environment(line) {
            if in_other_environment {
                flush(lines, &mut current_section);
            }
            in_other_environment = section_environment != environment;
            current_section = if in_other_environment {
                vec![line.to_string()]
            } else {
                vec![]
            };
            continue;
        }

        if line.trim_start().starts_with('[') {
            if in_other_environment {
                flush(lines, &mut current_section);
            }
            in_other_environment = false;
            current_section.clear();
            continue;
        }

        if in_other_environment {
            current_section.push(line.to_string());
        }
    }

    if in_other_environment {
        flush(lines, &mut current_section);
    }

    Ok(())
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

pub(crate) fn generate(input: LockfileV4GenerateInput) -> Result<String, HelperError> {
    if !matches!(input.root.source, LockfileV4Source::Root) {
        return Err(HelperError::new(
            "Move.lock V4 generation root package must have root source",
        ));
    }

    let mut root_dep_alias_to_package_name = input.root.dep_alias_to_package_name.clone();
    for package in &input.packages {
        for alias in &package.root_dependency_aliases {
            if let Some(existing) = root_dep_alias_to_package_name.get(alias) {
                if existing != &package.id {
                    return Err(HelperError::new(format!(
                        "Move.lock V4 generation root dependency alias '{}' resolves to both '{}' and '{}'",
                        alias, existing, package.id
                    )));
                }
            }
            root_dep_alias_to_package_name.insert(alias.clone(), package.id.clone());
        }
    }

    let mut packages = vec![];
    let root_manifest = manifest_from_files(&input.root.id, &input.root.files, &input.environment)?;
    let root_id = package_graph_id_name(&root_manifest.0);
    packages.push(LockfileV4GenerateResolvedPackage {
        id: root_id,
        source: input.root.source,
        manifest_name: root_manifest.0.name.clone(),
        graph_id_name: package_graph_id_name(&root_manifest.0),
        combined_dependencies: root_manifest.0.combined_dependencies.clone(),
        dep_alias_to_package_name: root_dep_alias_to_package_name,
    });

    for package in input.packages {
        if matches!(package.source, LockfileV4Source::Root) {
            return Err(HelperError::new(format!(
                "Move.lock V4 generation package '{}' has unsupported root source",
                package.id
            )));
        }
        let manifest = manifest_from_files(&package.id, &package.files, &input.environment)?;
        packages.push(LockfileV4GenerateResolvedPackage {
            id: package.id,
            source: package.source,
            manifest_name: manifest.0.name.clone(),
            graph_id_name: package_graph_id_name(&manifest.0),
            combined_dependencies: manifest.0.combined_dependencies.clone(),
            dep_alias_to_package_name: package.dep_alias_to_package_name,
        });
    }

    packages.sort_by(|left, right| left.id.cmp(&right.id));

    let mut package_ids = BTreeSet::new();
    let mut manifest_name_to_ids: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for package in &packages {
        if !package_ids.insert(package.id.clone()) {
            return Err(HelperError::new(format!(
                "Move.lock V4 generation has duplicate package id '{}'",
                package.id
            )));
        }
        manifest_name_to_ids
            .entry(package.manifest_name.clone())
            .or_default()
            .push(package.id.clone());
        if package.graph_id_name != package.manifest_name {
            manifest_name_to_ids
                .entry(package.graph_id_name.clone())
                .or_default()
                .push(package.id.clone());
        }
    }

    let mut lines = vec![
        "# Generated by move; do not edit".to_string(),
        "# This file should be checked in.".to_string(),
        String::new(),
        "[move]".to_string(),
        "version = 4".to_string(),
        String::new(),
    ];

    for package in &packages {
        let is_root = matches!(package.source, LockfileV4Source::Root);
        lines.push(format!("[pinned.{}.{}]", input.environment, package.id));
        lines.push(format_source(&package.source, is_root, &package.id)?);
        lines.push(format!(
            "use_environment = {}",
            toml_string(&input.environment)
        ));
        let digest = manifest_digest::compute_manifest_digest_from_combined(
            package.combined_dependencies.clone(),
        )
        .ok_or_else(|| {
            HelperError::new(format!(
                "Failed to compute manifest_digest for '{}'",
                package.id
            ))
        })?;
        lines.push(format!("manifest_digest = {}", toml_string(&digest)));
        let deps = generated_deps(package, &packages, &package_ids, &manifest_name_to_ids)?;
        lines.push(format_deps(&deps));
        lines.push(String::new());
    }

    if let Some(existing_lockfile) = input.existing_lockfile.as_deref() {
        append_other_environment_sections(&mut lines, existing_lockfile, &input.environment)?;
    }

    Ok(lines.join("\n"))
}
