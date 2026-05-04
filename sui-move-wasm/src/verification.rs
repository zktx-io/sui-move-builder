use base64::{engine::general_purpose, Engine as _};
use move_binary_format::{
    file_format::CompiledModule,
    file_format_common::{BinaryConstants, BinaryFlavor},
};
use move_core_types::account_address::AccountAddress;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::compile_impl;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerificationInput {
    files: String,
    dependencies: String,
    #[serde(default)]
    options: Option<Value>,
    reference: ReferenceArtifact,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceArtifact {
    modules: Vec<String>,
    #[serde(default)]
    dependencies: Option<Vec<Value>>,
    #[serde(default)]
    digest: Option<Value>,
    #[serde(default, rename = "rootAddress")]
    root_address: Option<String>,
    #[serde(default, rename = "packageId")]
    package_id: Option<String>,
    #[serde(default, rename = "toolchainVersion")]
    toolchain_version: Option<String>,
    #[serde(default, rename = "buildConfig")]
    build_config: Option<ReferenceBuildConfig>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReferenceBuildConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    edition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    flavor: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BuildOutput {
    modules: Vec<String>,
    #[serde(default)]
    dependencies: Vec<String>,
    digest: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    warnings: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerificationOutput {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_build: Option<BuildOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reference_summary: Option<ArtifactSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_summary: Option<ArtifactSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    toolchain_evidence: Option<ToolchainEvidence>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    differences: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    bytecode_diffs: Vec<BytecodeDiff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ArtifactSummary {
    module_count: usize,
    per_module: Vec<ModuleSummary>,
    dependencies: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    toolchain_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    build_config: Option<ReferenceBuildConfig>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModuleSummary {
    length: usize,
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    flavor: Option<u8>,
    sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    function_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    struct_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    constant_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deserialize_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolchainEvidence {
    source: &'static str,
    reference: Vec<ModuleHeaderEvidence>,
    current_build: Vec<ModuleHeaderEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reference_toolchain_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_build_toolchain_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reference_build_config: Option<ReferenceBuildConfig>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModuleHeaderEvidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    address: Option<String>,
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    flavor: Option<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BytecodeDiff {
    #[serde(skip_serializing_if = "Option::is_none")]
    module: Option<String>,
    first_diff_offset: Option<usize>,
    reference: ModuleSummary,
    current_build: ModuleSummary,
}

struct ParsedModule {
    base64: String,
    bytes: Vec<u8>,
    summary: ModuleSummary,
    compiled: Option<CompiledModule>,
}

struct ParsedArtifact {
    modules: Vec<ParsedModule>,
    summary: ArtifactSummary,
}

#[derive(Clone, Copy)]
struct RawHeader {
    version: u32,
    flavor: Option<u8>,
}

#[derive(Clone)]
struct ToolchainMetadata {
    version: Option<String>,
    build_config: Option<ReferenceBuildConfig>,
}

pub(crate) fn verify_against_reference(input_json: &str) -> String {
    let output = match verify_against_reference_impl(input_json) {
        Ok(output) => output,
        Err(error) => VerificationOutput {
            status: "invalid_reference",
            current_build: None,
            reference_summary: None,
            current_summary: None,
            toolchain_evidence: None,
            differences: Vec::new(),
            bytecode_diffs: Vec::new(),
            error: Some(error),
        },
    };
    serde_json::to_string(&output).unwrap_or_else(|error| {
        format!(
            r#"{{"status":"invalid_reference","error":"failed to serialize verification result: {}"}}"#,
            json_escape(&error.to_string())
        )
    })
}

fn verify_against_reference_impl(input_json: &str) -> Result<VerificationOutput, String> {
    let input: VerificationInput = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid verification input: {}", error))?;

    let reference_dependencies_provided = input.reference.dependencies.is_some();
    let reference_digest_provided = input.reference.digest.is_some();
    let reference_dependencies = normalize_optional_dependencies(input.reference.dependencies)?;
    let reference_digest = normalize_optional_digest(input.reference.digest)?;
    let reference_root_address = normalize_optional_root_address(
        input
            .reference
            .root_address
            .clone()
            .or(input.reference.package_id.clone()),
    )?;
    let reference_toolchain_metadata = ToolchainMetadata {
        version: input.reference.toolchain_version,
        build_config: input.reference.build_config,
    };
    let reference = match parse_artifact(
        "reference",
        input.reference.modules,
        reference_dependencies,
        reference_digest,
        None,
        Some(reference_toolchain_metadata),
    ) {
        Ok(artifact) => artifact,
        Err(error) => {
            return Ok(VerificationOutput {
                status: "invalid_reference",
                current_build: None,
                reference_summary: None,
                current_summary: None,
                toolchain_evidence: None,
                differences: Vec::new(),
                bytecode_diffs: Vec::new(),
                error: Some(error),
            })
        }
    };

    let options_json = match input.options {
        Some(options) => Some(
            serde_json::to_string(&options)
                .map_err(|error| format!("Invalid verification options: {}", error))?,
        ),
        None => None,
    };
    let compile_result = compile_impl(&input.files, &input.dependencies, options_json);
    if !compile_result.success() {
        return Ok(VerificationOutput {
            status: "build_failure",
            current_build: None,
            reference_summary: Some(reference.summary),
            current_summary: None,
            toolchain_evidence: None,
            differences: Vec::new(),
            bytecode_diffs: Vec::new(),
            error: Some(compile_result.output()),
        });
    }

    let current_build: BuildOutput = match serde_json::from_str(&compile_result.output()) {
        Ok(output) => output,
        Err(error) => {
            return Ok(VerificationOutput {
                status: "build_failure",
                current_build: None,
                reference_summary: Some(reference.summary),
                current_summary: None,
                toolchain_evidence: None,
                differences: Vec::new(),
                bytecode_diffs: Vec::new(),
                error: Some(format!("Invalid current build output: {}", error)),
            })
        }
    };

    let current_dependencies = normalize_string_dependencies(&current_build.dependencies);
    let current_digest = normalize_digest_value(&current_build.digest)?;
    let current = match parse_artifact(
        "current",
        current_build.modules.clone(),
        current_dependencies,
        Some(current_digest),
        reference_root_address,
        Some(ToolchainMetadata {
            version: Some(current_toolchain_version()),
            build_config: None,
        }),
    ) {
        Ok(artifact) => artifact,
        Err(error) => {
            return Ok(VerificationOutput {
                status: "build_failure",
                current_build: Some(current_build),
                reference_summary: Some(reference.summary),
                current_summary: None,
                toolchain_evidence: None,
                differences: Vec::new(),
                bytecode_diffs: Vec::new(),
                error: Some(format!("Invalid current build bytecode: {}", error)),
            })
        }
    };

    let toolchain_evidence = toolchain_evidence_if_mismatch(&reference, &current);
    if let Some(toolchain_evidence) = toolchain_evidence {
        return Ok(VerificationOutput {
            status: "toolchain_mismatch",
            current_build: Some(current_build),
            reference_summary: Some(reference.summary),
            current_summary: Some(current.summary),
            toolchain_evidence: Some(toolchain_evidence),
            differences: Vec::new(),
            bytecode_diffs: Vec::new(),
            error: None,
        });
    }

    if let Some(error) = first_reference_deserialization_error(&reference) {
        return Ok(VerificationOutput {
            status: "invalid_reference",
            current_build: Some(current_build),
            reference_summary: Some(reference.summary),
            current_summary: Some(current.summary),
            toolchain_evidence: None,
            differences: Vec::new(),
            bytecode_diffs: Vec::new(),
            error: Some(error),
        });
    }

    let (differences, bytecode_diffs) = compare_artifacts(
        &reference,
        &current,
        reference_dependencies_provided,
        reference_digest_provided,
    );
    let status = if differences.is_empty() {
        "verified"
    } else {
        "mismatch"
    };

    Ok(VerificationOutput {
        status,
        current_build: Some(current_build),
        reference_summary: Some(reference.summary),
        current_summary: Some(current.summary),
        toolchain_evidence: None,
        differences,
        bytecode_diffs,
        error: None,
    })
}

fn parse_artifact(
    label: &str,
    modules: Vec<String>,
    dependencies: Vec<String>,
    digest: Option<String>,
    root_address: Option<AccountAddress>,
    toolchain_metadata: Option<ToolchainMetadata>,
) -> Result<ParsedArtifact, String> {
    let mut parsed_modules = Vec::new();
    for (index, module) in modules.into_iter().enumerate() {
        let bytes = general_purpose::STANDARD
            .decode(&module)
            .map_err(|error| format!("{} module {} is not base64: {}", label, index, error))?;
        let (summary, mut compiled) = summarize_module(&bytes)
            .map_err(|error| format!("{} module {}: {}", label, index, error))?;
        let mut summary = summary;
        if let (Some(root_address), Some(compiled_module)) = (root_address, compiled.as_mut()) {
            substitute_root_address(compiled_module, root_address)
                .map_err(|error| format!("current module {}: {}", index, error))?;
            apply_compiled_identity(&mut summary, compiled_module);
        }
        parsed_modules.push(ParsedModule {
            base64: module,
            bytes,
            summary,
            compiled,
        });
    }
    let per_module = parsed_modules
        .iter()
        .map(|module| module.summary.clone())
        .collect::<Vec<_>>();
    Ok(ParsedArtifact {
        summary: ArtifactSummary {
            module_count: parsed_modules.len(),
            per_module,
            dependencies,
            digest,
            toolchain_version: toolchain_metadata
                .as_ref()
                .and_then(|metadata| metadata.version.clone()),
            build_config: toolchain_metadata.and_then(|metadata| metadata.build_config),
        },
        modules: parsed_modules,
    })
}

fn summarize_module(bytes: &[u8]) -> Result<(ModuleSummary, Option<CompiledModule>), String> {
    let header =
        parse_raw_header(bytes).ok_or_else(|| "invalid Move bytecode header".to_string())?;
    let sha256 = sha256_hex(bytes);
    match CompiledModule::deserialize_with_defaults(bytes) {
        Ok(module) => {
            let self_id = module.self_id();
            let summary = ModuleSummary {
                length: bytes.len(),
                version: header.version,
                flavor: header.flavor,
                sha256,
                name: Some(self_id.name().to_string()),
                address: Some(self_id.address().to_canonical_string(true)),
                function_count: Some(module.function_defs().len()),
                struct_count: Some(module.struct_defs().len()),
                constant_count: Some(module.constant_pool().len()),
                deserialize_error: None,
            };
            Ok((summary, Some(module)))
        }
        Err(error) => Ok((
            ModuleSummary {
                length: bytes.len(),
                version: header.version,
                flavor: header.flavor,
                sha256,
                name: None,
                address: None,
                function_count: None,
                struct_count: None,
                constant_count: None,
                deserialize_error: Some(error.to_string()),
            },
            None,
        )),
    }
}

fn substitute_root_address(
    module: &mut CompiledModule,
    root: AccountAddress,
) -> Result<(), String> {
    let address_idx = module.self_handle().address;
    let Some(address) = module.address_identifiers.get_mut(address_idx.0 as usize) else {
        return Err("Self address field missing".to_string());
    };
    if *address != AccountAddress::ZERO {
        return Err("Self address already populated".to_string());
    }
    *address = root;
    Ok(())
}

fn apply_compiled_identity(summary: &mut ModuleSummary, module: &CompiledModule) {
    let self_id = module.self_id();
    summary.name = Some(self_id.name().to_string());
    summary.address = Some(self_id.address().to_canonical_string(true));
}

fn parse_raw_header(bytes: &[u8]) -> Option<RawHeader> {
    if bytes.len() < BinaryConstants::MOVE_MAGIC_SIZE + 4 {
        return None;
    }
    let magic = [bytes[0], bytes[1], bytes[2], bytes[3]];
    if magic != BinaryConstants::MOVE_MAGIC && magic != BinaryConstants::UNPUBLISHABLE_MAGIC {
        return None;
    }
    let raw_version = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    Some(RawHeader {
        version: BinaryFlavor::decode_version(raw_version),
        flavor: BinaryFlavor::decode_flavor(raw_version),
    })
}

fn toolchain_evidence_if_mismatch(
    reference: &ParsedArtifact,
    current: &ParsedArtifact,
) -> Option<ToolchainEvidence> {
    let reference_headers = header_set(reference);
    let current_headers = header_set(current);
    if reference_headers == current_headers {
        return None;
    }
    let has_reference_metadata =
        reference.summary.toolchain_version.is_some() || reference.summary.build_config.is_some();
    Some(ToolchainEvidence {
        source: if has_reference_metadata {
            "metadata+binary_header"
        } else {
            "binary_header"
        },
        reference: module_header_evidence(reference),
        current_build: module_header_evidence(current),
        reference_toolchain_version: reference.summary.toolchain_version.clone(),
        current_build_toolchain_version: current.summary.toolchain_version.clone(),
        reference_build_config: reference.summary.build_config.clone(),
    })
}

fn current_toolchain_version() -> String {
    option_env!("SUI_VERSION").unwrap_or("unknown").to_string()
}

fn header_set(artifact: &ParsedArtifact) -> BTreeSet<(u32, Option<u8>)> {
    artifact
        .modules
        .iter()
        .map(|module| (module.summary.version, module.summary.flavor))
        .collect()
}

fn module_header_evidence(artifact: &ParsedArtifact) -> Vec<ModuleHeaderEvidence> {
    artifact
        .modules
        .iter()
        .map(|module| ModuleHeaderEvidence {
            name: module.summary.name.clone(),
            address: module.summary.address.clone(),
            version: module.summary.version,
            flavor: module.summary.flavor,
        })
        .collect()
}

fn compare_artifacts(
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
    for index in 0..reference_modules.len().min(current_modules.len()) {
        let reference_module = reference_modules[index];
        let current_module = current_modules[index];
        if !modules_equal(reference_module, current_module) {
            differences.push(format!("module bytecode differs at sorted index {}", index));
            bytecode_diffs.push(bytecode_diff(None, reference_module, current_module));
            return;
        }
    }
}

fn modules_equal(reference: &ParsedModule, current: &ParsedModule) -> bool {
    match (&reference.compiled, &current.compiled) {
        (Some(reference), Some(current)) => reference == current,
        _ => reference.base64 == current.base64,
    }
}

fn first_reference_deserialization_error(reference: &ParsedArtifact) -> Option<String> {
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

fn normalize_optional_dependencies(
    dependencies: Option<Vec<Value>>,
) -> Result<Vec<String>, String> {
    match dependencies {
        Some(dependencies) => dependencies
            .iter()
            .map(normalize_dependency_value)
            .collect::<Result<Vec<_>, _>>(),
        None => Ok(Vec::new()),
    }
}

fn normalize_string_dependencies(dependencies: &[String]) -> Vec<String> {
    dependencies
        .iter()
        .map(|dependency| normalize_dependency_string(dependency))
        .collect()
}

fn normalize_dependency_value(value: &Value) -> Result<String, String> {
    match value {
        Value::String(value) => Ok(normalize_dependency_string(value)),
        _ => Err(format!("Unsupported dependency value: {}", value)),
    }
}

fn normalize_dependency_string(value: &str) -> String {
    let lower = value.trim().to_ascii_lowercase();
    let clean = lower.strip_prefix("0x").unwrap_or(&lower);
    if !clean.is_empty() && clean.len() <= 64 && clean.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return format!("0x{:0>64}", clean);
    }
    lower
}

fn normalize_optional_digest(digest: Option<Value>) -> Result<Option<String>, String> {
    match digest {
        Some(digest) => normalize_digest_value(&digest).map(Some),
        None => Ok(None),
    }
}

fn normalize_optional_root_address(
    address: Option<String>,
) -> Result<Option<AccountAddress>, String> {
    match address {
        Some(address) => AccountAddress::from_hex_literal(&address)
            .or_else(|_| AccountAddress::from_hex_literal(&format!("0x{}", address)))
            .map(Some)
            .map_err(|error| format!("Invalid reference root address: {}", error)),
        None => Ok(None),
    }
}

fn normalize_digest_value(digest: &Value) -> Result<String, String> {
    match digest {
        Value::String(value) => Ok(value.trim().trim_start_matches("0x").to_ascii_lowercase()),
        Value::Array(values) => {
            let mut bytes = Vec::new();
            for value in values {
                let byte = value
                    .as_u64()
                    .ok_or_else(|| format!("Unsupported digest byte: {}", value))?;
                if byte > u8::MAX as u64 {
                    return Err(format!("Digest byte out of range: {}", byte));
                }
                bytes.push(byte as u8);
            }
            Ok(hex::encode(bytes))
        }
        _ => Err(format!("Unsupported digest value: {}", digest)),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn json_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
