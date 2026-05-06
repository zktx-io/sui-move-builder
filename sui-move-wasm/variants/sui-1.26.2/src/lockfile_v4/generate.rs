use super::manifest_extraction::{manifest_from_files, package_graph_id_name};
use super::types::{LockfileV4GenerateInput, LockfileV4GenerateResolvedPackage, LockfileV4Source};
use crate::helper::HelperError;
use crate::manifest_digest::{self, CombinedDependencySource, CombinedMoveDependency};
use crate::package_model::dependency_name_is_implicit;
use std::collections::{BTreeMap, BTreeSet};

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

#[cfg(not(feature = "verification"))]
pub(crate) fn generate_json(input_json: &str) -> String {
    let input: LockfileV4GenerateInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return crate::helper::error_with_code(
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
        Err(error) => crate::helper::error_from_helper(error),
    }
}
