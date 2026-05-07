mod compare;
mod normalize;
mod parse;
mod source_compatibility;
mod types;

use crate::compiler_support::compile_impl;

use compare::{compare_artifacts, first_reference_deserialization_error};
use normalize::{
    normalize_digest_value, normalize_optional_dependencies, normalize_optional_digest,
    normalize_optional_root_address, normalize_string_dependencies,
};
use parse::{bytecode_header_evidence_if_mismatch, current_sui_version, parse_artifact};
use source_compatibility::source_compatibility_evidence;
use types::{
    summary_for_verdict, BuildOutput, BuildVersionMetadata, VerificationInput, VerificationOutput,
    FAILURE_STAGE_COMPILE, FAILURE_STAGE_COMPILER_OUTPUT, FAILURE_STAGE_INPUT_VALIDATION,
    FAILURE_STAGE_VERIFICATION_OUTPUT, VERDICT_BYTECODE_FORMAT_DRIFT,
    VERDICT_BYTECODE_VERSION_HEADER_MISMATCH, VERDICT_UNVERIFIED,
};

pub(crate) fn verify_against_reference(input_json: &str) -> String {
    let output = match verify_against_reference_impl(input_json) {
        Ok(output) => output,
        Err(error) => VerificationOutput {
            status: "invalid_reference",
            verdict: Some(VERDICT_UNVERIFIED),
            summary: Some(summary_for_verdict(VERDICT_UNVERIFIED)),
            failure_stage: Some(FAILURE_STAGE_INPUT_VALIDATION),
            current_build: None,
            reference_summary: None,
            current_summary: None,
            source_compatibility: None,
            bytecode_header_evidence: None,
            differences: Vec::new(),
            bytecode_diffs: Vec::new(),
            error: Some(error),
        },
    };
    serde_json::to_string(&output).unwrap_or_else(|error| {
        serde_json::json!({
            "status": "invalid_reference",
            "verdict": VERDICT_UNVERIFIED,
            "summary": summary_for_verdict(VERDICT_UNVERIFIED),
            "failureStage": FAILURE_STAGE_VERIFICATION_OUTPUT,
            "error": format!("failed to serialize verification result: {}", error),
        })
        .to_string()
    })
}

fn verify_against_reference_impl(input_json: &str) -> Result<VerificationOutput, String> {
    let input: VerificationInput = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid verification input: {}", error))?;
    let source_compatibility =
        source_compatibility_evidence(input.files.as_str(), input.dependencies.as_str());

    let publish_intent = match verification_compile_intent(input.options.as_ref()) {
        Ok(intent) => intent == "publish",
        Err(error) => {
            return Ok(VerificationOutput {
                status: "build_failure",
                verdict: Some(VERDICT_UNVERIFIED),
                summary: Some(summary_for_verdict(VERDICT_UNVERIFIED)),
                failure_stage: Some(FAILURE_STAGE_INPUT_VALIDATION),
                current_build: None,
                reference_summary: None,
                current_summary: None,
                source_compatibility,
                bytecode_header_evidence: None,
                differences: Vec::new(),
                bytecode_diffs: Vec::new(),
                error: Some(error),
            });
        }
    };

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
    let reference_build_version_metadata = BuildVersionMetadata {
        version: input.reference.cli_version,
        build_config: input.reference.build_config,
    };
    let reference = match parse_artifact(
        "reference",
        input.reference.modules,
        reference_dependencies,
        reference_digest,
        None,
        Some(reference_build_version_metadata),
    ) {
        Ok(artifact) => artifact,
        Err(error) => {
            return Ok(VerificationOutput {
                status: "invalid_reference",
                verdict: Some(VERDICT_UNVERIFIED),
                summary: Some(summary_for_verdict(VERDICT_UNVERIFIED)),
                failure_stage: Some(FAILURE_STAGE_INPUT_VALIDATION),
                current_build: None,
                reference_summary: None,
                current_summary: None,
                source_compatibility,
                bytecode_header_evidence: None,
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
        let error = compile_result.output();
        return Ok(VerificationOutput {
            status: "build_failure",
            verdict: Some(VERDICT_UNVERIFIED),
            summary: Some(summary_for_verdict(VERDICT_UNVERIFIED)),
            failure_stage: Some(compile_failure_stage(error.as_str())),
            current_build: None,
            reference_summary: Some(reference.summary),
            current_summary: None,
            source_compatibility,
            bytecode_header_evidence: None,
            differences: Vec::new(),
            bytecode_diffs: Vec::new(),
            error: Some(error),
        });
    }

    let current_build: BuildOutput = match serde_json::from_str(&compile_result.output()) {
        Ok(output) => output,
        Err(error) => {
            return Ok(VerificationOutput {
                status: "build_failure",
                verdict: Some(VERDICT_UNVERIFIED),
                summary: Some(summary_for_verdict(VERDICT_UNVERIFIED)),
                failure_stage: Some(FAILURE_STAGE_COMPILER_OUTPUT),
                current_build: None,
                reference_summary: Some(reference.summary),
                current_summary: None,
                source_compatibility,
                bytecode_header_evidence: None,
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
                verdict: Some(VERDICT_UNVERIFIED),
                summary: Some(summary_for_verdict(VERDICT_UNVERIFIED)),
                failure_stage: Some(FAILURE_STAGE_COMPILER_OUTPUT),
                current_build: Some(current_build),
                reference_summary: Some(reference.summary),
                current_summary: None,
                source_compatibility,
                bytecode_header_evidence: None,
                differences: Vec::new(),
                bytecode_diffs: Vec::new(),
                error: Some(format!("Invalid current build digest: {}", error)),
            })
        }
    };
    let current_root_address = if publish_intent {
        reference_root_address
    } else {
        None
    };
    let current = match parse_artifact(
        "current",
        current_build.modules.clone(),
        current_dependencies,
        Some(current_digest),
        current_root_address,
        Some(BuildVersionMetadata {
            version: Some(current_sui_version()),
            build_config: None,
        }),
    ) {
        Ok(artifact) => artifact,
        Err(error) => {
            return Ok(VerificationOutput {
                status: "build_failure",
                verdict: Some(VERDICT_UNVERIFIED),
                summary: Some(summary_for_verdict(VERDICT_UNVERIFIED)),
                failure_stage: Some(FAILURE_STAGE_COMPILER_OUTPUT),
                current_build: Some(current_build),
                reference_summary: Some(reference.summary),
                current_summary: None,
                source_compatibility,
                bytecode_header_evidence: None,
                differences: Vec::new(),
                bytecode_diffs: Vec::new(),
                error: Some(format!("Invalid current build bytecode: {}", error)),
            })
        }
    };

    let bytecode_header_evidence = bytecode_header_evidence_if_mismatch(&reference, &current);
    if bytecode_header_evidence.is_none() {
        if let Some(error) = first_reference_deserialization_error(&reference) {
            return Ok(VerificationOutput {
                status: "invalid_reference",
                verdict: Some(VERDICT_UNVERIFIED),
                summary: Some(summary_for_verdict(VERDICT_UNVERIFIED)),
                failure_stage: Some(FAILURE_STAGE_INPUT_VALIDATION),
                current_build: Some(current_build),
                reference_summary: Some(reference.summary),
                current_summary: Some(current.summary),
                source_compatibility,
                bytecode_header_evidence: None,
                differences: Vec::new(),
                bytecode_diffs: Vec::new(),
                error: Some(error),
            });
        }
    }

    let comparison = compare_artifacts(
        &reference,
        &current,
        reference_dependencies_provided,
        reference_digest_provided,
    );
    let status = if comparison.differences.is_empty() {
        "verified"
    } else if bytecode_header_evidence.is_some()
        && (comparison.verdict == VERDICT_BYTECODE_VERSION_HEADER_MISMATCH
            || comparison.verdict == VERDICT_BYTECODE_FORMAT_DRIFT
            || comparison.verdict == VERDICT_UNVERIFIED)
    {
        "bytecode_version_mismatch"
    } else {
        "mismatch"
    };

    Ok(VerificationOutput {
        status,
        verdict: Some(comparison.verdict),
        summary: Some(summary_for_verdict(comparison.verdict)),
        failure_stage: None,
        current_build: Some(current_build),
        reference_summary: Some(reference.summary),
        current_summary: Some(current.summary),
        source_compatibility,
        bytecode_header_evidence,
        differences: comparison.differences,
        bytecode_diffs: comparison.bytecode_diffs,
        error: None,
    })
}

fn verification_compile_intent(options: Option<&serde_json::Value>) -> Result<&str, String> {
    let Some(options) = options else {
        return Err(
            "Invalid verification intent '<missing>'. Expected one of: publish, upgrade"
                .to_string(),
        );
    };
    let Some(value) = options.get("compileIntent") else {
        return Err(
            "Invalid verification intent '<missing>'. Expected one of: publish, upgrade"
                .to_string(),
        );
    };
    let Some(intent) = value.as_str() else {
        return Err(format!(
            "Invalid verification intent {}. Expected one of: publish, upgrade",
            value
        ));
    };

    match intent {
        "publish" | "upgrade" => Ok(intent),
        value => Err(format!(
            "Invalid verification intent '{}'. Expected one of: publish, upgrade",
            value
        )),
    }
}

fn compile_failure_stage(error: &str) -> &'static str {
    if error.starts_with("Invalid Move edition ") {
        FAILURE_STAGE_INPUT_VALIDATION
    } else {
        FAILURE_STAGE_COMPILE
    }
}
