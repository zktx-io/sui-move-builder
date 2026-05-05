use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Clone, Debug)]
pub(crate) enum CombinedDependencySource {
    Git {
        git: String,
        rev: Option<String>,
        subdir: Option<String>,
    },
    Local {
        local: String,
    },
    System {
        system: String,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct CombinedMoveDependency {
    pub(crate) name: String,
    pub(crate) source: CombinedDependencySource,
    pub(crate) is_override: bool,
    pub(crate) rename_from: Option<String>,
    pub(crate) modes: Option<Vec<String>>,
    pub(crate) use_environment: String,
    pub(crate) address_override: Option<PublishAddressesDigest>,
    pub(crate) package_hint: Option<String>,
    pub(crate) subst: Option<BTreeMap<String, ManifestPackagePlanSubst>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct PublishAddressesDigest {
    published_at: String,
    original_id: String,
}

impl PublishAddressesDigest {
    pub(in crate::manifest_digest) fn new(published_at: String, original_id: String) -> Self {
        Self {
            published_at,
            original_id,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ManifestPackagePlanSubst {
    Assign { address: String },
    RenameFrom { name: String },
}

pub(crate) fn combined_dependency_matches_modes(
    dep: &CombinedMoveDependency,
    modes: &[String],
) -> bool {
    dep.modes
        .as_ref()
        .map(|dep_modes| {
            dep_modes
                .iter()
                .any(|dep_mode| modes.iter().any(|mode| mode == dep_mode))
        })
        .unwrap_or(true)
}
