use move_compiler::{
    editions::{Edition, Flavor},
    shared::{NumericalAddress, PackagePaths},
};
use move_symbol_pool::Symbol;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default, Deserialize)]
pub(super) struct PackageGroupManifest {
    #[serde(default)]
    pub(super) name: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct PackageGroup {
    pub(crate) name: String,
    #[serde(default, rename = "displayName")]
    pub(super) display_name: Option<String>,
    pub(crate) files: BTreeMap<String, String>,
    #[serde(default)]
    pub(super) edition: Option<String>,
    #[serde(default, rename = "addressMapping")]
    pub(super) address_mapping: Option<BTreeMap<String, String>>,
    #[serde(default, rename = "publishedIdForOutput")]
    pub(super) published_id_for_output: Option<String>,
    #[serde(default)]
    pub(super) manifest: Option<PackageGroupManifest>,
    #[serde(default, rename = "rootDependencyAliases")]
    pub(super) root_dependency_aliases: Vec<String>,
    #[serde(default)]
    pub(super) source: Option<PackageGroupSource>,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum PackageGroupSource {
    Root,
    Git {
        git: String,
        rev: String,
        #[serde(default)]
        subdir: Option<String>,
    },
    Local {
        local: String,
    },
    #[serde(other)]
    Unsupported,
}

pub(crate) enum CompilerInputMode {
    Build {
        root_as_zero: bool,
        set_unpublished_deps_to_zero: bool,
    },
    #[cfg_attr(not(feature = "testing"), allow(dead_code))]
    TestRunner,
}

impl CompilerInputMode {
    pub(super) fn root_test_mode(&self) -> bool {
        match self {
            Self::Build { .. } => false,
            Self::TestRunner => true,
        }
    }

    pub(super) fn dependency_test_mode(&self) -> bool {
        match self {
            Self::Build { .. } => false,
            Self::TestRunner => true,
        }
    }

    pub(super) fn root_as_zero(&self) -> bool {
        match self {
            Self::Build { root_as_zero, .. } => *root_as_zero,
            Self::TestRunner => false,
        }
    }

    pub(super) fn set_unpublished_deps_to_zero(&self) -> bool {
        match self {
            Self::Build {
                set_unpublished_deps_to_zero,
                ..
            } => *set_unpublished_deps_to_zero,
            Self::TestRunner => false,
        }
    }
}

pub(super) struct RootPackageSnapshot {
    pub(super) name: String,
    pub(super) edition: Edition,
    pub(super) flavor: Flavor,
    pub(super) is_legacy: bool,
    pub(super) named_address_map: BTreeMap<String, NumericalAddress>,
    pub(super) root_address_names: BTreeSet<String>,
    pub(super) dependency_aliases: BTreeSet<String>,
}

pub(super) struct ResolvedPackageSnapshot {
    pub(super) package_id: String,
    pub(super) display_name: String,
    pub(super) edition: Edition,
    pub(super) flavor: Flavor,
    pub(super) named_address_map: BTreeMap<String, NumericalAddress>,
    pub(super) dependency_id_for_output: Option<[u8; 32]>,
    pub(super) is_explicit_root_dependency: bool,
}

pub(crate) struct CompilerInput {
    pub(crate) root_package_name: String,
    pub(crate) package_paths: Vec<PackagePaths<Symbol, String>>,
    pub(crate) dependency_ids_by_name: Vec<(String, [u8; 32])>,
}
