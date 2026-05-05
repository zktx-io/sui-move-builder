use crate::helper::{self, HelperError};
use crate::lockfile_v4::{
    self, LockfileV4ValidateInput, LockfileV4ValidatePackage, LockfileV4ValidatedGraph,
    LockfileV4ValidatedPackage,
};
use crate::stage_report::StageReport;
use std::collections::{BTreeMap, BTreeSet};

use super::builder::{add_package, source_key};
use super::order::{cycle, lockfile_order};
use super::types::{ManifestGraphInput, ManifestGraphNode};

fn resolve_package_groups_impl(
    input: ManifestGraphInput,
) -> Result<serde_json::Value, HelperError> {
    let environment = input.environment.clone();
    let modes = input.modes.clone();
    let mut known_by_source = BTreeMap::new();
    for package in &input.packages {
        if matches!(package.source, crate::lockfile_v4::LockfileV4Source::Root) {
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
    let mut nodes: Vec<ManifestGraphNode> = Vec::new();
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
