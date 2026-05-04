use std::collections::{BTreeMap, BTreeSet};

#[cfg(not(feature = "verification"))]
use serde::Deserialize;
use serde::Serialize;

use crate::package_model::dependency_name_is_implicit;

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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct PublishAddressesDigest {
    published_at: String,
    original_id: String,
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

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ManifestPackagePlanSubst {
    Assign { address: String },
    RenameFrom { name: String },
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

fn toml_table_string(table: &toml::value::Table, kebab: &str, snake: &str) -> Option<String> {
    table
        .get(kebab)
        .or_else(|| table.get(snake))
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

fn toml_table_string_vec(table: &toml::value::Table, key: &str) -> Option<Vec<String>> {
    table
        .get(key)
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
}

fn combined_dependency_source_from_table(
    table: &toml::value::Table,
) -> Option<CombinedDependencySource> {
    if let Some(git) = table.get("git").and_then(|value| value.as_str()) {
        return Some(CombinedDependencySource::Git {
            git: git.to_string(),
            rev: table
                .get("rev")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            subdir: table
                .get("subdir")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        });
    }
    if let Some(local) = table.get("local").and_then(|value| value.as_str()) {
        return Some(CombinedDependencySource::Local {
            local: local.to_string(),
        });
    }
    table
        .get("system")
        .and_then(|value| value.as_str())
        .map(|system| CombinedDependencySource::System {
            system: system.to_string(),
        })
}

fn dependency_address_override_from_table(
    table: &toml::value::Table,
) -> Result<Option<PublishAddressesDigest>, String> {
    let published_at = toml_table_string(table, "published-at", "published_at");
    let original_id = toml_table_string(table, "original-id", "original_id");
    if published_at.is_some() != original_id.is_some() {
        return Err("Dependency replacement address override requires both `published-at` and `original-id`".to_string());
    }
    Ok(match (published_at, original_id) {
        (Some(published_at), Some(original_id)) => Some(PublishAddressesDigest {
            published_at: crate::normalize_hex_address_string(&published_at)
                .unwrap_or(published_at),
            original_id: crate::normalize_hex_address_string(&original_id).unwrap_or(original_id),
        }),
        _ => None,
    })
}

#[derive(Clone)]
enum CombinedDependencyModeSource {
    FromTable,
    Fixed(Option<Vec<String>>),
}

fn combined_dependency_from_table_with_modes(
    name: &str,
    table: &toml::value::Table,
    environment: &str,
    modes: CombinedDependencyModeSource,
) -> Result<CombinedMoveDependency, String> {
    let source = combined_dependency_source_from_table(table)
        .ok_or_else(|| format!("Dependency '{}' has unsupported source form", name))?;
    let modes = match modes {
        CombinedDependencyModeSource::FromTable => toml_table_string_vec(table, "modes"),
        CombinedDependencyModeSource::Fixed(modes) => modes,
    };
    Ok(CombinedMoveDependency {
        name: name.to_string(),
        source,
        is_override: table
            .get("override")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        rename_from: toml_table_string(table, "rename-from", "rename_from"),
        modes,
        use_environment: environment.to_string(),
        address_override: None,
        package_hint: toml_table_string(table, "package", "package"),
        subst: manifest_plan_dependency_subst(table),
    })
}

fn combined_dependency_with_replacement(
    name: &str,
    default: Option<CombinedMoveDependency>,
    replacement_value: Option<toml::Value>,
    environment: &str,
) -> Result<CombinedMoveDependency, String> {
    let Some(replacement_value) = replacement_value else {
        return default.ok_or_else(|| format!("Dependency '{}' has no source", name));
    };
    let replacement_table = replacement_value.as_table().ok_or_else(|| {
        format!(
            "Dependency replacement '{}' has unsupported source form",
            name
        )
    })?;

    let replacement_source = combined_dependency_source_from_table(replacement_table);
    let mut dep = if let Some(source) = replacement_source {
        CombinedMoveDependency {
            name: name.to_string(),
            source,
            is_override: replacement_table
                .get("override")
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            rename_from: toml_table_string(replacement_table, "rename-from", "rename_from"),
            modes: toml_table_string_vec(replacement_table, "modes"),
            use_environment: environment.to_string(),
            address_override: None,
            package_hint: toml_table_string(replacement_table, "package", "package"),
            subst: manifest_plan_dependency_subst(replacement_table),
        }
    } else {
        default.ok_or_else(|| format!("Dependency replacement '{}' has no source", name))?
    };

    if replacement_table.contains_key("package") {
        dep.package_hint = toml_table_string(replacement_table, "package", "package");
    }
    if replacement_table.contains_key("addr-subst") || replacement_table.contains_key("addr_subst")
    {
        dep.subst = manifest_plan_dependency_subst(replacement_table);
    }
    dep.use_environment =
        toml_table_string(replacement_table, "use-environment", "use_environment")
            .unwrap_or_else(|| environment.to_string());
    dep.address_override = dependency_address_override_from_table(replacement_table)?;
    Ok(dep)
}

fn merge_dependency_table_into_defaults(
    defaults: &mut BTreeMap<String, CombinedMoveDependency>,
    dep_table: &toml::value::Table,
    is_legacy: bool,
    package_uses_implicit_dependencies: bool,
    environment: &str,
    modes: CombinedDependencyModeSource,
) -> Result<(), String> {
    for (name, value) in dep_table {
        if package_uses_implicit_dependencies && dependency_name_is_implicit(name) {
            return Err(format!(
                "The `{}` dependency is implicitly provided and should not be defined in your manifest.",
                name
            ));
        }
        let table = value.as_table().ok_or_else(|| {
            format!(
                "Dependency '{}' must be a table with a supported source",
                name
            )
        })?;
        let dependency_name = if is_legacy {
            normalize_legacy_name_to_identifier(name)
        } else {
            name.clone()
        };
        defaults.insert(
            dependency_name.clone(),
            combined_dependency_from_table_with_modes(
                &dependency_name,
                table,
                environment,
                modes.clone(),
            )?,
        );
    }
    Ok(())
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

pub(crate) fn combined_dependencies_from_move_toml(
    move_toml: &str,
    package_name_override: Option<String>,
    environment: &str,
) -> Result<Vec<CombinedMoveDependency>, String> {
    let parsed = move_toml
        .parse::<toml::Value>()
        .map_err(|error| format!("Failed to parse Move.toml dependencies: {}", error))?;
    let package_name = package_name_override
        .filter(|name| !name.is_empty())
        .or_else(|| {
            parsed
                .get("package")
                .and_then(|package| package.get("name"))
                .and_then(|name| name.as_str())
                .map(|name| name.to_string())
        })
        .unwrap_or_default();
    let implicit_dependencies = parsed
        .get("package")
        .and_then(|package| package.get("implicit-dependencies"))
        .or_else(|| {
            parsed
                .get("package")
                .and_then(|package| package.get("implicit_dependencies"))
        })
        .and_then(|value| value.as_bool())
        .unwrap_or(true);

    let is_legacy = parsed
        .get("addresses")
        .and_then(|addresses| addresses.as_table())
        .is_some()
        || parsed
            .get("dev-addresses")
            .and_then(|addresses| addresses.as_table())
            .is_some()
        || parsed
            .get("dev-dependencies")
            .and_then(|dependencies| dependencies.as_table())
            .is_some();
    let package_uses_implicit_dependencies = if is_legacy {
        legacy_implicit_dependencies(&package_name, &parsed, implicit_dependencies)
    } else {
        implicit_dependencies && !dependency_name_is_implicit(&package_name)
    };

    let mut defaults = BTreeMap::<String, CombinedMoveDependency>::new();
    if let Some(dep_table) = parsed.get("dependencies").and_then(|deps| deps.as_table()) {
        merge_dependency_table_into_defaults(
            &mut defaults,
            dep_table,
            is_legacy,
            package_uses_implicit_dependencies,
            environment,
            if is_legacy {
                CombinedDependencyModeSource::Fixed(None)
            } else {
                CombinedDependencyModeSource::FromTable
            },
        )?;
    }

    if is_legacy {
        if let Some(dep_table) = parsed
            .get("dev-dependencies")
            .and_then(|deps| deps.as_table())
        {
            merge_dependency_table_into_defaults(
                &mut defaults,
                dep_table,
                true,
                package_uses_implicit_dependencies,
                environment,
                CombinedDependencyModeSource::Fixed(Some(vec!["test".to_string()])),
            )?;
        }
    }

    let mut replacements = parsed
        .get("dep-replacements")
        .or_else(|| parsed.get("dep_replacements"))
        .and_then(|deps| deps.as_table())
        .and_then(|deps| deps.get(environment))
        .and_then(|deps| deps.as_table())
        .map(|deps| {
            deps.iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();

    let mut deps = Vec::new();
    for (name, default) in defaults {
        let replacement = replacements.remove(&name);
        deps.push(combined_dependency_with_replacement(
            &name,
            Some(default),
            replacement,
            environment,
        )?);
    }

    for (name, replacement) in replacements {
        if package_uses_implicit_dependencies && dependency_name_is_implicit(&name) {
            return Err(format!(
                "The `{}` dependency is implicitly provided and should not be defined in your manifest.",
                name
            ));
        }
        deps.push(combined_dependency_with_replacement(
            &name,
            None,
            Some(replacement),
            environment,
        )?);
    }

    if package_uses_implicit_dependencies {
        deps.push(CombinedMoveDependency {
            name: "sui".to_string(),
            source: CombinedDependencySource::System {
                system: "sui".to_string(),
            },
            is_override: true,
            rename_from: None,
            modes: None,
            use_environment: environment.to_string(),
            address_override: None,
            package_hint: None,
            subst: None,
        });
        deps.push(CombinedMoveDependency {
            name: "std".to_string(),
            source: CombinedDependencySource::System {
                system: "std".to_string(),
            },
            is_override: true,
            rename_from: None,
            modes: None,
            use_environment: environment.to_string(),
            address_override: None,
            package_hint: None,
            subst: None,
        });
    }

    Ok(deps)
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

fn dependency_aliases_from_section(value: &toml::Value, section: &str) -> BTreeSet<String> {
    value
        .get(section)
        .and_then(|deps| deps.as_table())
        .map(|deps| deps.keys().cloned().collect())
        .unwrap_or_default()
}

pub(crate) fn legacy_implicit_dependencies(
    legacy_name: &str,
    value: &toml::Value,
    implicit_dependencies: bool,
) -> bool {
    if !implicit_dependencies || is_active_legacy_system_dep_name(legacy_name) {
        return false;
    }

    let mut aliases = dependency_aliases_from_section(value, "dependencies");
    aliases.extend(dependency_aliases_from_section(value, "dev-dependencies"));
    !aliases
        .iter()
        .any(|alias| is_active_legacy_system_dep_name(alias))
}

pub(crate) fn normalize_legacy_name_to_identifier(name: &str) -> String {
    let mut result = name
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>();
    if result.is_empty() || result == "_" {
        return "__".to_string();
    }
    if result
        .chars()
        .next()
        .map(|ch| ch.is_ascii_digit())
        .unwrap_or(false)
    {
        result.insert(0, '_');
    }
    result
}

pub(crate) fn is_legacy_system_dep_name(name: &str) -> bool {
    matches!(
        name,
        "Sui" | "MoveStdlib" | "Bridge" | "DeepBook" | "SuiSystem"
    )
}

fn is_active_legacy_system_dep_name(name: &str) -> bool {
    is_legacy_system_dep_name(name) && name != "DeepBook"
}

pub(crate) fn manifest_plan_dependency_subst(
    dep_table: &toml::Table,
) -> Option<BTreeMap<String, ManifestPackagePlanSubst>> {
    let subst_table = dep_table
        .get("addr-subst")
        .or_else(|| dep_table.get("addr_subst"))
        .and_then(|value| value.as_table())?;

    let mut subst = BTreeMap::new();
    for (name, value) in subst_table {
        let Some(raw_value) = value.as_str() else {
            continue;
        };
        if crate::normalize_hex_address_string(raw_value).is_some()
            || raw_value.starts_with("0x")
            || raw_value.chars().all(|ch| ch.is_ascii_hexdigit())
        {
            subst.insert(
                name.clone(),
                ManifestPackagePlanSubst::Assign {
                    address: raw_value.to_string(),
                },
            );
        } else {
            subst.insert(
                name.clone(),
                ManifestPackagePlanSubst::RenameFrom {
                    name: raw_value.to_string(),
                },
            );
        }
    }

    if subst.is_empty() {
        None
    } else {
        Some(subst)
    }
}
