use crate::lockfile_v4::{LockfileV4PackageManifest, LockfileV4Source};
use crate::manifest_digest::ManifestPackagePlanSubst;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ManifestPackagePlanDependency {
    pub(super) name: String,
    pub(super) source: ManifestPackagePlanSource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) modes: Vec<String>,
    #[serde(
        rename = "isOverride",
        default,
        skip_serializing_if = "manifest_plan_is_false"
    )]
    pub(super) is_override: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) subst: Option<BTreeMap<String, ManifestPackagePlanSubst>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum ManifestPackagePlanSource {
    Git {
        git: String,
        rev: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
        #[serde(rename = "isImplicit", skip_serializing_if = "manifest_plan_is_false")]
        is_implicit: bool,
    },
    Local {
        local: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ManifestGraphInput {
    pub(super) environment: String,
    #[serde(default)]
    pub(super) framework_rev: Option<String>,
    #[serde(default)]
    pub(super) modes: Vec<String>,
    pub(super) root: ManifestGraphPackageSnapshot,
    #[serde(default)]
    pub(super) packages: Vec<ManifestGraphPackageSnapshot>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ManifestGraphPackageSnapshot {
    pub(super) source: LockfileV4Source,
    #[serde(default)]
    pub(super) requested_source: Option<LockfileV4Source>,
    #[serde(default)]
    pub(super) files: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ManifestGraphFetchRequest {
    pub(super) source: LockfileV4Source,
    pub(super) dependency_name: String,
    pub(super) parent_package_name: String,
    pub(super) parent_source: LockfileV4Source,
}

pub(super) struct ManifestGraphNode {
    pub(super) id: String,
    pub(super) source: LockfileV4Source,
    pub(super) files: BTreeMap<String, String>,
    pub(super) manifest: LockfileV4PackageManifest,
    pub(super) dep_alias_to_package_name: BTreeMap<String, String>,
}

fn manifest_plan_is_false(value: &bool) -> bool {
    !*value
}
