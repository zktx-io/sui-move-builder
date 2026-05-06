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

pub(super) struct LockfileV4GenerateResolvedPackage {
    pub(super) id: String,
    pub(super) source: LockfileV4Source,
    pub(super) manifest_name: String,
    pub(super) graph_id_name: String,
    pub(super) combined_dependencies: Vec<CombinedMoveDependency>,
    pub(super) dep_alias_to_package_name: BTreeMap<String, String>,
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
