use super::graph::packages_by_id;
use super::manifest::manifest_from_files;
use super::response::out_of_date;
use super::types::LockfileV4ValidationResult;
use super::{
    LockfileV4PackageManifest, LockfileV4Source, LockfileV4ValidateInput, LockfileV4ValidatedEdge,
    LockfileV4ValidatedGraph, LockfileV4ValidatedPackage,
};
use crate::helper;
use crate::manifest_digest::{self, CombinedMoveDependency};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn validate_graph_impl(input: &LockfileV4ValidateInput) -> LockfileV4ValidationResult {
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
