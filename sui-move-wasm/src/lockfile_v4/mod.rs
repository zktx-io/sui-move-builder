use crate::helper::HelperError;
use crate::manifest_digest::CombinedMoveDependency;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
