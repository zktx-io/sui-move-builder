use crate::helper::{self, HelperError};
use crate::manifest_digest::{self, CombinedDependencySource, CombinedMoveDependency};
use crate::package_model::dependency_name_is_implicit;
use crate::stage_report::StageReport;
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

fn validate_graph_impl(input: &LockfileV4ValidateInput) -> LockfileV4ValidationResult {
    let mut root_ids = vec![];
    let mut package_ids = BTreeSet::new();
    for package in &input.packages {
        if matches!(package.source, LockfileV4Source::Root) {
            root_ids.push(package.id.clone());
        }
        package_ids.insert(package.id.clone());
    }
    if root_ids.is_empty() {
        return LockfileV4ValidationResult::Error(format!(
            "Move.lock V4 pinned.{} has no root package entry",
            input.environment
        ));
    }
    if root_ids.len() > 1 {
        return LockfileV4ValidationResult::Error(format!(
            "Move.lock V4 pinned.{} has multiple root package entries",
            input.environment
        ));
    }
    let root_id = root_ids[0].clone();

    let mut validated_packages = vec![];
    let mut edges = vec![];
    let mut lockfile_order = vec![];

    for package in &input.packages {
        lockfile_order.push(package.id.clone());

        let files = if matches!(package.source, LockfileV4Source::Root) {
            let mut root_files = package.files.clone();
            root_files
                .entry("Move.toml".to_string())
                .or_insert_with(|| input.root_move_toml.clone());
            root_files
        } else {
            package.files.clone()
        };

        let (manifest, _move_toml) =
            match manifest_from_files(&package.id, &files, &input.environment) {
                Ok(result) => result,
                Err(error) => return LockfileV4ValidationResult::Error(error),
            };
        if let Err(error) = validate_manifest_dependency_names(&manifest) {
            return LockfileV4ValidationResult::Error(error);
        }

        if let Some(expected_digest) = package.manifest_digest.as_ref() {
            let current_digest = manifest_digest::compute_manifest_digest_from_combined(
                manifest.combined_dependencies.clone(),
            )
            .unwrap_or_default();
            if !current_digest.eq_ignore_ascii_case(expected_digest) {
                return LockfileV4ValidationResult::OutOfDate(package.id.clone());
            }
        } else {
            return LockfileV4ValidationResult::OutOfDate(package.id.clone());
        }

        let lockfile_deps = manifest
            .combined_dependencies
            .iter()
            .map(|dep| dep.name.clone())
            .collect::<BTreeSet<_>>();
        for alias in &lockfile_deps {
            if !package.deps.contains_key(alias) {
                return LockfileV4ValidationResult::Error(format!(
                    "Move.lock V4 pinned.{}.{} is missing dependency '{}'",
                    input.environment, package.id, alias
                ));
            }
        }

        let dep_modes_by_alias = manifest
            .combined_dependencies
            .iter()
            .map(|dep| (dep.name.clone(), dep.modes.clone().unwrap_or_default()))
            .collect::<BTreeMap<_, _>>();
        let dep_override_by_alias = manifest
            .combined_dependencies
            .iter()
            .map(|dep| (dep.name.clone(), dep.is_override))
            .collect::<BTreeMap<_, _>>();
        let active_aliases = manifest
            .combined_dependencies
            .iter()
            .filter(|dep| manifest_digest::combined_dependency_matches_modes(dep, &input.modes))
            .map(|dep| dep.name.clone())
            .collect::<BTreeSet<_>>();
        let lockfile_dep_map = package
            .deps
            .iter()
            .filter(|(alias, _)| lockfile_deps.contains(*alias))
            .map(|(alias, target_id)| (alias.clone(), target_id.clone()))
            .collect::<BTreeMap<_, _>>();

        for (alias, target_id) in &lockfile_dep_map {
            if !package_ids.contains(target_id) {
                return LockfileV4ValidationResult::Error(format!(
                    "Move.lock V4 pinned.{}.{} references undefined dependency '{}'",
                    input.environment, package.id, target_id
                ));
            }
            if active_aliases.contains(alias) {
                edges.push(LockfileV4ValidatedEdge {
                    from: package.id.clone(),
                    to: target_id.clone(),
                    alias: alias.clone(),
                    modes: dep_modes_by_alias.get(alias).cloned().unwrap_or_default(),
                    is_override: dep_override_by_alias.get(alias).copied().unwrap_or(false),
                });
            }
        }
        let active_dep_map = lockfile_dep_map
            .iter()
            .filter(|(alias, _)| active_aliases.contains(*alias))
            .map(|(alias, target_id)| (alias.clone(), target_id.clone()))
            .collect::<BTreeMap<_, _>>();

        validated_packages.push(LockfileV4ValidatedPackage {
            id: package.id.clone(),
            source: package.source.clone(),
            manifest,
            dep_alias_to_package_name: lockfile_dep_map,
            active_dep_alias_to_package_name: active_dep_map,
        });
    }

    let graph_for_validation = LockfileV4ValidatedGraph {
        root_id: root_id.clone(),
        lockfile_order: lockfile_order.clone(),
        packages: validated_packages.clone(),
        edges: edges.clone(),
    };
    if let Err(error) = validate_root_graph_edges(&graph_for_validation) {
        return LockfileV4ValidationResult::Error(error);
    }

    let graph = LockfileV4ValidatedGraph {
        root_id,
        lockfile_order,
        packages: validated_packages,
        edges,
    };

    LockfileV4ValidationResult::Ok(graph)
}

pub(crate) fn validate_manifest_dependency_names(
    manifest: &LockfileV4PackageManifest,
) -> Result<(), String> {
    if manifest.is_legacy {
        return Ok(());
    }

    for name in manifest
        .combined_dependencies
        .iter()
        .map(|dependency| dependency.name.as_str())
    {
        if manifest_digest::is_legacy_system_dep_name(&name) {
            return Err(format!(
                "Dependency `{}` is a legacy system name and cannot be used. See https://docs.sui.io/guides/developer/sui-101/move-package-management#system-dependencies",
                name
            ));
        }
    }
    Ok(())
}

fn combined_dependency_by_name<'a>(
    manifest: &'a LockfileV4PackageManifest,
    alias: &str,
) -> Option<&'a CombinedMoveDependency> {
    manifest
        .combined_dependencies
        .iter()
        .find(|dependency| dependency.name == alias)
}

fn validate_root_graph_edges(graph: &LockfileV4ValidatedGraph) -> Result<(), String> {
    let packages_by_id = packages_by_id(graph);
    let root = packages_by_id.get(&graph.root_id).ok_or_else(|| {
        format!(
            "Move.lock V4 graph is missing root package '{}'",
            graph.root_id
        )
    })?;

    if root.manifest.is_legacy {
        for (alias, target_id) in &root.dep_alias_to_package_name {
            let target = packages_by_id
                .get(target_id)
                .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", target_id))?;
            if !target.manifest.is_legacy {
                return Err(
                    "Packages with old-style Move.toml files cannot depend on new-style packages. See https://docs.sui.io/references/package-managers/package-manager-migration for instructions."
                        .to_string(),
                );
            }
            let actual_dep_name = target.manifest.name.as_str();
            if alias == actual_dep_name {
                continue;
            }
            if target
                .manifest
                .legacy_name
                .as_deref()
                .map(manifest_digest::normalize_legacy_name_to_identifier)
                .is_some_and(|legacy_name| legacy_name == *alias)
            {
                continue;
            }
            return Err(format!(
                "Dependency '{}' does not match package name '{}'",
                alias, actual_dep_name
            ));
        }
        return Ok(());
    }

    for (alias, target_id) in &root.dep_alias_to_package_name {
        let target = packages_by_id
            .get(target_id)
            .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", target_id))?;
        let local_dep_name = alias.as_str();
        let actual_dep_name = target.manifest.name.as_str();
        let rename_from = combined_dependency_by_name(&root.manifest, local_dep_name)
            .and_then(|dependency| dependency.rename_from.as_deref());

        if let Some(rename_from) = rename_from {
            if local_dep_name == actual_dep_name {
                return Err(format!(
                    "Dependency '{}' specifies rename-from but already matches package name '{}'",
                    local_dep_name, actual_dep_name
                ));
            }
            if rename_from != actual_dep_name {
                return Err(format!(
                    "Dependency '{}' specifies rename-from '{}' but target package name is '{}'",
                    local_dep_name, rename_from, actual_dep_name
                ));
            }
        } else if local_dep_name != actual_dep_name {
            return Err(format!(
                "Dependency '{}' does not match package name '{}'",
                local_dep_name, actual_dep_name
            ));
        }
    }

    Ok(())
}

fn package_compile_id(package_id: &str, manifest: &LockfileV4PackageManifest) -> Option<String> {
    manifest
        .original_id
        .clone()
        .or_else(|| manifest.published_at.clone())
        .or_else(|| manifest.addresses.get(&manifest.name).cloned())
        .or_else(|| manifest.addresses.get(package_id).cloned())
}

fn package_output_id(package_id: &str, manifest: &LockfileV4PackageManifest) -> Option<String> {
    manifest
        .latest_published_id
        .clone()
        .or_else(|| manifest.published_at.clone())
        .or_else(|| manifest.original_id.clone())
        .or_else(|| package_compile_id(package_id, manifest))
}

fn compiler_files(
    files: &BTreeMap<String, String>,
    environment: &str,
    prefix: Option<&str>,
) -> BTreeMap<String, String> {
    let selected_move_toml = find_move_toml(files, environment).map(str::to_string);
    let mut output = BTreeMap::new();

    for (path, content) in files {
        let file_name = path.rsplit(['/', '\\']).next().unwrap_or(path.as_str());
        let is_manifest = file_name == "Move.toml"
            || (file_name.starts_with("Move.")
                && file_name.ends_with(".toml")
                && file_name.matches('.').count() == 2);
        if file_name == "Move.lock" || is_manifest {
            continue;
        }

        let output_path = match prefix {
            Some(prefix) => format!(
                "{}/{}",
                prefix.trim_end_matches('/'),
                path.trim_start_matches('/')
            ),
            None => path.clone(),
        };
        output.insert(output_path, content.clone());
    }

    if let Some(move_toml) = selected_move_toml {
        let output_path = match prefix {
            Some(prefix) => format!("{}/Move.toml", prefix.trim_end_matches('/')),
            None => "Move.toml".to_string(),
        };
        output.insert(output_path, move_toml);
    }

    output
}

fn move_toml_with_addresses(move_toml: &str, addresses: &BTreeMap<String, String>) -> String {
    let Ok(mut value) = move_toml.parse::<toml::Value>() else {
        return move_toml.to_string();
    };
    let Some(table) = value.as_table_mut() else {
        return move_toml.to_string();
    };
    let entry = table
        .entry("addresses".to_string())
        .or_insert_with(|| toml::Value::Table(toml::value::Table::new()));
    let Some(address_table) = entry.as_table_mut() else {
        return move_toml.to_string();
    };
    for (name, address) in addresses {
        address_table.insert(name.clone(), toml::Value::String(address.clone()));
    }
    toml::to_string(&value).unwrap_or_else(|_| move_toml.to_string())
}

fn normalize_nonzero_address(value: &str) -> Option<String> {
    let normalized = crate::normalize_hex_address_string(value)?;
    if normalized == "0x0000000000000000000000000000000000000000000000000000000000000000" {
        None
    } else {
        Some(normalized)
    }
}

#[derive(Clone)]
struct LinkageConflict {
    depth: usize,
    node: String,
    conflict: String,
}

#[derive(Default)]
struct LinkageTraversal {
    linkage: BTreeMap<String, (usize, String)>,
    best_conflict: Option<LinkageConflict>,
}

fn package_linkage_id(package: &LockfileV4ValidatedPackage) -> String {
    package
        .manifest
        .original_id
        .as_deref()
        .and_then(normalize_nonzero_address)
        .or_else(|| {
            package
                .manifest
                .published_at
                .as_deref()
                .and_then(normalize_nonzero_address)
        })
        .or_else(|| {
            package
                .manifest
                .latest_published_id
                .as_deref()
                .and_then(normalize_nonzero_address)
        })
        .unwrap_or_else(|| format!("unpublished:{}", package.id))
}

fn packages_by_id(
    graph: &LockfileV4ValidatedGraph,
) -> BTreeMap<String, &LockfileV4ValidatedPackage> {
    graph
        .packages
        .iter()
        .map(|package| (package.id.clone(), package))
        .collect()
}

fn edges_by_from(
    edges: &[LockfileV4ValidatedEdge],
) -> BTreeMap<String, Vec<LockfileV4ValidatedEdge>> {
    let mut edges_by_from: BTreeMap<String, Vec<LockfileV4ValidatedEdge>> = BTreeMap::new();
    for edge in edges {
        edges_by_from
            .entry(edge.from.clone())
            .or_default()
            .push(edge.clone());
    }
    for edges in edges_by_from.values_mut() {
        edges.sort_by(|left, right| {
            left.alias
                .cmp(&right.alias)
                .then_with(|| left.to.cmp(&right.to))
        });
    }
    edges_by_from
}

fn check_linkage_cycles(
    id: &str,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
    path: &mut Vec<String>,
    seen: &mut BTreeMap<String, usize>,
) -> Result<(), String> {
    let package = packages_by_id
        .get(id)
        .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", id))?;
    let original_id = package_linkage_id(package);
    let self_index = path.len();
    path.push(id.to_string());

    if let Some(old_index) = seen.insert(original_id.clone(), self_index) {
        let cycle = path[old_index..].join(" -> ");
        return Err(format!(
            "Move.lock V4 linkage dependency cycle detected: {} -> {}",
            cycle, id
        ));
    }

    if let Some(edges) = edges_by_from.get(id) {
        for edge in edges {
            check_linkage_cycles(&edge.to, packages_by_id, edges_by_from, path, seen)?;
        }
    }

    seen.remove(&original_id);
    path.pop();
    Ok(())
}

fn direct_overrides(
    id: &str,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
) -> Result<BTreeMap<String, String>, String> {
    let mut overrides = BTreeMap::<String, (String, String)>::new();
    for edge in edges_by_from.get(id).into_iter().flatten() {
        if !edge.is_override {
            continue;
        }
        let target = packages_by_id
            .get(&edge.to)
            .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", edge.to))?;
        let original_id = package_linkage_id(target);
        match overrides.get(&original_id) {
            Some((_, existing_id)) if existing_id != &edge.to => {
                return Err(format!(
                    "Move.lock V4 package '{}' has override dependencies that both resolve to package ID {}",
                    id, original_id
                ));
            }
            Some(_) => {}
            None => {
                overrides.insert(original_id, (edge.alias.clone(), edge.to.clone()));
            }
        }
    }

    Ok(overrides
        .into_iter()
        .map(|(original_id, (_, package_id))| (original_id, package_id))
        .collect())
}

fn min_conflict(
    left: Option<LinkageConflict>,
    right: Option<LinkageConflict>,
) -> Option<LinkageConflict> {
    match (left, right) {
        (None, right) => right,
        (left, None) => left,
        (Some(left), Some(right)) => Some(if left.depth <= right.depth {
            left
        } else {
            right
        }),
    }
}

fn linkage_ignoring_overrides(
    id: &str,
    overrides: &BTreeMap<String, String>,
    depth: usize,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
) -> Result<LinkageTraversal, String> {
    let package = packages_by_id
        .get(id)
        .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", id))?;

    let mut local_overrides = direct_overrides(id, packages_by_id, edges_by_from)?;
    for (original_id, package_id) in overrides {
        local_overrides.insert(original_id.clone(), package_id.clone());
    }

    let mut result = LinkageTraversal::default();
    for edge in edges_by_from.get(id).into_iter().flatten() {
        let target = packages_by_id
            .get(&edge.to)
            .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", edge.to))?;
        if overrides.contains_key(&package_linkage_id(target)) {
            continue;
        }

        let child = linkage_ignoring_overrides(
            &edge.to,
            &local_overrides,
            depth + 1,
            packages_by_id,
            edges_by_from,
        )?;
        result.best_conflict = min_conflict(result.best_conflict, child.best_conflict);

        for (original_id, (new_depth, new_id)) in child.linkage {
            match result.linkage.get(&original_id).cloned() {
                None => {
                    result.linkage.insert(original_id, (new_depth, new_id));
                }
                Some((old_depth, old_id)) => {
                    let (min_depth, min_id, other_id) = if new_depth < old_depth {
                        (new_depth, new_id.clone(), old_id.clone())
                    } else {
                        (old_depth, old_id.clone(), new_id.clone())
                    };
                    if old_id != new_id {
                        result.best_conflict = min_conflict(
                            result.best_conflict,
                            Some(LinkageConflict {
                                depth: min_depth,
                                node: min_id.clone(),
                                conflict: other_id,
                            }),
                        );
                    }
                    result.linkage.insert(original_id, (min_depth, min_id));
                }
            }
        }
    }

    result
        .linkage
        .insert(package_linkage_id(package), (depth, id.to_string()));
    Ok(result)
}

fn linkage_table(graph: &LockfileV4ValidatedGraph) -> Result<BTreeMap<String, String>, String> {
    let packages_by_id = packages_by_id(graph);
    let edges_by_from = edges_by_from(&graph.edges);
    check_linkage_cycles(
        &graph.root_id,
        &packages_by_id,
        &edges_by_from,
        &mut Vec::new(),
        &mut BTreeMap::new(),
    )?;

    let traversal = linkage_ignoring_overrides(
        &graph.root_id,
        &BTreeMap::new(),
        0,
        &packages_by_id,
        &edges_by_from,
    )?;
    if let Some(conflict) = traversal.best_conflict {
        return Err(format!(
            "Move.lock V4 linkage depends on multiple versions of package ID {} through '{}' and '{}'",
            package_linkage_id(
                packages_by_id.get(&conflict.node).ok_or_else(|| {
                    format!(
                        "Move.lock V4 linkage has unknown package '{}'",
                        conflict.node
                    )
                })?
            ),
            conflict.node,
            conflict.conflict
        ));
    }

    Ok(traversal
        .linkage
        .into_iter()
        .map(|(original_id, (_, package_id))| (original_id, package_id))
        .collect())
}

fn linked_graph(graph: &LockfileV4ValidatedGraph) -> Result<LockfileV4ValidatedGraph, String> {
    let packages_by_id = packages_by_id(graph);
    let linkage = linkage_table(graph)?;
    let linked_ids = linkage.values().cloned().collect::<BTreeSet<_>>();

    let mut packages = graph
        .packages
        .iter()
        .filter(|package| linked_ids.contains(&package.id))
        .cloned()
        .collect::<Vec<_>>();
    packages.sort_by(|left, right| {
        left.manifest
            .name
            .cmp(&right.manifest.name)
            .then_with(|| left.id.cmp(&right.id))
    });

    let package_ids = packages
        .iter()
        .map(|package| package.id.clone())
        .collect::<BTreeSet<_>>();
    let mut edge_keys = BTreeSet::new();
    let mut edges = Vec::new();
    for edge in &graph.edges {
        if !package_ids.contains(&edge.from) {
            continue;
        }
        let Some(target_package) = packages_by_id.get(&edge.to) else {
            return Err(format!(
                "Move.lock V4 linkage has unknown package '{}'",
                edge.to
            ));
        };
        let target_original_id = package_linkage_id(target_package);
        let Some(linked_target) = linkage.get(&target_original_id) else {
            continue;
        };
        if !package_ids.contains(linked_target) {
            continue;
        }
        let key = (
            edge.from.clone(),
            linked_target.clone(),
            edge.alias.clone(),
            edge.modes.clone(),
            edge.is_override,
        );
        if edge_keys.insert(key) {
            edges.push(LockfileV4ValidatedEdge {
                from: edge.from.clone(),
                to: linked_target.clone(),
                alias: edge.alias.clone(),
                modes: edge.modes.clone(),
                is_override: edge.is_override,
            });
        }
    }
    let active_aliases_by_from = edges.iter().fold(
        BTreeMap::<String, BTreeMap<String, String>>::new(),
        |mut acc, edge| {
            acc.entry(edge.from.clone())
                .or_default()
                .insert(edge.alias.clone(), edge.to.clone());
            acc
        },
    );
    for package in &mut packages {
        package.active_dep_alias_to_package_name = active_aliases_by_from
            .get(&package.id)
            .cloned()
            .unwrap_or_default();
    }

    Ok(LockfileV4ValidatedGraph {
        root_id: graph.root_id.clone(),
        lockfile_order: packages.iter().map(|package| package.id.clone()).collect(),
        packages,
        edges,
    })
}

fn insert_named_address(
    mapping: &mut BTreeMap<String, String>,
    name: &str,
    address: &str,
    package_id: &str,
) -> Result<(), String> {
    if !crate::is_move_named_address(name) {
        return Ok(());
    }
    let normalized =
        crate::normalize_hex_address_string(address).unwrap_or_else(|| address.to_string());
    if let Some(existing) = mapping.get(name) {
        let existing_normalized =
            crate::normalize_hex_address_string(existing).unwrap_or_else(|| existing.clone());
        if existing_normalized != normalized {
            return Err(format!(
                "Move.lock V4 package '{}' has duplicate named address '{}'",
                package_id, name
            ));
        }
    }
    mapping.insert(name.to_string(), normalized);
    Ok(())
}

fn package_is_legacy(package: &LockfileV4ValidatedPackage) -> bool {
    package.manifest.is_legacy
}

fn package_node_address(package: &LockfileV4ValidatedPackage) -> Option<String> {
    package_compile_id(&package.id, &package.manifest)
        .and_then(|address| crate::normalize_hex_address_string(&address))
}

fn package_named_address_value(package: &LockfileV4ValidatedPackage) -> String {
    package_node_address(package).unwrap_or_else(|| "_".to_string())
}

fn named_addresses_for_package(
    package_id: &str,
    graph: &LockfileV4ValidatedGraph,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
    visiting: &mut BTreeSet<String>,
) -> Result<BTreeMap<String, String>, String> {
    let package = packages_by_id
        .get(package_id)
        .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", package_id))?;
    let mut mapping = BTreeMap::new();

    if package_is_legacy(package) {
        if package.manifest.name != NO_NAME_LEGACY_PACKAGE_NAME {
            insert_named_address(
                &mut mapping,
                &package.manifest.name,
                &package_named_address_value(package),
                package_id,
            )?;
        }

        if !visiting.insert(package_id.to_string()) {
            return Err(format!(
                "Move.lock V4 package '{}' has recursive legacy named addresses",
                package_id
            ));
        }
        for edge in edges_by_from.get(package_id).into_iter().flatten() {
            let child_mapping = named_addresses_for_package(
                &edge.to,
                graph,
                packages_by_id,
                edges_by_from,
                visiting,
            )?;
            for (name, address) in child_mapping {
                insert_named_address(&mut mapping, &name, &address, package_id)?;
            }
        }
        visiting.remove(package_id);

        for (name, address) in package
            .manifest
            .addresses
            .iter()
            .filter(|(name, _)| *name != &package.manifest.name)
        {
            insert_named_address(&mut mapping, name, address, package_id)?;
        }
    } else {
        for edge in edges_by_from.get(package_id).into_iter().flatten() {
            let target = packages_by_id
                .get(&edge.to)
                .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", edge.to))?;
            insert_named_address(
                &mut mapping,
                &edge.alias,
                &package_named_address_value(target),
                package_id,
            )?;
        }
        insert_named_address(
            &mut mapping,
            &package.manifest.name,
            &package_named_address_value(package),
            package_id,
        )?;
    }

    Ok(mapping)
}

pub(crate) fn package_groups_from_validated_with_orders(
    input: &LockfileV4ValidateInput,
    graph: LockfileV4ValidatedGraph,
    lockfile_order: &[String],
) -> Result<LockfileV4PackageGroups, String> {
    let linked_graph = linked_graph(&graph)?;
    let packages_by_id_map = graph
        .packages
        .iter()
        .map(|package| (package.id.clone(), package))
        .collect::<BTreeMap<_, _>>();
    let linked_packages_by_id = packages_by_id(&linked_graph);
    let linked_edges_by_from = edges_by_from(&linked_graph.edges);
    let input_by_id = input
        .packages
        .iter()
        .map(|package| (package.id.clone(), package))
        .collect::<BTreeMap<_, _>>();

    let _root_package = linked_packages_by_id
        .get(&linked_graph.root_id)
        .ok_or_else(|| {
            format!(
                "Move.lock V4 graph is missing root package '{}'",
                linked_graph.root_id
            )
        })?;
    let root_input = input_by_id.get(&graph.root_id).ok_or_else(|| {
        format!(
            "Move.lock V4 input is missing root package '{}'",
            graph.root_id
        )
    })?;
    let mut root_input_files = root_input.files.clone();
    root_input_files
        .entry("Move.toml".to_string())
        .or_insert_with(|| input.root_move_toml.clone());

    let root_address_mapping = named_addresses_for_package(
        &linked_graph.root_id,
        &linked_graph,
        &linked_packages_by_id,
        &linked_edges_by_from,
        &mut BTreeSet::new(),
    )?;

    let mut root_files = compiler_files(&root_input_files, &input.environment, None);
    if let Some(root_move_toml) = root_files.get("Move.toml").cloned() {
        root_files.insert(
            "Move.toml".to_string(),
            move_toml_with_addresses(&root_move_toml, &root_address_mapping),
        );
    }

    let mut root_aliases_by_target: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in linked_graph
        .edges
        .iter()
        .filter(|edge| edge.from == linked_graph.root_id)
    {
        root_aliases_by_target
            .entry(edge.to.clone())
            .or_default()
            .push(edge.alias.clone());
    }
    for aliases in root_aliases_by_target.values_mut() {
        aliases.sort();
    }

    let mut groups_by_id = BTreeMap::new();
    let mut active_groups_by_id = BTreeMap::new();

    for package_id in graph
        .lockfile_order
        .iter()
        .filter(|package_id| *package_id != &graph.root_id)
    {
        let package = packages_by_id_map
            .get(package_id)
            .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", package_id))?;
        let input_package = input_by_id
            .get(package_id)
            .ok_or_else(|| format!("Move.lock V4 input has no files for '{}'", package_id))?;
        let prefix = format!("dependencies/{}", package.id);
        let files = compiler_files(
            &input_package.files,
            &input.environment,
            Some(prefix.as_str()),
        );

        let address_mapping = if linked_packages_by_id.contains_key(package_id) {
            named_addresses_for_package(
                package_id,
                &linked_graph,
                &linked_packages_by_id,
                &linked_edges_by_from,
                &mut BTreeSet::new(),
            )?
        } else {
            package.manifest.addresses.clone()
        };

        let group = LockfileV4PackageGroup {
            name: package.id.clone(),
            display_name: package
                .manifest
                .legacy_name
                .clone()
                .unwrap_or_else(|| package.manifest.name.clone()),
            files,
            edition: package.manifest.edition.clone(),
            address_mapping,
            published_id_for_output: package_output_id(&package.id, &package.manifest),
            source: package.source.clone(),
            manifest_deps: manifest_dep_names(&package.manifest),
            manifest: LockfileV4PackageGroupManifest {
                name: package.manifest.name.clone(),
                dependencies: package.manifest.dependencies.clone(),
            },
            dep_alias_to_package_name: package.dep_alias_to_package_name.clone(),
            root_dependency_aliases: root_aliases_by_target
                .get(package_id)
                .cloned()
                .unwrap_or_default(),
        };
        let mut active_group = group.clone();
        if let Some(linked_package) = linked_packages_by_id.get(package_id) {
            active_group.dep_alias_to_package_name =
                linked_package.active_dep_alias_to_package_name.clone();
        } else {
            active_group.dep_alias_to_package_name.clear();
        }
        active_groups_by_id.insert(package.id.clone(), active_group);
        groups_by_id.insert(package.id.clone(), group);
    }

    let dependencies = linked_graph
        .lockfile_order
        .iter()
        .filter(|package_id| *package_id != &linked_graph.root_id)
        .filter_map(|package_id| active_groups_by_id.get(package_id).cloned())
        .collect::<Vec<_>>();
    let lockfile_dependencies = lockfile_order
        .iter()
        .filter(|package_id| *package_id != &graph.root_id)
        .filter_map(|package_id| groups_by_id.get(package_id).cloned())
        .collect::<Vec<_>>();

    Ok(LockfileV4PackageGroups {
        root_files,
        dependencies,
        lockfile_dependencies,
    })
}

fn package_groups_from_validated(
    input: &LockfileV4ValidateInput,
    graph: LockfileV4ValidatedGraph,
) -> Result<LockfileV4PackageGroups, String> {
    let order = graph.lockfile_order.clone();
    package_groups_from_validated_with_orders(input, graph, &order)
}

fn edge_matches_modes(edge: &LockfileV4ValidatedEdge, modes: &[String]) -> bool {
    edge.modes.is_empty()
        || edge
            .modes
            .iter()
            .any(|dep_mode| modes.iter().any(|mode| mode == dep_mode))
}

pub(crate) fn active_edges(
    edges: &[LockfileV4ValidatedEdge],
    modes: &[String],
) -> Vec<LockfileV4ValidatedEdge> {
    edges
        .iter()
        .filter(|edge| edge_matches_modes(edge, modes))
        .cloned()
        .collect()
}

fn out_of_date(package_id: impl Into<String>) -> String {
    serde_json::json!({
        "status": "out_of_date",
        "code": "lockfile_out_of_date",
        "reason": "out_of_date",
        "packageId": package_id.into(),
    })
    .to_string()
}

fn missing(reason: impl Into<String>) -> String {
    serde_json::json!({
        "status": "missing",
        "reason": reason.into(),
    })
    .to_string()
}

pub(crate) fn fetch_plan_json(move_lock_toml: &str, environment: &str) -> String {
    match plan_from_toml(move_lock_toml, environment) {
        Ok(Some((root_id, lockfile_order, packages))) => {
            let stage_reports = vec![StageReport::new("move_lock_fetch_plan", environment, &[])
                .package_id(root_id.clone())
                .node_count(packages.len())];
            serde_json::json!({
                "status": "ok",
                "rootId": root_id,
                "lockfileOrder": lockfile_order,
                "packages": packages,
                "stageReports": stage_reports,
            })
            .to_string()
        }
        Ok(None) => missing(format!(
            "Move.lock V4 has no pinned.{} section",
            environment
        )),
        Err(error) => helper::error_from_helper(error),
    }
}

#[cfg(not(feature = "verification"))]
pub(crate) fn generate_json(input_json: &str) -> String {
    let input: LockfileV4GenerateInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return helper::error_with_code(
                "invalid_helper_input",
                format!("Invalid lockfile V4 generation input: {}", error),
            );
        }
    };

    match generate(input) {
        Ok(lockfile) => serde_json::json!({
            "status": "ok",
            "lockfile": lockfile,
        })
        .to_string(),
        Err(error) => helper::error_from_helper(error),
    }
}

fn validate_graph_response(input: LockfileV4ValidateInput) -> String {
    let graph = match validate_graph_impl(&input) {
        LockfileV4ValidationResult::Ok(graph) => graph,
        LockfileV4ValidationResult::OutOfDate(package_id) => return out_of_date(package_id),
        LockfileV4ValidationResult::Error(error) => return helper::error(error),
    };

    serde_json::json!({
        "status": "ok",
        "graph": graph,
    })
    .to_string()
}

#[cfg(not(feature = "verification"))]
pub(crate) fn validate_graph_json(input_json: &str) -> String {
    let input: LockfileV4ValidateInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return helper::error_with_code(
                "invalid_helper_input",
                format!("Invalid lockfile V4 validation input: {}", error),
            );
        }
    };

    validate_graph_response(input)
}

fn resolve_package_groups_response(input: LockfileV4ValidateInput) -> String {
    let graph = match validate_graph_impl(&input) {
        LockfileV4ValidationResult::Ok(graph) => graph,
        LockfileV4ValidationResult::OutOfDate(package_id) => return out_of_date(package_id),
        LockfileV4ValidationResult::Error(error) => return helper::error(error),
    };

    let active_edge_count = graph
        .edges
        .iter()
        .filter(|edge| edge_matches_modes(edge, &input.modes))
        .count();
    let stage_reports = vec![
        StageReport::new("move_lock_graph", &input.environment, &input.modes)
            .package_id(graph.root_id.clone())
            .node_count(graph.packages.len())
            .edge_count(graph.edges.len())
            .active_edge_count(active_edge_count),
    ];
    match package_groups_from_validated(&input, graph) {
        Ok(groups) => {
            let mut reports = stage_reports;
            reports.push(
                StageReport::new("move_lock_linkage", &input.environment, &input.modes)
                    .linked_node_count(groups.dependencies.len()),
            );
            serde_json::json!({
                "status": "ok",
                "rootFiles": groups.root_files,
                "dependencies": groups.dependencies,
                "lockfileDependencies": groups.lockfile_dependencies,
                "stageReports": reports,
            })
            .to_string()
        }
        Err(error) => helper::error(error),
    }
}

#[cfg(feature = "verification")]
pub(crate) fn resolve_package_groups_from_value(input: serde_json::Value) -> String {
    let input: LockfileV4ValidateInput = match serde_json::from_value(input) {
        Ok(input) => input,
        Err(error) => {
            return helper::error_with_code(
                "invalid_helper_input",
                format!("Invalid lockfile V4 package-group input: {}", error),
            );
        }
    };

    resolve_package_groups_response(input)
}

#[cfg(not(feature = "verification"))]
pub(crate) fn resolve_package_groups_json(input_json: &str) -> String {
    let input: LockfileV4ValidateInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return helper::error_with_code(
                "invalid_helper_input",
                format!("Invalid lockfile V4 package-group input: {}", error),
            );
        }
    };

    resolve_package_groups_response(input)
}
