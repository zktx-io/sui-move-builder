mod compare;
mod normalize;
mod parse;
mod types;

use crate::compiler_support::compile_impl;

use compare::{compare_artifacts, first_reference_deserialization_error};
use normalize::{
    normalize_digest_value, normalize_optional_dependencies, normalize_optional_digest,
    normalize_optional_root_address, normalize_string_dependencies,
};
use parse::{current_toolchain_version, parse_artifact, toolchain_evidence_if_mismatch};
use types::{
    BuildOutput, ToolchainMetadata, VerificationInput, VerificationOutput, FAILURE_STAGE_COMPILE,
    FAILURE_STAGE_COMPILER_OUTPUT, FAILURE_STAGE_INPUT_VALIDATION,
    FAILURE_STAGE_VERIFICATION_OUTPUT,
};

pub(crate) fn verify_against_reference(input_json: &str) -> String {
    let output = match verify_against_reference_impl(input_json) {
        Ok(output) => output,
        Err(error) => VerificationOutput {
            status: "invalid_reference",
            failure_stage: Some(FAILURE_STAGE_INPUT_VALIDATION),
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
        serde_json::json!({
            "status": "invalid_reference",
            "failureStage": FAILURE_STAGE_VERIFICATION_OUTPUT,
            "error": format!("failed to serialize verification result: {}", error),
        })
        .to_string()
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
                failure_stage: Some(FAILURE_STAGE_INPUT_VALIDATION),
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
            failure_stage: Some(FAILURE_STAGE_COMPILE),
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
                failure_stage: Some(FAILURE_STAGE_COMPILER_OUTPUT),
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
    let current_digest = match normalize_digest_value(&current_build.digest) {
        Ok(digest) => digest,
        Err(error) => {
            return Ok(VerificationOutput {
                status: "build_failure",
                failure_stage: Some(FAILURE_STAGE_COMPILER_OUTPUT),
                current_build: Some(current_build),
                reference_summary: Some(reference.summary),
                current_summary: None,
                toolchain_evidence: None,
                differences: Vec::new(),
                bytecode_diffs: Vec::new(),
                error: Some(format!("Invalid current build digest: {}", error)),
            })
        }
    };
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
                failure_stage: Some(FAILURE_STAGE_COMPILER_OUTPUT),
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
            failure_stage: None,
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
            failure_stage: Some(FAILURE_STAGE_INPUT_VALIDATION),
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
        failure_stage: None,
        current_build: Some(current_build),
        reference_summary: Some(reference.summary),
        current_summary: Some(current.summary),
        toolchain_evidence: None,
        differences,
        bytecode_diffs,
        error: None,
    })
}
