use super::{LockfileV4ValidatedEdge, LockfileV4ValidatedGraph, LockfileV4ValidatedPackage};
use std::collections::BTreeMap;

pub(super) fn packages_by_id(
    graph: &LockfileV4ValidatedGraph,
) -> BTreeMap<String, &LockfileV4ValidatedPackage> {
    graph
        .packages
        .iter()
        .map(|package| (package.id.clone(), package))
        .collect()
}

pub(super) fn edges_by_from(
    edges: &[LockfileV4ValidatedEdge],
) -> BTreeMap<String, Vec<LockfileV4ValidatedEdge>> {
    let mut edges_by_from: BTreeMap<String, Vec<LockfileV4ValidatedEdge>> = BTreeMap::new();
    for edge in edges {
        edges_by_from
            .entry(edge.from.clone())
            .or_default()
            .push(edge.clone());
    }
    for edges in edges_by_from.values_mut() {
        edges.sort_by(|left, right| {
            left.alias
                .cmp(&right.alias)
                .then_with(|| left.to.cmp(&right.to))
        });
    }
    edges_by_from
}
