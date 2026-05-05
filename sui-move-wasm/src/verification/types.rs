use move_binary_format::file_format::CompiledModule;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VerificationInput {
    pub(super) files: String,
    pub(super) dependencies: String,
    #[serde(default)]
    pub(super) options: Option<Value>,
    pub(super) reference: ReferenceArtifact,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReferenceArtifact {
    pub(super) modules: Vec<String>,
    #[serde(default)]
    pub(super) dependencies: Option<Vec<Value>>,
    #[serde(default)]
    pub(super) digest: Option<Value>,
    #[serde(default, rename = "rootAddress")]
    pub(super) root_address: Option<String>,
    #[serde(default, rename = "packageId")]
    pub(super) package_id: Option<String>,
    #[serde(default, rename = "toolchainVersion")]
    pub(super) toolchain_version: Option<String>,
    #[serde(default, rename = "buildConfig")]
    pub(super) build_config: Option<ReferenceBuildConfig>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReferenceBuildConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) edition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) flavor: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuildOutput {
    pub(super) modules: Vec<String>,
    #[serde(default)]
    pub(super) dependencies: Vec<String>,
    pub(super) digest: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) warnings: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VerificationOutput {
    pub(super) status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) verdict: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) summary: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) failure_stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_build: Option<BuildOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_summary: Option<ArtifactSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_summary: Option<ArtifactSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) toolchain_evidence: Option<ToolchainEvidence>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) differences: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) bytecode_diffs: Vec<BytecodeDiff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArtifactSummary {
    pub(super) module_count: usize,
    pub(super) per_module: Vec<ModuleSummary>,
    pub(super) dependencies: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) toolchain_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) build_config: Option<ReferenceBuildConfig>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModuleSummary {
    pub(super) length: usize,
    pub(super) version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) flavor: Option<u8>,
    pub(super) sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) original_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) function_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) struct_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) constant_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) deserialize_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ToolchainEvidence {
    pub(super) source: &'static str,
    pub(super) reference: Vec<ModuleHeaderEvidence>,
    pub(super) current_build: Vec<ModuleHeaderEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_toolchain_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_build_toolchain_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_build_config: Option<ReferenceBuildConfig>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModuleHeaderEvidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) address: Option<String>,
    pub(super) version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) flavor: Option<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BytecodeDiff {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) module: Option<String>,
    pub(super) classification: &'static str,
    pub(super) first_diff_offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) changed_sections: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) changed_tables: Vec<ChangedTable>,
    pub(super) raw_bytes_match: bool,
    pub(super) semantic_match: bool,
    pub(super) root_address_substitution_applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) root_address_conflict: Option<RootAddressConflict>,
    pub(super) same_except_version_word: bool,
    pub(super) identity: BytecodeIdentityEvidence,
    pub(super) shape: BytecodeShapeEvidence,
    pub(super) reference: ModuleSummary,
    pub(super) current_build: ModuleSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChangedTable {
    pub(super) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_build_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_build_sha256: Option<String>,
    pub(super) same_sha256: bool,
    pub(super) same_bytes: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct RootAddressConflict {
    pub(super) requested_root_address: String,
    pub(super) current_build_address: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BytecodeIdentityEvidence {
    pub(super) matches: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_build_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_build_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_original_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_build_original_address: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BytecodeShapeEvidence {
    pub(super) matches: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_function_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_build_function_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_struct_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_build_struct_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_constant_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current_build_constant_count: Option<usize>,
}

pub(super) struct ParsedModule {
    pub(super) bytes: Vec<u8>,
    pub(super) summary: ModuleSummary,
    pub(super) compiled: Option<CompiledModule>,
    pub(super) address_substitution_applied: bool,
    pub(super) root_address_conflict: Option<RootAddressConflict>,
}

pub(super) struct ParsedArtifact {
    pub(super) modules: Vec<ParsedModule>,
    pub(super) summary: ArtifactSummary,
}

#[derive(Clone, Copy)]
pub(super) struct RawHeader {
    pub(super) version: u32,
    pub(super) flavor: Option<u8>,
}

#[derive(Clone)]
pub(super) struct ToolchainMetadata {
    pub(super) version: Option<String>,
    pub(super) build_config: Option<ReferenceBuildConfig>,
}

pub(super) const FAILURE_STAGE_INPUT_VALIDATION: &str = "input_validation";
pub(super) const FAILURE_STAGE_COMPILE: &str = "compile";
pub(super) const FAILURE_STAGE_COMPILER_OUTPUT: &str = "compiler_output";
pub(super) const FAILURE_STAGE_VERIFICATION_OUTPUT: &str = "verification_output";

pub(super) const VERDICT_EXACT_BYTECODE_MATCH: &str = "exact_bytecode_match";
pub(super) const VERDICT_ROOT_ADDRESS_SUBSTITUTION_MATCH: &str = "root_address_substitution_match";
pub(super) const VERDICT_HEADER_ONLY_TOOLCHAIN_DRIFT: &str = "header_only_toolchain_drift";
pub(super) const VERDICT_FORMAT_DRIFT: &str = "format_drift";
pub(super) const VERDICT_SEMANTIC_MISMATCH: &str = "semantic_mismatch";
pub(super) const VERDICT_UNVERIFIED: &str = "unverified";

pub(super) fn summary_for_verdict(verdict: &str) -> &'static str {
    match verdict {
        VERDICT_EXACT_BYTECODE_MATCH => {
            "Reference bytecode matches the current source build byte-for-byte under the pinned Sui toolchain."
        }
        VERDICT_ROOT_ADDRESS_SUBSTITUTION_MATCH => {
            "Reference bytecode matches the current source build after applying the documented root address substitution."
        }
        VERDICT_HEADER_ONLY_TOOLCHAIN_DRIFT => {
            "Reference bytecode differs from the current build only in the bytecode version header."
        }
        VERDICT_FORMAT_DRIFT => {
            "Reference bytecode differs in bytecode version metadata and recognized function definition serialization while module identity and shape match."
        }
        VERDICT_SEMANTIC_MISMATCH => {
            "Reference bytecode differs from the current source build beyond recognized toolchain format drift."
        }
        _ => "The verifier could not prove source provenance for this input.",
    }
}
