use std::collections::BTreeMap;

#[cfg(not(feature = "verification"))]
use serde::Deserialize;
use serde::Serialize;

#[cfg(not(feature = "verification"))]
use super::toml_parse::combined_dependencies_from_move_toml;
use super::types::{CombinedDependencySource, CombinedMoveDependency, PublishAddressesDigest};

#[cfg(not(feature = "verification"))]
#[derive(Clone, Debug, Deserialize)]
struct DigestDepInfo {
    name: String,
    #[serde(default)]
    git: Option<String>,
    #[serde(default)]
    subdir: Option<String>,
    #[serde(default)]
    rev: Option<String>,
    #[serde(default)]
    local: Option<String>,
    #[serde(default)]
    system: Option<String>,
    #[serde(default)]
    is_override: Option<bool>,
    #[serde(default)]
    use_environment: Option<String>,
    #[serde(default)]
    rename_from: Option<String>,
    #[serde(default)]
    modes: Option<Vec<String>>,
}

#[derive(Serialize)]
struct ManifestGitDependency {
    #[serde(rename = "git")]
    repo: String,
    #[serde(default)]
    rev: Option<String>,
    #[serde(default)]
    subdir: std::path::PathBuf,
}

#[derive(Serialize)]
struct LocalDepInfo {
    local: std::path::PathBuf,
}

#[derive(Serialize)]
struct SystemDependency {
    system: String,
}

#[derive(Serialize)]
enum ManifestDependencyInfo {
    Git(ManifestGitDependency),
    Local(LocalDepInfo),
    System(SystemDependency),
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
struct DefaultDependency {
    #[serde(flatten)]
    dependency_info: ManifestDependencyInfo,
    #[serde(rename = "override", default)]
    is_override: bool,
    #[serde(default)]
    rename_from: Option<String>,
    #[serde(default)]
    modes: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
struct ReplacementDependency {
    #[serde(flatten, default)]
    dependency: Option<DefaultDependency>,
    #[serde(flatten, default)]
    addresses: Option<PublishAddressesDigest>,
    #[serde(default)]
    use_environment: Option<String>,
}

#[derive(Serialize)]
struct RepinTriggers {
    deps: BTreeMap<String, ReplacementDependency>,
}

#[cfg(not(feature = "verification"))]
fn digest_dependency(dep: DigestDepInfo) -> (String, ReplacementDependency) {
    let source = if let Some(repo) = dep.git {
        Some(CombinedDependencySource::Git {
            git: repo,
            rev: dep.rev,
            subdir: dep.subdir,
        })
    } else if let Some(local) = dep.local {
        Some(CombinedDependencySource::Local { local })
    } else {
        dep.system
            .map(|system| CombinedDependencySource::System { system })
    };

    let replacement = source.map(|source| CombinedMoveDependency {
        name: dep.name.clone(),
        source,
        is_override: dep.is_override.unwrap_or(false),
        rename_from: dep.rename_from,
        modes: dep.modes,
        use_environment: dep.use_environment.unwrap_or_default(),
        address_override: None,
        package_hint: None,
        subst: None,
    });

    match replacement {
        Some(dep) => (dep.name.clone(), replacement_dependency_from_combined(&dep)),
        None => (
            dep.name,
            ReplacementDependency {
                dependency: None,
                addresses: None,
                use_environment: None,
            },
        ),
    }
}

#[cfg(not(feature = "verification"))]
fn compute_manifest_digest_from_deps(deps: Vec<DigestDepInfo>) -> Option<String> {
    use sha2::{Digest, Sha256};

    let mut deps_map: BTreeMap<String, ReplacementDependency> = BTreeMap::new();
    for dep in deps {
        let (name, replacement) = digest_dependency(dep);
        deps_map.insert(name, replacement);
    }

    let triggers = RepinTriggers { deps: deps_map };
    let serialized = toml_edit::ser::to_string(&triggers).ok()?;
    let hash = Sha256::digest(serialized.as_bytes());
    Some(format!("{:X}", hash))
}

pub(crate) fn compute_manifest_digest_from_combined(
    deps: Vec<CombinedMoveDependency>,
) -> Option<String> {
    use sha2::{Digest, Sha256};

    let deps_map = deps
        .iter()
        .map(|dep| (dep.name.clone(), replacement_dependency_from_combined(dep)))
        .collect::<BTreeMap<_, _>>();
    let triggers = RepinTriggers { deps: deps_map };
    let serialized = toml_edit::ser::to_string(&triggers).ok()?;
    let hash = Sha256::digest(serialized.as_bytes());
    Some(format!("{:X}", hash))
}

fn replacement_dependency_from_combined(dep: &CombinedMoveDependency) -> ReplacementDependency {
    let dependency_info = match &dep.source {
        CombinedDependencySource::Git { git, rev, subdir } => {
            ManifestDependencyInfo::Git(ManifestGitDependency {
                repo: git.clone(),
                rev: rev.clone(),
                subdir: std::path::PathBuf::from(subdir.clone().unwrap_or_default()),
            })
        }
        CombinedDependencySource::Local { local } => ManifestDependencyInfo::Local(LocalDepInfo {
            local: std::path::PathBuf::from(local),
        }),
        CombinedDependencySource::System { system } => {
            ManifestDependencyInfo::System(SystemDependency {
                system: system.clone(),
            })
        }
    };
    ReplacementDependency {
        dependency: Some(DefaultDependency {
            dependency_info,
            is_override: dep.is_override,
            rename_from: dep.rename_from.clone(),
            modes: dep.modes.clone(),
        }),
        addresses: dep.address_override.clone(),
        use_environment: Some(dep.use_environment.clone()),
    }
}

#[cfg(not(feature = "verification"))]
pub(crate) fn compute_manifest_digest_from_move_toml(
    move_toml: &str,
    package_name_override: Option<String>,
    environment: &str,
) -> String {
    combined_dependencies_from_move_toml(move_toml, package_name_override, environment)
        .ok()
        .and_then(compute_manifest_digest_from_combined)
        .unwrap_or_default()
}

#[cfg(not(feature = "verification"))]
pub(crate) fn compute_manifest_digest(deps_json: &str) -> String {
    #[derive(Deserialize)]
    struct Input {
        deps: Vec<DigestDepInfo>,
    }

    let input: Input = match serde_json::from_str(deps_json) {
        Ok(i) => i,
        Err(_) => {
            let simple: Vec<String> = match serde_json::from_str(deps_json) {
                Ok(s) => s,
                Err(_) => return String::new(),
            };
            let deps = simple
                .into_iter()
                .map(|name| DigestDepInfo {
                    name,
                    git: None,
                    subdir: None,
                    rev: None,
                    local: None,
                    system: None,
                    is_override: None,
                    use_environment: None,
                    rename_from: None,
                    modes: None,
                })
                .collect();
            return compute_manifest_digest_from_deps(deps).unwrap_or_default();
        }
    };

    compute_manifest_digest_from_deps(input.deps).unwrap_or_default()
}
