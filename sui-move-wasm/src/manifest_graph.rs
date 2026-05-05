use crate::helper::{self, HelperError};
use crate::lockfile_v4::{
    self, LockfileV4PackageManifest, LockfileV4Source, LockfileV4ValidateInput,
    LockfileV4ValidatePackage, LockfileV4ValidatedEdge, LockfileV4ValidatedGraph,
    LockfileV4ValidatedPackage,
};
use crate::manifest_digest::{
    CombinedDependencySource, CombinedMoveDependency, ManifestPackagePlanSubst,
};
use crate::stage_report::StageReport;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestPackagePlanDependency {
    name: String,
    source: ManifestPackagePlanSource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    modes: Vec<String>,
    #[serde(
        rename = "isOverride",
        default,
        skip_serializing_if = "manifest_plan_is_false"
    )]
    is_override: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    subst: Option<BTreeMap<String, ManifestPackagePlanSubst>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ManifestPackagePlanSource {
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
struct ManifestGraphInput {
    environment: String,
    #[serde(default)]
    framework_rev: Option<String>,
    #[serde(default)]
    modes: Vec<String>,
    root: ManifestGraphPackageSnapshot,
    #[serde(default)]
    packages: Vec<ManifestGraphPackageSnapshot>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestGraphPackageSnapshot {
    source: LockfileV4Source,
    #[serde(default)]
    requested_source: Option<LockfileV4Source>,
    #[serde(default)]
    files: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestGraphFetchRequest {
    source: LockfileV4Source,
    dependency_name: String,
    parent_package_name: String,
    parent_source: LockfileV4Source,
}

struct ManifestGraphNode {
    id: String,
    source: LockfileV4Source,
    files: BTreeMap<String, String>,
    manifest: LockfileV4PackageManifest,
    dep_alias_to_package_name: BTreeMap<String, String>,
}

fn manifest_plan_is_false(value: &bool) -> bool {
    !*value
}

fn manifest_has_move_source(files: &BTreeMap<String, String>) -> bool {
    files.keys().any(|path| path.ends_with(".move"))
}

fn manifest_plan_resolve_relative_path(parent_path: &str, local_path: &str) -> String {
    let mut parts = parent_path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    for part in local_path.split('/').filter(|part| !part.is_empty()) {
        match part {
            "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value.to_string()),
        }
    }

    parts.join("/")
}

fn system_package_git_source(
    package_name: &str,
    dep_name: &str,
    system_name: &str,
) -> Result<ManifestPackagePlanSource, HelperError> {
    let source =
        crate::system_packages::system_package_source(system_name).map_err(|code| match code {
            crate::system_packages::SystemPackageSourceError::MissingSnapshot => HelperError::with_code(
                "missing_system_package_snapshot",
                format!(
                    "Dependency '{}.{}' uses system package '{}' but the pinned system package snapshot is unavailable",
                    package_name, dep_name, system_name
                ),
            ),
            crate::system_packages::SystemPackageSourceError::UnsupportedSystemDependency => {
                HelperError::with_code(
                    "unsupported_system_dependency",
                    format!(
                        "Dependency '{}.{}' has unsupported system package '{}'",
                        package_name, dep_name, system_name
                    ),
                )
            }
        })?;

    Ok(ManifestPackagePlanSource::Git {
        git: source.git,
        rev: source.rev,
        subdir: Some(source.subdir),
        is_implicit: true,
    })
}

fn manifest_plan_dependency_source_from_combined(
    package_name: &str,
    dep: &CombinedMoveDependency,
    parent_source: &LockfileV4Source,
) -> Result<ManifestPackagePlanSource, HelperError> {
    match &dep.source {
        CombinedDependencySource::Git { git, rev, subdir } => {
            let rev = rev.as_ref().ok_or_else(|| {
                HelperError::new(format!(
                    "Dependency '{}.{}' has git source without rev",
                    package_name, dep.name
                ))
            })?;
            Ok(ManifestPackagePlanSource::Git {
                git: git.clone(),
                rev: rev.clone(),
                subdir: subdir.clone(),
                is_implicit: false,
            })
        }
        CombinedDependencySource::Local { local } => match parent_source {
            LockfileV4Source::Git { git, rev, subdir } => {
                let resolved_subdir = manifest_plan_resolve_relative_path(
                    subdir.as_deref().unwrap_or_default(),
                    local,
                );
                Ok(ManifestPackagePlanSource::Git {
                    git: git.clone(),
                    rev: rev.clone(),
                    subdir: Some(resolved_subdir),
                    is_implicit: false,
                })
            }
            LockfileV4Source::Local {
                local: parent_local,
            } => Ok(ManifestPackagePlanSource::Local {
                local: manifest_plan_resolve_relative_path(parent_local, local),
            }),
            LockfileV4Source::Root => Ok(ManifestPackagePlanSource::Local {
                local: local.clone(),
            }),
            LockfileV4Source::Unsupported => Err(HelperError::with_code(
                "unsupported_dependency_source",
                format!(
                    "Dependency '{}.{}' has unsupported parent source",
                    package_name, dep.name
                ),
            )),
        },
        CombinedDependencySource::System { system } => {
            system_package_git_source(package_name, &dep.name, system)
        }
    }
}

fn manifest_plan_dependencies_from_manifest(
    manifest: &LockfileV4PackageManifest,
    parent_source: &LockfileV4Source,
) -> Result<Vec<ManifestPackagePlanDependency>, HelperError> {
    let mut dependencies = Vec::new();
    for dep in &manifest.combined_dependencies {
        dependencies.push(ManifestPackagePlanDependency {
            name: dep.name.clone(),
            source: manifest_plan_dependency_source_from_combined(
                &manifest.name,
                dep,
                parent_source,
            )?,
            modes: dep.modes.clone().unwrap_or_default(),
            is_override: dep.is_override,
            subst: dep.subst.clone(),
        });
    }
    Ok(dependencies)
}

fn source_key(source: &LockfileV4Source) -> String {
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

fn plan_source_to_lockfile_source(source: &ManifestPackagePlanSource) -> LockfileV4Source {
    match source {
        ManifestPackagePlanSource::Git {
            git, rev, subdir, ..
        } => LockfileV4Source::Git {
            git: git.clone(),
            rev: rev.clone(),
            subdir: subdir.clone(),
        },
        ManifestPackagePlanSource::Local { local } => LockfileV4Source::Local {
            local: local.clone(),
        },
    }
}

fn dependency_is_implicit(dep: &ManifestPackagePlanDependency) -> bool {
    matches!(
        dep.source,
        ManifestPackagePlanSource::Git {
            is_implicit: true,
            ..
        }
    )
}

fn sort_dependencies(dependencies: &mut [ManifestPackagePlanDependency]) {
    dependencies.sort_by(|left, right| {
        let left_implicit = dependency_is_implicit(left);
        let right_implicit = dependency_is_implicit(right);
        right_implicit
            .cmp(&left_implicit)
            .then_with(|| left.name.cmp(&right.name))
    });
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
fn add_package(
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

fn cycle(root_id: &str, edges: &[LockfileV4ValidatedEdge]) -> Option<Vec<String>> {
    let mut edges_by_from: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in edges {
        edges_by_from
            .entry(edge.from.clone())
            .or_default()
            .push(edge.to.clone());
    }

    fn visit(
        id: &str,
        edges_by_from: &BTreeMap<String, Vec<String>>,
        visited: &mut BTreeSet<String>,
        stack: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        if let Some(position) = stack.iter().position(|entry| entry == id) {
            let mut cycle = stack[position..].to_vec();
            cycle.push(id.to_string());
            return Some(cycle);
        }
        if !visited.insert(id.to_string()) {
            return None;
        }

        stack.push(id.to_string());
        if let Some(targets) = edges_by_from.get(id) {
            for target in targets {
                if let Some(cycle) = visit(target, edges_by_from, visited, stack) {
                    return Some(cycle);
                }
            }
        }
        stack.pop();
        None
    }

    visit(
        root_id,
        &edges_by_from,
        &mut BTreeSet::new(),
        &mut Vec::new(),
    )
}

fn lockfile_order(root_id: &str, edges: &[LockfileV4ValidatedEdge]) -> Vec<String> {
    let mut edges_by_from: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in edges {
        edges_by_from
            .entry(edge.from.clone())
            .or_default()
            .push(edge.to.clone());
    }

    fn visit(
        id: &str,
        edges_by_from: &BTreeMap<String, Vec<String>>,
        visited: &mut BTreeSet<String>,
        order: &mut Vec<String>,
    ) {
        if !visited.insert(id.to_string()) {
            return;
        }
        if let Some(targets) = edges_by_from.get(id) {
            for target in targets {
                visit(target, edges_by_from, visited, order);
            }
        }
        order.push(id.to_string());
    }

    let mut order = Vec::new();
    visit(root_id, &edges_by_from, &mut BTreeSet::new(), &mut order);
    order
}

fn resolve_package_groups_impl(
    input: ManifestGraphInput,
) -> Result<serde_json::Value, HelperError> {
    let environment = input.environment.clone();
    let modes = input.modes.clone();
    let mut known_by_source = BTreeMap::new();
    for package in &input.packages {
        if matches!(package.source, LockfileV4Source::Root) {
            return Err(HelperError::new(
                "Manifest graph dependency package cannot use root source",
            ));
        }
        known_by_source.insert(source_key(&package.source), package.clone());
        if let Some(requested_source) = &package.requested_source {
            known_by_source.insert(source_key(requested_source), package.clone());
        }
    }

    let mut source_to_id = BTreeMap::new();
    let mut name_to_suffix = BTreeMap::new();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut requests = BTreeMap::new();
    let root_id = add_package(
        input.root.clone(),
        "root",
        true,
        &input,
        &known_by_source,
        &mut source_to_id,
        &mut name_to_suffix,
        &mut nodes,
        &mut edges,
        &mut requests,
    )?;

    if !requests.is_empty() {
        let stage_reports =
            vec![
                StageReport::new("manifest_graph_fetch_plan", &environment, &modes)
                    .package_id(root_id.clone())
                    .node_count(nodes.len())
                    .edge_count(edges.len()),
            ];
        return Ok(serde_json::json!({
            "status": "needFetch",
            "requests": requests.into_values().collect::<Vec<_>>(),
            "stageReports": stage_reports,
        }));
    }

    if let Some(cycle) = cycle(&root_id, &edges) {
        return Err(HelperError::with_code(
            "dependency_cycle",
            format!("Dependency cycle detected: {}", cycle.join(" -> ")),
        ));
    }

    let lockfile_order = lockfile_order(&root_id, &edges);
    let active_edges = lockfile_v4::active_edges(&edges, &input.modes);
    let node_count = nodes.len();
    let edge_count = edges.len();
    let active_edge_count = active_edges.len();
    let active_aliases_by_from = active_edges.iter().fold(
        BTreeMap::<String, BTreeSet<String>>::new(),
        |mut acc, edge| {
            acc.entry(edge.from.clone())
                .or_default()
                .insert(edge.alias.clone());
            acc
        },
    );
    let node_by_id = nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();

    let mut validate_packages = Vec::new();
    let mut validated_packages = Vec::new();
    for package_id in &lockfile_order {
        let node = node_by_id.get(package_id).ok_or_else(|| {
            HelperError::new(format!(
                "Manifest graph has unknown package '{}'",
                package_id
            ))
        })?;
        validate_packages.push(LockfileV4ValidatePackage {
            id: node.id.clone(),
            source: node.source.clone(),
            deps: node.dep_alias_to_package_name.clone(),
            manifest_digest: None,
            files: node.files.clone(),
        });
        validated_packages.push(LockfileV4ValidatedPackage {
            id: node.id.clone(),
            source: node.source.clone(),
            manifest: node.manifest.clone(),
            dep_alias_to_package_name: node.dep_alias_to_package_name.clone(),
            active_dep_alias_to_package_name: node
                .dep_alias_to_package_name
                .iter()
                .filter(|(alias, _)| {
                    active_aliases_by_from
                        .get(&node.id)
                        .map(|aliases| aliases.contains(*alias))
                        .unwrap_or(false)
                })
                .map(|(alias, target_id)| (alias.clone(), target_id.clone()))
                .collect(),
        });
    }

    let root_move_toml = lockfile_v4::find_move_toml(&input.root.files, &input.environment)
        .unwrap_or_default()
        .to_string();
    let validate_input = LockfileV4ValidateInput {
        environment: input.environment,
        root_move_toml,
        modes: input.modes,
        packages: validate_packages,
    };
    let root_id_for_report = root_id.clone();
    let graph = LockfileV4ValidatedGraph {
        root_id,
        lockfile_order: lockfile_order.clone(),
        packages: validated_packages,
        edges: active_edges,
    };
    let groups = lockfile_v4::package_groups_from_validated_with_orders(
        &validate_input,
        graph,
        &lockfile_order,
    )?;
    let stage_reports = vec![
        StageReport::new("manifest_graph", &environment, &modes)
            .package_id(root_id_for_report)
            .node_count(node_count)
            .edge_count(edge_count),
        StageReport::new("manifest_mode_filter", &environment, &modes)
            .node_count(node_count)
            .edge_count(edge_count)
            .active_edge_count(active_edge_count),
        StageReport::new("manifest_linkage", &environment, &modes)
            .linked_node_count(groups.dependencies.len()),
    ];

    Ok(serde_json::json!({
        "status": "ok",
        "rootFiles": groups.root_files,
        "dependencies": groups.dependencies,
        "lockfileDependencies": groups.lockfile_dependencies,
        "stageReports": stage_reports,
    }))
}

fn resolve_package_groups(input: ManifestGraphInput) -> String {
    match resolve_package_groups_impl(input) {
        Ok(response) => response.to_string(),
        Err(error) => helper::error_from_helper(error),
    }
}

#[cfg(feature = "verification")]
pub(crate) fn resolve_package_groups_from_value(input: serde_json::Value) -> String {
    let input: ManifestGraphInput = match serde_json::from_value(input) {
        Ok(input) => input,
        Err(error) => {
            return helper::error_with_code(
                "invalid_helper_input",
                format!("Invalid manifest graph input: {}", error),
            );
        }
    };

    resolve_package_groups(input)
}

#[cfg(not(feature = "verification"))]
pub(crate) fn resolve_package_groups_json(input_json: &str) -> String {
    let input: ManifestGraphInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return helper::error_with_code(
                "invalid_helper_input",
                format!("Invalid manifest graph input: {}", error),
            );
        }
    };

    resolve_package_groups(input)
}
