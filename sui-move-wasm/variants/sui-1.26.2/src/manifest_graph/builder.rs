use crate::helper::HelperError;
use crate::lockfile_v4::{
    self, LockfileV4PackageManifest, LockfileV4Source, LockfileV4ValidatedEdge,
};
use std::collections::BTreeMap;

use super::source::{
    manifest_plan_dependencies_from_manifest, plan_source_to_lockfile_source, sort_dependencies,
};
use super::types::{
    ManifestGraphFetchRequest, ManifestGraphInput, ManifestGraphNode, ManifestGraphPackageSnapshot,
    ManifestPackagePlanDependency,
};

fn manifest_has_move_source(files: &BTreeMap<String, String>) -> bool {
    files.keys().any(|path| path.ends_with(".move"))
}

pub(super) fn source_key(source: &LockfileV4Source) -> String {
    match source {
        LockfileV4Source::Root => "root".to_string(),
        LockfileV4Source::Git { git, rev, subdir } => {
            format!(
                "git|{}|{}|{}",
                git,
                rev,
                subdir.as_deref().unwrap_or_default()
            )
        }
        LockfileV4Source::Local { local } => format!("local|{}", local),
        LockfileV4Source::Unsupported => "unsupported".to_string(),
    }
}

fn plan_snapshot(
    environment: &str,
    _framework_rev: &Option<String>,
    package_id_hint: &str,
    snapshot: &ManifestGraphPackageSnapshot,
) -> Result<
    (
        LockfileV4PackageManifest,
        Vec<ManifestPackagePlanDependency>,
    ),
    HelperError,
> {
    let (manifest, _move_toml) =
        lockfile_v4::manifest_from_files(package_id_hint, &snapshot.files, environment)?;
    lockfile_v4::validate_manifest_dependency_names(&manifest).map_err(HelperError::new)?;
    let mut dependencies = manifest_plan_dependencies_from_manifest(&manifest, &snapshot.source)?;
    sort_dependencies(&mut dependencies);
    Ok((manifest, dependencies))
}

fn unique_id(manifest_name: &str, name_to_suffix: &mut BTreeMap<String, usize>) -> String {
    let suffix = name_to_suffix
        .get(manifest_name)
        .copied()
        .unwrap_or_default();
    name_to_suffix.insert(manifest_name.to_string(), suffix + 1);
    if suffix == 0 {
        manifest_name.to_string()
    } else {
        format!("{}_{}", manifest_name, suffix)
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn add_package(
    snapshot: ManifestGraphPackageSnapshot,
    package_id_hint: &str,
    is_root: bool,
    input: &ManifestGraphInput,
    known_by_source: &BTreeMap<String, ManifestGraphPackageSnapshot>,
    source_to_id: &mut BTreeMap<String, String>,
    name_to_suffix: &mut BTreeMap<String, usize>,
    nodes: &mut Vec<ManifestGraphNode>,
    edges: &mut Vec<LockfileV4ValidatedEdge>,
    requests: &mut BTreeMap<String, ManifestGraphFetchRequest>,
) -> Result<String, HelperError> {
    let snapshot_source_key = source_key(&snapshot.source);
    if let Some(existing_id) = source_to_id.get(&snapshot_source_key) {
        return Ok(existing_id.clone());
    }
    if let Some(requested_source) = &snapshot.requested_source {
        let requested_key = source_key(requested_source);
        if let Some(existing_id) = source_to_id.get(&requested_key) {
            return Ok(existing_id.clone());
        }
    }

    let (manifest, dependencies) = plan_snapshot(
        &input.environment,
        &input.framework_rev,
        package_id_hint,
        &snapshot,
    )?;
    let package_id = if is_root {
        let id = lockfile_v4::package_graph_id_name(&manifest);
        name_to_suffix.insert(id.clone(), 1);
        id
    } else {
        unique_id(
            &lockfile_v4::package_graph_id_name(&manifest),
            name_to_suffix,
        )
    };
    if !is_root && !manifest_has_move_source(&snapshot.files) {
        return Err(HelperError::with_code(
            "bytecode_only_dependency_unsupported",
            format!(
                "Dependency '{}' has no Move source files; bytecode-only dependencies are not supported",
                package_id
            ),
        ));
    }

    source_to_id.insert(snapshot_source_key, package_id.clone());
    if let Some(requested_source) = &snapshot.requested_source {
        source_to_id.insert(source_key(requested_source), package_id.clone());
    }

    let node_index = nodes.len();
    nodes.push(ManifestGraphNode {
        id: package_id.clone(),
        source: snapshot.source.clone(),
        files: snapshot.files.clone(),
        manifest,
        dep_alias_to_package_name: BTreeMap::new(),
    });

    let mut resolved_edges = Vec::new();
    for dependency in dependencies {
        let dependency_source = plan_source_to_lockfile_source(&dependency.source);
        let dependency_key = source_key(&dependency_source);
        let target_id = if let Some(existing_id) = source_to_id.get(&dependency_key) {
            Some(existing_id.clone())
        } else if let Some(dependency_snapshot) = known_by_source.get(&dependency_key) {
            Some(add_package(
                dependency_snapshot.clone(),
                &dependency.name,
                false,
                input,
                known_by_source,
                source_to_id,
                name_to_suffix,
                nodes,
                edges,
                requests,
            )?)
        } else {
            requests
                .entry(dependency_key)
                .or_insert_with(|| ManifestGraphFetchRequest {
                    source: dependency_source,
                    dependency_name: dependency.name.clone(),
                    parent_package_name: nodes[node_index]
                        .manifest
                        .legacy_name
                        .clone()
                        .unwrap_or_else(|| nodes[node_index].manifest.name.clone()),
                    parent_source: nodes[node_index].source.clone(),
                });
            None
        };

        if let Some(target_id) = target_id {
            resolved_edges.push((
                dependency.name,
                target_id,
                dependency.modes,
                dependency.is_override,
            ));
        }
    }

    for (alias, target_id, modes, is_override) in resolved_edges {
        nodes[node_index]
            .dep_alias_to_package_name
            .insert(alias.clone(), target_id.clone());
        edges.push(LockfileV4ValidatedEdge {
            from: package_id.clone(),
            to: target_id,
            alias,
            modes,
            is_override,
        });
    }

    Ok(package_id)
}
