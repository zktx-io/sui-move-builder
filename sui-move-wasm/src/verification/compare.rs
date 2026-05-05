use std::collections::{BTreeMap, BTreeSet};

use move_binary_format::file_format_common::TableType;
use sha2::{Digest, Sha256};

use super::types::{
    BytecodeDiff, BytecodeIdentityEvidence, BytecodeShapeEvidence, ChangedTable, ParsedArtifact,
    ParsedModule, VERDICT_EXACT_BYTECODE_MATCH, VERDICT_FORMAT_DRIFT,
    VERDICT_HEADER_ONLY_TOOLCHAIN_DRIFT, VERDICT_ROOT_ADDRESS_SUBSTITUTION_MATCH,
    VERDICT_SEMANTIC_MISMATCH, VERDICT_UNVERIFIED,
};

pub(super) struct ComparisonResult {
    pub(super) differences: Vec<String>,
    pub(super) bytecode_diffs: Vec<BytecodeDiff>,
    pub(super) verdict: &'static str,
}

pub(super) fn compare_artifacts(
    reference: &ParsedArtifact,
    current: &ParsedArtifact,
    should_compare_dependencies: bool,
    compare_digest: bool,
) -> ComparisonResult {
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

    let verdict = aggregate_verdict(&differences, &bytecode_diffs);

    ComparisonResult {
        differences,
        bytecode_diffs,
        verdict,
    }
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
                    if current_module.root_address_conflict.is_some() {
                        differences.push(format!("{}: root address differs", identity));
                        bytecode_diffs.push(bytecode_diff(
                            Some(identity),
                            reference_module,
                            current_module,
                        ));
                        continue;
                    }
                    if raw_modules_equal(reference_module, current_module) {
                        continue;
                    }
                    if root_address_substitution_match(reference_module, current_module) {
                        bytecode_diffs.push(bytecode_diff(
                            Some(identity),
                            reference_module,
                            current_module,
                        ));
                    } else {
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
        if current_module.root_address_conflict.is_some() {
            differences.push(format!(
                "module root address differs at sorted index {}",
                index
            ));
            bytecode_diffs.push(bytecode_diff(None, reference_module, current_module));
            continue;
        }
        if raw_modules_equal(reference_module, current_module) {
            continue;
        }
        if root_address_substitution_match(reference_module, current_module) {
            bytecode_diffs.push(bytecode_diff(None, reference_module, current_module));
        } else {
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

fn raw_modules_equal(reference: &ParsedModule, current: &ParsedModule) -> bool {
    reference.bytes == current.bytes
}

fn modules_semantically_equal(reference: &ParsedModule, current: &ParsedModule) -> bool {
    match (&reference.compiled, &current.compiled) {
        (Some(reference), Some(current)) => reference == current,
        _ => raw_modules_equal(reference, current),
    }
}

fn root_address_substitution_match(reference: &ParsedModule, current: &ParsedModule) -> bool {
    !raw_modules_equal(reference, current)
        && current.address_substitution_applied
        && !bytecode_headers_differ(reference, current)
        && modules_semantically_equal(reference, current)
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
        classification: classify_bytecode_diff(reference, current),
        first_diff_offset: first_diff_offset(&reference.bytes, &current.bytes),
        changed_sections: changed_sections(reference, current),
        changed_tables: changed_tables(&reference.bytes, &current.bytes).unwrap_or_default(),
        raw_bytes_match: raw_modules_equal(reference, current),
        semantic_match: modules_semantically_equal(reference, current),
        root_address_substitution_applied: current.address_substitution_applied,
        root_address_conflict: current.root_address_conflict.clone(),
        same_except_version_word: same_except_version_word(&reference.bytes, &current.bytes),
        identity: identity_evidence(reference, current),
        shape: shape_evidence(reference, current),
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

fn aggregate_verdict(differences: &[String], bytecode_diffs: &[BytecodeDiff]) -> &'static str {
    if differences.is_empty() {
        if bytecode_diffs.is_empty() {
            return VERDICT_EXACT_BYTECODE_MATCH;
        }
        if bytecode_diffs
            .iter()
            .all(|diff| diff.classification == VERDICT_ROOT_ADDRESS_SUBSTITUTION_MATCH)
        {
            return VERDICT_ROOT_ADDRESS_SUBSTITUTION_MATCH;
        }
        return VERDICT_SEMANTIC_MISMATCH;
    }

    let only_module_bytecode_differences = differences.len() == bytecode_diffs.len()
        && differences
            .iter()
            .all(|difference| difference.contains("module bytecode differs"));
    if !only_module_bytecode_differences || bytecode_diffs.is_empty() {
        return VERDICT_SEMANTIC_MISMATCH;
    }

    if bytecode_diffs
        .iter()
        .any(|diff| diff.classification == VERDICT_SEMANTIC_MISMATCH)
    {
        return VERDICT_SEMANTIC_MISMATCH;
    }
    if bytecode_diffs
        .iter()
        .any(|diff| diff.classification == VERDICT_UNVERIFIED)
    {
        return VERDICT_UNVERIFIED;
    }
    if bytecode_diffs
        .iter()
        .all(|diff| diff.classification == VERDICT_HEADER_ONLY_TOOLCHAIN_DRIFT)
    {
        return VERDICT_HEADER_ONLY_TOOLCHAIN_DRIFT;
    }
    if bytecode_diffs.iter().all(|diff| {
        diff.classification == VERDICT_HEADER_ONLY_TOOLCHAIN_DRIFT
            || diff.classification == VERDICT_FORMAT_DRIFT
    }) {
        return VERDICT_FORMAT_DRIFT;
    }

    VERDICT_SEMANTIC_MISMATCH
}

fn classify_bytecode_diff(reference: &ParsedModule, current: &ParsedModule) -> &'static str {
    if current.root_address_conflict.is_some() {
        return VERDICT_SEMANTIC_MISMATCH;
    }

    if root_address_substitution_match(reference, current) {
        return VERDICT_ROOT_ADDRESS_SUBSTITUTION_MATCH;
    }

    if same_except_version_word(&reference.bytes, &current.bytes) {
        return VERDICT_HEADER_ONLY_TOOLCHAIN_DRIFT;
    }

    let Some(changed_tables) = changed_tables(&reference.bytes, &current.bytes) else {
        return VERDICT_UNVERIFIED;
    };
    if bytecode_headers_differ(reference, current)
        && identity_matches(reference, current)
        && shape_matches(reference, current)
        && !changed_tables.is_empty()
        && changed_tables
            .iter()
            .all(|table| table.name == "function_defs")
    {
        return VERDICT_FORMAT_DRIFT;
    }

    VERDICT_SEMANTIC_MISMATCH
}

fn changed_sections(reference: &ParsedModule, current: &ParsedModule) -> Vec<String> {
    let mut sections = Vec::new();
    if bytecode_headers_differ(reference, current) {
        sections.push("header.version".to_string());
    }
    match changed_tables(&reference.bytes, &current.bytes) {
        Some(changed_tables) => sections.extend(changed_tables.into_iter().map(|table| table.name)),
        None if !same_except_version_word(&reference.bytes, &current.bytes) => {
            sections.push("unclassified_bytecode".to_string())
        }
        None => {}
    }
    if sections.is_empty() && first_diff_offset(&reference.bytes, &current.bytes).is_some() {
        sections.push("body_or_trailing".to_string());
    }
    sections
}

fn bytecode_headers_differ(reference: &ParsedModule, current: &ParsedModule) -> bool {
    reference.summary.version != current.summary.version
        || reference.summary.flavor != current.summary.flavor
}

fn identity_evidence(reference: &ParsedModule, current: &ParsedModule) -> BytecodeIdentityEvidence {
    BytecodeIdentityEvidence {
        matches: identity_matches(reference, current),
        reference_name: reference.summary.name.clone(),
        current_build_name: current.summary.name.clone(),
        reference_address: reference.summary.address.clone(),
        current_build_address: current.summary.address.clone(),
        reference_original_address: reference.summary.original_address.clone(),
        current_build_original_address: current.summary.original_address.clone(),
    }
}

fn identity_matches(reference: &ParsedModule, current: &ParsedModule) -> bool {
    matches!(
        (
            &reference.summary.name,
            &current.summary.name,
            &reference.summary.address,
            &current.summary.address
        ),
        (
            Some(reference_name),
            Some(current_name),
            Some(reference_address),
            Some(current_address)
        ) if reference_name == current_name && reference_address == current_address
    )
}

fn shape_evidence(reference: &ParsedModule, current: &ParsedModule) -> BytecodeShapeEvidence {
    BytecodeShapeEvidence {
        matches: shape_matches(reference, current),
        reference_function_count: reference.summary.function_count,
        current_build_function_count: current.summary.function_count,
        reference_struct_count: reference.summary.struct_count,
        current_build_struct_count: current.summary.struct_count,
        reference_constant_count: reference.summary.constant_count,
        current_build_constant_count: current.summary.constant_count,
    }
}

fn shape_matches(reference: &ParsedModule, current: &ParsedModule) -> bool {
    matches!(
        (
            reference.summary.function_count,
            current.summary.function_count,
            reference.summary.struct_count,
            current.summary.struct_count,
            reference.summary.constant_count,
            current.summary.constant_count
        ),
        (
            Some(reference_functions),
            Some(current_functions),
            Some(reference_structs),
            Some(current_structs),
            Some(reference_constants),
            Some(current_constants)
        ) if reference_functions == current_functions
            && reference_structs == current_structs
            && reference_constants == current_constants
    )
}

fn same_except_version_word(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() || left.len() < 8 {
        return false;
    }
    let mut version_word_differs = false;
    for index in 0..left.len() {
        if (4..8).contains(&index) {
            version_word_differs |= left[index] != right[index];
            continue;
        }
        if left[index] != right[index] {
            return false;
        }
    }
    version_word_differs
}

fn changed_tables(left: &[u8], right: &[u8]) -> Option<Vec<ChangedTable>> {
    let left_tables = parse_table_spans(left)?;
    let right_tables = parse_table_spans(right)?;
    let table_names = left_tables
        .keys()
        .chain(right_tables.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut changed = Vec::new();
    for name in table_names {
        let left_table = left_tables.get(&name);
        let right_table = right_tables.get(&name);
        let same_bytes = match (left_table, right_table) {
            (Some(left_table), Some(right_table)) => {
                left_table.byte_count == right_table.byte_count
                    && left[left_table.start..left_table.end]
                        == right[right_table.start..right_table.end]
            }
            _ => false,
        };
        if !same_bytes {
            changed.push(ChangedTable {
                name,
                reference_bytes: left_table.map(|table| table.byte_count),
                current_build_bytes: right_table.map(|table| table.byte_count),
                reference_sha256: left_table.map(|table| sha256_hex(&left[table.start..table.end])),
                current_build_sha256: right_table
                    .map(|table| sha256_hex(&right[table.start..table.end])),
                same_sha256: match (left_table, right_table) {
                    (Some(left_table), Some(right_table)) => {
                        sha256_hex(&left[left_table.start..left_table.end])
                            == sha256_hex(&right[right_table.start..right_table.end])
                    }
                    _ => false,
                },
                same_bytes,
            });
        }
    }
    Some(changed)
}

#[derive(Clone)]
struct TableSpan {
    start: usize,
    end: usize,
    byte_count: usize,
}

fn parse_table_spans(bytes: &[u8]) -> Option<BTreeMap<String, TableSpan>> {
    if bytes.len() < 9 {
        return None;
    }
    let (table_count, mut cursor) = read_uleb128(bytes, 8)?;
    let mut raw_tables = Vec::new();
    for _ in 0..table_count {
        let (kind, next) = read_uleb128(bytes, cursor)?;
        let (relative_start, next) = read_uleb128(bytes, next)?;
        let (byte_count, next) = read_uleb128(bytes, next)?;
        cursor = next;
        raw_tables.push((kind, relative_start, byte_count));
    }

    let header_length = cursor;
    let mut tables = BTreeMap::new();
    for (kind, relative_start, byte_count) in raw_tables {
        let start = header_length.checked_add(relative_start)?;
        let end = start.checked_add(byte_count)?;
        if end > bytes.len() {
            return None;
        }
        tables.insert(
            table_name(kind).to_string(),
            TableSpan {
                start,
                end,
                byte_count,
            },
        );
    }
    Some(tables)
}

fn read_uleb128(bytes: &[u8], offset: usize) -> Option<(usize, usize)> {
    let mut value = 0usize;
    let mut shift = 0usize;
    for (relative_index, byte) in bytes.get(offset..)?.iter().enumerate() {
        value |= ((*byte & 0x7f) as usize).checked_shl(shift as u32)?;
        if (*byte & 0x80) == 0 {
            return Some((value, offset + relative_index + 1));
        }
        shift = shift.checked_add(7)?;
        if shift > 28 {
            return None;
        }
    }
    None
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn table_name(kind: usize) -> &'static str {
    match kind {
        value if value == TableType::MODULE_HANDLES as usize => "module_handles",
        value if value == TableType::DATATYPE_HANDLES as usize => "datatype_handles",
        value if value == TableType::FUNCTION_HANDLES as usize => "function_handles",
        value if value == TableType::FUNCTION_INST as usize => "function_instantiations",
        value if value == TableType::SIGNATURES as usize => "signatures",
        value if value == TableType::CONSTANT_POOL as usize => "constant_pool",
        value if value == TableType::IDENTIFIERS as usize => "identifiers",
        value if value == TableType::ADDRESS_IDENTIFIERS as usize => "address_identifiers",
        value if value == TableType::STRUCT_DEFS as usize => "struct_defs",
        value if value == TableType::STRUCT_DEF_INST as usize => "struct_def_instantiations",
        value if value == TableType::FUNCTION_DEFS as usize => "function_defs",
        value if value == TableType::FIELD_HANDLE as usize => "field_handles",
        value if value == TableType::FIELD_INST as usize => "field_instantiations",
        value if value == TableType::FRIEND_DECLS as usize => "friend_decls",
        value if value == TableType::METADATA as usize => "metadata",
        value if value == TableType::ENUM_DEFS as usize => "enum_defs",
        value if value == TableType::ENUM_DEF_INST as usize => "enum_def_instantiations",
        value if value == TableType::VARIANT_HANDLES as usize => "variant_handles",
        value if value == TableType::VARIANT_INST_HANDLES as usize => {
            "variant_instantiation_handles"
        }
        _ => "unknown",
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
