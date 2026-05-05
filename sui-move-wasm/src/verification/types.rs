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
    pub(super) first_diff_offset: Option<usize>,
    pub(super) reference: ModuleSummary,
    pub(super) current_build: ModuleSummary,
}

pub(super) struct ParsedModule {
    pub(super) base64: String,
    pub(super) bytes: Vec<u8>,
    pub(super) summary: ModuleSummary,
    pub(super) compiled: Option<CompiledModule>,
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
