use base64::{engine::general_purpose, Engine as _};
use move_binary_format::{
    file_format::CompiledModule,
    file_format_common::{BinaryConstants, BinaryFlavor},
};
use move_core_types::account_address::AccountAddress;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

use super::types::{
    ArtifactSummary, BuildVersionMetadata, BytecodeHeaderEvidence, ModuleHeaderEvidence,
    ModuleSummary, ParsedArtifact, ParsedModule, RawHeader, RootAddressConflict,
};

pub(super) fn parse_artifact(
    label: &str,
    modules: Vec<String>,
    dependencies: Vec<String>,
    digest: Option<String>,
    root_address: Option<AccountAddress>,
    build_version_metadata: Option<BuildVersionMetadata>,
) -> Result<ParsedArtifact, String> {
    let mut parsed_modules = Vec::new();
    for (index, module) in modules.into_iter().enumerate() {
        let bytes = general_purpose::STANDARD
            .decode(&module)
            .map_err(|error| format!("{} module {} is not base64: {}", label, index, error))?;
        let (summary, mut compiled) = summarize_module(&bytes)
            .map_err(|error| format!("{} module {}: {}", label, index, error))?;
        let mut summary = summary;
        let mut address_substitution_applied = false;
        let mut root_address_conflict = None;
        if let (Some(root_address), Some(compiled_module)) = (root_address, compiled.as_mut()) {
            match apply_root_address(compiled_module, root_address)
                .map_err(|error| format!("current module {}: {}", index, error))?
            {
                RootAddressAction::NoOp => {}
                RootAddressAction::Substituted { original_address } => {
                    address_substitution_applied = true;
                    summary.original_address = Some(original_address);
                    apply_compiled_identity(&mut summary, compiled_module);
                }
                RootAddressAction::Conflict(conflict) => {
                    root_address_conflict = Some(conflict);
                }
            }
        }
        parsed_modules.push(ParsedModule {
            bytes,
            summary,
            compiled,
            address_substitution_applied,
            root_address_conflict,
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
            cli_version: build_version_metadata
                .as_ref()
                .and_then(|metadata| metadata.version.clone()),
            build_config: build_version_metadata.and_then(|metadata| metadata.build_config),
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
                original_address: None,
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
                original_address: None,
                function_count: None,
                struct_count: None,
                constant_count: None,
                deserialize_error: Some(error.to_string()),
            },
            None,
        )),
    }
}

enum RootAddressAction {
    NoOp,
    Substituted { original_address: String },
    Conflict(RootAddressConflict),
}

fn apply_root_address(
    module: &mut CompiledModule,
    root: AccountAddress,
) -> Result<RootAddressAction, String> {
    let address_idx = module.self_handle().address;
    let Some(address) = module.address_identifiers.get_mut(address_idx.0 as usize) else {
        return Err("Self address field missing".to_string());
    };
    if *address == root {
        return Ok(RootAddressAction::NoOp);
    }
    if *address != AccountAddress::ZERO {
        return Ok(RootAddressAction::Conflict(RootAddressConflict {
            requested_root_address: root.to_canonical_string(true),
            current_build_address: address.to_canonical_string(true),
        }));
    }
    let original_address = address.to_canonical_string(true);
    *address = root;
    Ok(RootAddressAction::Substituted { original_address })
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

pub(super) fn bytecode_header_evidence_if_mismatch(
    reference: &ParsedArtifact,
    current: &ParsedArtifact,
) -> Option<BytecodeHeaderEvidence> {
    let reference_headers = header_set(reference);
    let current_headers = header_set(current);
    if reference_headers == current_headers {
        return None;
    }
    let has_reference_metadata =
        reference.summary.cli_version.is_some() || reference.summary.build_config.is_some();
    Some(BytecodeHeaderEvidence {
        source: if has_reference_metadata {
            "metadata+binary_header"
        } else {
            "binary_header"
        },
        reference: module_header_evidence(reference),
        current_build: module_header_evidence(current),
        reference_cli_version: reference.summary.cli_version.clone(),
        current_verifier_sui_version: current.summary.cli_version.clone(),
        reference_build_config: reference.summary.build_config.clone(),
    })
}

pub(super) fn current_sui_version() -> String {
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

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}
