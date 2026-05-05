use super::fetch_plan::find_move_toml;
use super::graph::{edges_by_from, packages_by_id};
use super::linkage::linked_graph;
use super::manifest_extraction::{manifest_dep_names, NO_NAME_LEGACY_PACKAGE_NAME};
use super::response::out_of_date;
use super::types::LockfileV4ValidationResult;
use super::validate::validate_graph_impl;
use super::{
    LockfileV4PackageGroup, LockfileV4PackageGroupManifest, LockfileV4PackageGroups,
    LockfileV4PackageManifest, LockfileV4ValidateInput, LockfileV4ValidatedEdge,
    LockfileV4ValidatedGraph, LockfileV4ValidatedPackage,
};
use crate::helper;
use crate::stage_report::StageReport;
use std::collections::{BTreeMap, BTreeSet};

fn package_compile_id(package_id: &str, manifest: &LockfileV4PackageManifest) -> Option<String> {
    manifest
        .original_id
        .clone()
        .or_else(|| manifest.published_at.clone())
        .or_else(|| manifest.addresses.get(&manifest.name).cloned())
        .or_else(|| manifest.addresses.get(package_id).cloned())
}

fn package_output_id(package_id: &str, manifest: &LockfileV4PackageManifest) -> Option<String> {
    manifest
        .latest_published_id
        .clone()
        .or_else(|| manifest.published_at.clone())
        .or_else(|| manifest.original_id.clone())
        .or_else(|| package_compile_id(package_id, manifest))
}

fn compiler_files(
    files: &BTreeMap<String, String>,
    environment: &str,
    prefix: Option<&str>,
) -> BTreeMap<String, String> {
    let selected_move_toml = find_move_toml(files, environment).map(str::to_string);
    let mut output = BTreeMap::new();

    for (path, content) in files {
        let file_name = path.rsplit(['/', '\\']).next().unwrap_or(path.as_str());
        let is_manifest = file_name == "Move.toml"
            || (file_name.starts_with("Move.")
                && file_name.ends_with(".toml")
                && file_name.matches('.').count() == 2);
        if file_name == "Move.lock" || is_manifest {
            continue;
        }

        let output_path = match prefix {
            Some(prefix) => format!(
                "{}/{}",
                prefix.trim_end_matches('/'),
                path.trim_start_matches('/')
            ),
            None => path.clone(),
        };
        output.insert(output_path, content.clone());
    }

    if let Some(move_toml) = selected_move_toml {
        let output_path = match prefix {
            Some(prefix) => format!("{}/Move.toml", prefix.trim_end_matches('/')),
            None => "Move.toml".to_string(),
        };
        output.insert(output_path, move_toml);
    }

    output
}

fn move_toml_with_addresses(move_toml: &str, addresses: &BTreeMap<String, String>) -> String {
    let Ok(mut value) = move_toml.parse::<toml::Value>() else {
        return move_toml.to_string();
    };
    let Some(table) = value.as_table_mut() else {
        return move_toml.to_string();
    };
    let entry = table
        .entry("addresses".to_string())
        .or_insert_with(|| toml::Value::Table(toml::value::Table::new()));
    let Some(address_table) = entry.as_table_mut() else {
        return move_toml.to_string();
    };
    for (name, address) in addresses {
        address_table.insert(name.clone(), toml::Value::String(address.clone()));
    }
    toml::to_string(&value).unwrap_or_else(|_| move_toml.to_string())
}

fn insert_named_address(
    mapping: &mut BTreeMap<String, String>,
    name: &str,
    address: &str,
    package_id: &str,
) -> Result<(), String> {
    if !crate::is_move_named_address(name) {
        return Ok(());
    }
    let normalized =
        crate::normalize_hex_address_string(address).unwrap_or_else(|| address.to_string());
    if let Some(existing) = mapping.get(name) {
        let existing_normalized =
            crate::normalize_hex_address_string(existing).unwrap_or_else(|| existing.clone());
        if existing_normalized != normalized {
            return Err(format!(
                "Move.lock V4 package '{}' has duplicate named address '{}'",
                package_id, name
            ));
        }
    }
    mapping.insert(name.to_string(), normalized);
    Ok(())
}

fn package_is_legacy(package: &LockfileV4ValidatedPackage) -> bool {
    package.manifest.is_legacy
}

fn package_node_address(package: &LockfileV4ValidatedPackage) -> Option<String> {
    package_compile_id(&package.id, &package.manifest)
        .and_then(|address| crate::normalize_hex_address_string(&address))
}

fn package_named_address_value(package: &LockfileV4ValidatedPackage) -> String {
    package_node_address(package).unwrap_or_else(|| "_".to_string())
}

fn named_addresses_for_package(
    package_id: &str,
    graph: &LockfileV4ValidatedGraph,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
    visiting: &mut BTreeSet<String>,
) -> Result<BTreeMap<String, String>, String> {
    let package = packages_by_id
        .get(package_id)
        .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", package_id))?;
    let mut mapping = BTreeMap::new();

    if package_is_legacy(package) {
        if package.manifest.name != NO_NAME_LEGACY_PACKAGE_NAME {
            insert_named_address(
                &mut mapping,
                &package.manifest.name,
                &package_named_address_value(package),
                package_id,
            )?;
        }

        if !visiting.insert(package_id.to_string()) {
            return Err(format!(
                "Move.lock V4 package '{}' has recursive legacy named addresses",
                package_id
            ));
        }
        for edge in edges_by_from.get(package_id).into_iter().flatten() {
            let child_mapping = named_addresses_for_package(
                &edge.to,
                graph,
                packages_by_id,
                edges_by_from,
                visiting,
            )?;
            for (name, address) in child_mapping {
                insert_named_address(&mut mapping, &name, &address, package_id)?;
            }
        }
        visiting.remove(package_id);

        for (name, address) in package
            .manifest
            .addresses
            .iter()
            .filter(|(name, _)| *name != &package.manifest.name)
        {
            insert_named_address(&mut mapping, name, address, package_id)?;
        }
    } else {
        for edge in edges_by_from.get(package_id).into_iter().flatten() {
            let target = packages_by_id
                .get(&edge.to)
                .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", edge.to))?;
            insert_named_address(
                &mut mapping,
                &edge.alias,
                &package_named_address_value(target),
                package_id,
            )?;
        }
        insert_named_address(
            &mut mapping,
            &package.manifest.name,
            &package_named_address_value(package),
            package_id,
        )?;
    }

    Ok(mapping)
}

pub(crate) fn package_groups_from_validated_with_orders(
    input: &LockfileV4ValidateInput,
    graph: LockfileV4ValidatedGraph,
    lockfile_order: &[String],
) -> Result<LockfileV4PackageGroups, String> {
    let linked_graph = linked_graph(&graph)?;
    let packages_by_id_map = graph
        .packages
        .iter()
        .map(|package| (package.id.clone(), package))
        .collect::<BTreeMap<_, _>>();
    let linked_packages_by_id = packages_by_id(&linked_graph);
    let linked_edges_by_from = edges_by_from(&linked_graph.edges);
    let input_by_id = input
        .packages
        .iter()
        .map(|package| (package.id.clone(), package))
        .collect::<BTreeMap<_, _>>();

    let _root_package = linked_packages_by_id
        .get(&linked_graph.root_id)
        .ok_or_else(|| {
            format!(
                "Move.lock V4 graph is missing root package '{}'",
                linked_graph.root_id
            )
        })?;
    let root_input = input_by_id.get(&graph.root_id).ok_or_else(|| {
        format!(
            "Move.lock V4 input is missing root package '{}'",
            graph.root_id
        )
    })?;
    let mut root_input_files = root_input.files.clone();
    root_input_files
        .entry("Move.toml".to_string())
        .or_insert_with(|| input.root_move_toml.clone());

    let root_address_mapping = named_addresses_for_package(
        &linked_graph.root_id,
        &linked_graph,
        &linked_packages_by_id,
        &linked_edges_by_from,
        &mut BTreeSet::new(),
    )?;

    let mut root_files = compiler_files(&root_input_files, &input.environment, None);
    if let Some(root_move_toml) = root_files.get("Move.toml").cloned() {
        root_files.insert(
            "Move.toml".to_string(),
            move_toml_with_addresses(&root_move_toml, &root_address_mapping),
        );
    }

    let mut root_aliases_by_target: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in linked_graph
        .edges
        .iter()
        .filter(|edge| edge.from == linked_graph.root_id)
    {
        root_aliases_by_target
            .entry(edge.to.clone())
            .or_default()
            .push(edge.alias.clone());
    }
    for aliases in root_aliases_by_target.values_mut() {
        aliases.sort();
    }

    let mut groups_by_id = BTreeMap::new();
    let mut active_groups_by_id = BTreeMap::new();

    for package_id in graph
        .lockfile_order
        .iter()
        .filter(|package_id| *package_id != &graph.root_id)
    {
        let package = packages_by_id_map
            .get(package_id)
            .ok_or_else(|| format!("Move.lock V4 graph has unknown package '{}'", package_id))?;
        let input_package = input_by_id
            .get(package_id)
            .ok_or_else(|| format!("Move.lock V4 input has no files for '{}'", package_id))?;
        let prefix = format!("dependencies/{}", package.id);
        let files = compiler_files(
            &input_package.files,
            &input.environment,
            Some(prefix.as_str()),
        );

        let address_mapping = if linked_packages_by_id.contains_key(package_id) {
            named_addresses_for_package(
                package_id,
                &linked_graph,
                &linked_packages_by_id,
                &linked_edges_by_from,
                &mut BTreeSet::new(),
            )?
        } else {
            package.manifest.addresses.clone()
        };

        let group = LockfileV4PackageGroup {
            name: package.id.clone(),
            display_name: package
                .manifest
                .legacy_name
                .clone()
                .unwrap_or_else(|| package.manifest.name.clone()),
            files,
            edition: package.manifest.edition.clone(),
            address_mapping,
            published_id_for_output: package_output_id(&package.id, &package.manifest),
            source: package.source.clone(),
            manifest_deps: manifest_dep_names(&package.manifest),
            manifest: LockfileV4PackageGroupManifest {
                name: package.manifest.name.clone(),
                dependencies: package.manifest.dependencies.clone(),
            },
            dep_alias_to_package_name: package.dep_alias_to_package_name.clone(),
            root_dependency_aliases: root_aliases_by_target
                .get(package_id)
                .cloned()
                .unwrap_or_default(),
        };
        let mut active_group = group.clone();
        if let Some(linked_package) = linked_packages_by_id.get(package_id) {
            active_group.dep_alias_to_package_name =
                linked_package.active_dep_alias_to_package_name.clone();
        } else {
            active_group.dep_alias_to_package_name.clear();
        }
        active_groups_by_id.insert(package.id.clone(), active_group);
        groups_by_id.insert(package.id.clone(), group);
    }

    let dependencies = linked_graph
        .lockfile_order
        .iter()
        .filter(|package_id| *package_id != &linked_graph.root_id)
        .filter_map(|package_id| active_groups_by_id.get(package_id).cloned())
        .collect::<Vec<_>>();
    let lockfile_dependencies = lockfile_order
        .iter()
        .filter(|package_id| *package_id != &graph.root_id)
        .filter_map(|package_id| groups_by_id.get(package_id).cloned())
        .collect::<Vec<_>>();

    Ok(LockfileV4PackageGroups {
        root_files,
        dependencies,
        lockfile_dependencies,
    })
}

fn package_groups_from_validated(
    input: &LockfileV4ValidateInput,
    graph: LockfileV4ValidatedGraph,
) -> Result<LockfileV4PackageGroups, String> {
    let order = graph.lockfile_order.clone();
    package_groups_from_validated_with_orders(input, graph, &order)
}

fn edge_matches_modes(edge: &LockfileV4ValidatedEdge, modes: &[String]) -> bool {
    edge.modes.is_empty()
        || edge
            .modes
            .iter()
            .any(|dep_mode| modes.iter().any(|mode| mode == dep_mode))
}

pub(crate) fn active_edges(
    edges: &[LockfileV4ValidatedEdge],
    modes: &[String],
) -> Vec<LockfileV4ValidatedEdge> {
    edges
        .iter()
        .filter(|edge| edge_matches_modes(edge, modes))
        .cloned()
        .collect()
}

fn resolve_package_groups_response(input: LockfileV4ValidateInput) -> String {
    let graph = match validate_graph_impl(&input) {
        LockfileV4ValidationResult::Ok(graph) => graph,
        LockfileV4ValidationResult::OutOfDate(package_id) => return out_of_date(package_id),
        LockfileV4ValidationResult::Error(error) => return helper::error(error),
    };

    let active_edge_count = graph
        .edges
        .iter()
        .filter(|edge| edge_matches_modes(edge, &input.modes))
        .count();
    let stage_reports = vec![
        StageReport::new("move_lock_graph", &input.environment, &input.modes)
            .package_id(graph.root_id.clone())
            .node_count(graph.packages.len())
            .edge_count(graph.edges.len())
            .active_edge_count(active_edge_count),
    ];
    match package_groups_from_validated(&input, graph) {
        Ok(groups) => {
            let mut reports = stage_reports;
            reports.push(
                StageReport::new("move_lock_linkage", &input.environment, &input.modes)
                    .linked_node_count(groups.dependencies.len()),
            );
            serde_json::json!({
                "status": "ok",
                "rootFiles": groups.root_files,
                "dependencies": groups.dependencies,
                "lockfileDependencies": groups.lockfile_dependencies,
                "stageReports": reports,
            })
            .to_string()
        }
        Err(error) => helper::error(error),
    }
}

#[cfg(feature = "verification")]
pub(crate) fn resolve_package_groups_from_value(input: serde_json::Value) -> String {
    let input: LockfileV4ValidateInput = match serde_json::from_value(input) {
        Ok(input) => input,
        Err(error) => {
            return helper::error_with_code(
                "invalid_helper_input",
                format!("Invalid lockfile V4 package-group input: {}", error),
            );
        }
    };

    resolve_package_groups_response(input)
}

#[cfg(not(feature = "verification"))]
pub(crate) fn resolve_package_groups_json(input_json: &str) -> String {
    let input: LockfileV4ValidateInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return helper::error_with_code(
                "invalid_helper_input",
                format!("Invalid lockfile V4 package-group input: {}", error),
            );
        }
    };

    resolve_package_groups_response(input)
}
