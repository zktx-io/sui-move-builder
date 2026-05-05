use super::graph::{edges_by_from, packages_by_id};
use super::{LockfileV4ValidatedEdge, LockfileV4ValidatedGraph, LockfileV4ValidatedPackage};
use std::collections::{BTreeMap, BTreeSet};

fn normalize_nonzero_address(value: &str) -> Option<String> {
    let normalized = crate::normalize_hex_address_string(value)?;
    if normalized == "0x0000000000000000000000000000000000000000000000000000000000000000" {
        None
    } else {
        Some(normalized)
    }
}

#[derive(Clone)]
struct LinkageConflict {
    depth: usize,
    node: String,
    conflict: String,
}

#[derive(Default)]
struct LinkageTraversal {
    linkage: BTreeMap<String, (usize, String)>,
    best_conflict: Option<LinkageConflict>,
}

fn package_linkage_id(package: &LockfileV4ValidatedPackage) -> String {
    package
        .manifest
        .original_id
        .as_deref()
        .and_then(normalize_nonzero_address)
        .or_else(|| {
            package
                .manifest
                .published_at
                .as_deref()
                .and_then(normalize_nonzero_address)
        })
        .or_else(|| {
            package
                .manifest
                .latest_published_id
                .as_deref()
                .and_then(normalize_nonzero_address)
        })
        .unwrap_or_else(|| format!("unpublished:{}", package.id))
}

fn check_linkage_cycles(
    id: &str,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
    path: &mut Vec<String>,
    seen: &mut BTreeMap<String, usize>,
) -> Result<(), String> {
    let package = packages_by_id
        .get(id)
        .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", id))?;
    let original_id = package_linkage_id(package);
    let self_index = path.len();
    path.push(id.to_string());

    if let Some(old_index) = seen.insert(original_id.clone(), self_index) {
        let cycle = path[old_index..].join(" -> ");
        return Err(format!(
            "Move.lock V4 linkage dependency cycle detected: {} -> {}",
            cycle, id
        ));
    }

    if let Some(edges) = edges_by_from.get(id) {
        for edge in edges {
            check_linkage_cycles(&edge.to, packages_by_id, edges_by_from, path, seen)?;
        }
    }

    seen.remove(&original_id);
    path.pop();
    Ok(())
}

fn direct_overrides(
    id: &str,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
) -> Result<BTreeMap<String, String>, String> {
    let mut overrides = BTreeMap::<String, (String, String)>::new();
    for edge in edges_by_from.get(id).into_iter().flatten() {
        if !edge.is_override {
            continue;
        }
        let target = packages_by_id
            .get(&edge.to)
            .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", edge.to))?;
        let original_id = package_linkage_id(target);
        match overrides.get(&original_id) {
            Some((_, existing_id)) if existing_id != &edge.to => {
                return Err(format!(
                    "Move.lock V4 package '{}' has override dependencies that both resolve to package ID {}",
                    id, original_id
                ));
            }
            Some(_) => {}
            None => {
                overrides.insert(original_id, (edge.alias.clone(), edge.to.clone()));
            }
        }
    }

    Ok(overrides
        .into_iter()
        .map(|(original_id, (_, package_id))| (original_id, package_id))
        .collect())
}

fn min_conflict(
    left: Option<LinkageConflict>,
    right: Option<LinkageConflict>,
) -> Option<LinkageConflict> {
    match (left, right) {
        (None, right) => right,
        (left, None) => left,
        (Some(left), Some(right)) => Some(if left.depth <= right.depth {
            left
        } else {
            right
        }),
    }
}

fn linkage_ignoring_overrides(
    id: &str,
    overrides: &BTreeMap<String, String>,
    depth: usize,
    packages_by_id: &BTreeMap<String, &LockfileV4ValidatedPackage>,
    edges_by_from: &BTreeMap<String, Vec<LockfileV4ValidatedEdge>>,
) -> Result<LinkageTraversal, String> {
    let package = packages_by_id
        .get(id)
        .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", id))?;

    let mut local_overrides = direct_overrides(id, packages_by_id, edges_by_from)?;
    for (original_id, package_id) in overrides {
        local_overrides.insert(original_id.clone(), package_id.clone());
    }

    let mut result = LinkageTraversal::default();
    for edge in edges_by_from.get(id).into_iter().flatten() {
        let target = packages_by_id
            .get(&edge.to)
            .ok_or_else(|| format!("Move.lock V4 linkage has unknown package '{}'", edge.to))?;
        if overrides.contains_key(&package_linkage_id(target)) {
            continue;
        }

        let child = linkage_ignoring_overrides(
            &edge.to,
            &local_overrides,
            depth + 1,
            packages_by_id,
            edges_by_from,
        )?;
        result.best_conflict = min_conflict(result.best_conflict, child.best_conflict);

        for (original_id, (new_depth, new_id)) in child.linkage {
            match result.linkage.get(&original_id).cloned() {
                None => {
                    result.linkage.insert(original_id, (new_depth, new_id));
                }
                Some((old_depth, old_id)) => {
                    let (min_depth, min_id, other_id) = if new_depth < old_depth {
                        (new_depth, new_id.clone(), old_id.clone())
                    } else {
                        (old_depth, old_id.clone(), new_id.clone())
                    };
                    if old_id != new_id {
                        result.best_conflict = min_conflict(
                            result.best_conflict,
                            Some(LinkageConflict {
                                depth: min_depth,
                                node: min_id.clone(),
                                conflict: other_id,
                            }),
                        );
                    }
                    result.linkage.insert(original_id, (min_depth, min_id));
                }
            }
        }
    }

    result
        .linkage
        .insert(package_linkage_id(package), (depth, id.to_string()));
    Ok(result)
}

fn linkage_table(graph: &LockfileV4ValidatedGraph) -> Result<BTreeMap<String, String>, String> {
    let packages_by_id = packages_by_id(graph);
    let edges_by_from = edges_by_from(&graph.edges);
    check_linkage_cycles(
        &graph.root_id,
        &packages_by_id,
        &edges_by_from,
        &mut Vec::new(),
        &mut BTreeMap::new(),
    )?;

    let traversal = linkage_ignoring_overrides(
        &graph.root_id,
        &BTreeMap::new(),
        0,
        &packages_by_id,
        &edges_by_from,
    )?;
    if let Some(conflict) = traversal.best_conflict {
        return Err(format!(
            "Move.lock V4 linkage depends on multiple versions of package ID {} through '{}' and '{}'",
            package_linkage_id(
                packages_by_id.get(&conflict.node).ok_or_else(|| {
                    format!(
                        "Move.lock V4 linkage has unknown package '{}'",
                        conflict.node
                    )
                })?
            ),
            conflict.node,
            conflict.conflict
        ));
    }

    Ok(traversal
        .linkage
        .into_iter()
        .map(|(original_id, (_, package_id))| (original_id, package_id))
        .collect())
}

pub(super) fn linked_graph(
    graph: &LockfileV4ValidatedGraph,
) -> Result<LockfileV4ValidatedGraph, String> {
    let packages_by_id = packages_by_id(graph);
    let linkage = linkage_table(graph)?;
    let linked_ids = linkage.values().cloned().collect::<BTreeSet<_>>();

    let mut packages = graph
        .packages
        .iter()
        .filter(|package| linked_ids.contains(&package.id))
        .cloned()
        .collect::<Vec<_>>();
    packages.sort_by(|left, right| {
        left.manifest
            .name
            .cmp(&right.manifest.name)
            .then_with(|| left.id.cmp(&right.id))
    });

    let package_ids = packages
        .iter()
        .map(|package| package.id.clone())
        .collect::<BTreeSet<_>>();
    let mut edge_keys = BTreeSet::new();
    let mut edges = Vec::new();
    for edge in &graph.edges {
        if !package_ids.contains(&edge.from) {
            continue;
        }
        let Some(target_package) = packages_by_id.get(&edge.to) else {
            return Err(format!(
                "Move.lock V4 linkage has unknown package '{}'",
                edge.to
            ));
        };
        let target_original_id = package_linkage_id(target_package);
        let Some(linked_target) = linkage.get(&target_original_id) else {
            continue;
        };
        if !package_ids.contains(linked_target) {
            continue;
        }
        let key = (
            edge.from.clone(),
            linked_target.clone(),
            edge.alias.clone(),
            edge.modes.clone(),
            edge.is_override,
        );
        if edge_keys.insert(key) {
            edges.push(LockfileV4ValidatedEdge {
                from: edge.from.clone(),
                to: linked_target.clone(),
                alias: edge.alias.clone(),
                modes: edge.modes.clone(),
                is_override: edge.is_override,
            });
        }
    }
    let active_aliases_by_from = edges.iter().fold(
        BTreeMap::<String, BTreeMap<String, String>>::new(),
        |mut acc, edge| {
            acc.entry(edge.from.clone())
                .or_default()
                .insert(edge.alias.clone(), edge.to.clone());
            acc
        },
    );
    for package in &mut packages {
        package.active_dep_alias_to_package_name = active_aliases_by_from
            .get(&package.id)
            .cloned()
            .unwrap_or_default();
    }

    Ok(LockfileV4ValidatedGraph {
        root_id: graph.root_id.clone(),
        lockfile_order: packages.iter().map(|package| package.id.clone()).collect(),
        packages,
        edges,
    })
}
