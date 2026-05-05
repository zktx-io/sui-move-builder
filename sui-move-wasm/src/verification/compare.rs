use std::collections::{BTreeMap, BTreeSet};

use super::types::{BytecodeDiff, ParsedArtifact, ParsedModule};

pub(super) fn compare_artifacts(
    reference: &ParsedArtifact,
    current: &ParsedArtifact,
    should_compare_dependencies: bool,
    compare_digest: bool,
) -> (Vec<String>, Vec<BytecodeDiff>) {
    let mut differences = Vec::new();
    let mut bytecode_diffs = Vec::new();

    compare_modules(reference, current, &mut differences, &mut bytecode_diffs);
    if should_compare_dependencies {
        compare_dependencies(reference, current, &mut differences);
    }
    if compare_digest && reference.summary.digest != current.summary.digest {
        differences.push(format!(
            "digest differs: reference={}, currentBuild={}",
            reference.summary.digest.as_deref().unwrap_or("<missing>"),
            current.summary.digest.as_deref().unwrap_or("<missing>")
        ));
    }

    (differences, bytecode_diffs)
}

fn compare_modules(
    reference: &ParsedArtifact,
    current: &ParsedArtifact,
    differences: &mut Vec<String>,
    bytecode_diffs: &mut Vec<BytecodeDiff>,
) {
    if reference.modules.len() != current.modules.len() {
        differences.push(format!(
            "module count differs: reference={}, currentBuild={}",
            reference.modules.len(),
            current.modules.len()
        ));
    }

    let reference_by_identity = modules_by_identity(reference);
    let current_by_identity = modules_by_identity(current);
    if reference_by_identity.len() == reference.modules.len()
        && current_by_identity.len() == current.modules.len()
    {
        let identities = reference_by_identity
            .keys()
            .chain(current_by_identity.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        for identity in identities {
            match (
                reference_by_identity.get(&identity),
                current_by_identity.get(&identity),
            ) {
                (Some(reference_module), Some(current_module)) => {
                    if !modules_equal(reference_module, current_module) {
                        differences.push(format!("{}: module bytecode differs", identity));
                        bytecode_diffs.push(bytecode_diff(
                            Some(identity),
                            reference_module,
                            current_module,
                        ));
                    }
                }
                (Some(_), None) => {
                    differences.push(format!("{}: missing in currentBuild", identity))
                }
                (None, Some(_)) => differences.push(format!("{}: missing in reference", identity)),
                (None, None) => {}
            }
        }
        return;
    }

    let reference_modules = sorted_modules(reference);
    let current_modules = sorted_modules(current);
    let shared_len = reference_modules.len().min(current_modules.len());
    for index in 0..shared_len {
        let reference_module = reference_modules[index];
        let current_module = current_modules[index];
        if !modules_equal(reference_module, current_module) {
            differences.push(format!("module bytecode differs at sorted index {}", index));
            bytecode_diffs.push(bytecode_diff(None, reference_module, current_module));
        }
    }
    for index in shared_len..reference_modules.len() {
        differences.push(format!("extra reference module at sorted index {}", index));
    }
    for index in shared_len..current_modules.len() {
        differences.push(format!(
            "extra currentBuild module at sorted index {}",
            index
        ));
    }
}

fn modules_equal(reference: &ParsedModule, current: &ParsedModule) -> bool {
    match (&reference.compiled, &current.compiled) {
        (Some(reference), Some(current)) => reference == current,
        _ => reference.base64 == current.base64,
    }
}

pub(super) fn first_reference_deserialization_error(reference: &ParsedArtifact) -> Option<String> {
    reference.modules.iter().find_map(|module| {
        module
            .summary
            .deserialize_error
            .as_ref()
            .map(|error| format!("Reference module cannot be deserialized: {}", error))
    })
}

fn modules_by_identity<'a>(artifact: &'a ParsedArtifact) -> BTreeMap<String, &'a ParsedModule> {
    let mut modules = BTreeMap::new();
    for module in &artifact.modules {
        if let (Some(address), Some(name)) = (&module.summary.address, &module.summary.name) {
            modules.insert(format!("{}::{}", address, name), module);
        }
    }
    modules
}

fn sorted_modules(artifact: &ParsedArtifact) -> Vec<&ParsedModule> {
    let mut modules = artifact.modules.iter().collect::<Vec<_>>();
    modules.sort_by(|left, right| {
        let left_key = module_sort_key(left);
        let right_key = module_sort_key(right);
        left_key.cmp(&right_key)
    });
    modules
}

fn module_sort_key(module: &ParsedModule) -> String {
    module
        .summary
        .name
        .clone()
        .unwrap_or_else(|| module.summary.sha256.clone())
}

fn bytecode_diff(
    name: Option<String>,
    reference: &ParsedModule,
    current: &ParsedModule,
) -> BytecodeDiff {
    BytecodeDiff {
        module: name,
        first_diff_offset: first_diff_offset(&reference.bytes, &current.bytes),
        reference: reference.summary.clone(),
        current_build: current.summary.clone(),
    }
}

fn first_diff_offset(left: &[u8], right: &[u8]) -> Option<usize> {
    let min = left.len().min(right.len());
    for index in 0..min {
        if left[index] != right[index] {
            return Some(index);
        }
    }
    if left.len() == right.len() {
        None
    } else {
        Some(min)
    }
}

fn compare_dependencies(
    reference: &ParsedArtifact,
    current: &ParsedArtifact,
    differences: &mut Vec<String>,
) {
    let mut reference_dependencies = reference.summary.dependencies.clone();
    let mut current_dependencies = current.summary.dependencies.clone();
    reference_dependencies.sort();
    current_dependencies.sort();
    if reference_dependencies != current_dependencies {
        differences.push(format!(
            "dependencies differ: reference={:?}, currentBuild={:?}",
            reference_dependencies, current_dependencies
        ));
    }
}
