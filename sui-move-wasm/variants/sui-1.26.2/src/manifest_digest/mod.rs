mod digest;
mod legacy;
mod toml_parse;
mod types;

pub(crate) use digest::compute_manifest_digest_from_combined;
#[cfg(not(feature = "verification"))]
pub(crate) use digest::{compute_manifest_digest, compute_manifest_digest_from_move_toml};
pub(crate) use legacy::{
    is_legacy_system_dep_name, legacy_implicit_dependencies, normalize_legacy_name_to_identifier,
};
pub(crate) use toml_parse::combined_dependencies_from_move_toml;
pub(crate) use types::{
    combined_dependency_matches_modes, CombinedDependencySource, CombinedMoveDependency,
    ManifestPackagePlanSubst,
};
