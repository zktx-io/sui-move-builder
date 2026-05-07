use move_compiler::editions::Edition;
use serde::Deserialize;
use std::collections::BTreeMap;

use super::types::{SourceCompatibility, SourceEditionEvidence};

#[derive(Deserialize)]
struct CompatibilityPackageGroup {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    edition: Option<String>,
}

#[derive(Deserialize)]
struct MoveTomlPackage {
    name: Option<String>,
    edition: Option<String>,
}

#[derive(Deserialize)]
struct MoveTomlManifest {
    package: Option<MoveTomlPackage>,
}

pub(super) fn source_compatibility_evidence(
    files_json: &str,
    dependencies_json: &str,
) -> Option<SourceCompatibility> {
    let root_files = serde_json::from_str::<BTreeMap<String, String>>(files_json).ok()?;
    let supported_editions = supported_editions();
    let default_edition = Edition::LEGACY.to_string();
    let root = source_edition_evidence(
        "root",
        None,
        None,
        &root_files,
        &supported_editions,
        &default_edition,
    );
    let mut dependencies = Vec::new();
    let dependency_groups =
        serde_json::from_str::<Vec<CompatibilityPackageGroup>>(dependencies_json)
            .unwrap_or_default();
    for group in dependency_groups {
        dependencies.push(source_edition_evidence(
            "dependency",
            group.name,
            group.edition,
            &group.files,
            &supported_editions,
            &default_edition,
        ));
    }

    let mut unsupported_editions = Vec::new();
    if !root.supported {
        unsupported_editions.push(root.clone());
    }
    for dependency in &dependencies {
        if !dependency.supported {
            unsupported_editions.push(dependency.clone());
        }
    }

    Some(SourceCompatibility {
        supported_editions,
        default_edition,
        root: Some(root),
        dependencies,
        unsupported_editions,
    })
}

fn supported_editions() -> Vec<String> {
    Edition::VALID
        .iter()
        .map(|edition| edition.to_string())
        .collect()
}

fn source_edition_evidence(
    source: &'static str,
    package_name: Option<String>,
    edition_override: Option<String>,
    files: &BTreeMap<String, String>,
    supported_editions: &[String],
    default_edition: &str,
) -> SourceEditionEvidence {
    let manifest_path = find_manifest_path(files);
    let manifest = manifest_path
        .as_ref()
        .and_then(|path| files.get(path))
        .and_then(|content| toml::from_str::<MoveTomlManifest>(content).ok())
        .and_then(|manifest| manifest.package);
    let declared_edition = edition_override.or_else(|| {
        manifest
            .as_ref()
            .and_then(|package| package.edition.as_ref())
            .cloned()
    });
    let effective_edition = declared_edition
        .clone()
        .unwrap_or_else(|| default_edition.to_string());
    let defaulted = declared_edition.is_none();
    SourceEditionEvidence {
        source,
        package_name: package_name.or_else(|| manifest.and_then(|package| package.name)),
        manifest_path,
        declared_edition,
        effective_edition: effective_edition.clone(),
        defaulted,
        supported: supported_editions
            .iter()
            .any(|edition| edition == &effective_edition),
    }
}

fn find_manifest_path(files: &BTreeMap<String, String>) -> Option<String> {
    if files.contains_key("Move.toml") {
        return Some("Move.toml".to_string());
    }
    files
        .keys()
        .filter(|path| path.ends_with("/Move.toml") || path.ends_with("Move.toml"))
        .min_by_key(|path| path.matches('/').count())
        .cloned()
}
