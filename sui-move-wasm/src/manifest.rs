// Adapted from move-package/src/source_package/parsed_manifest.rs for WASM manifest parsing.
#![allow(dead_code, unused_imports)]

use anyhow::{bail, Result};
use move_compiler::editions::{Edition, Flavor};
use move_core_types::account_address::AccountAddress;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

pub type Symbol = String;

pub type NamedAddress = Symbol;
pub type PackageName = Symbol;
pub type FileName = Symbol;
pub type PackageDigest = Symbol;
pub type DepOverride = bool;

pub type AddressDeclarations = BTreeMap<NamedAddress, Option<String>>;
pub type DevAddressDeclarations = BTreeMap<NamedAddress, String>;
pub type Version = (u64, u64, u64);
pub type Dependencies = BTreeMap<PackageName, Dependency>;
pub type Substitution = BTreeMap<NamedAddress, SubstOrRename>;

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceManifest {
    pub package: PackageInfo,
    pub addresses: Option<AddressDeclarations>,
    // Keep only fields consumed by the WASM compiler path.
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct PackageInfo {
    pub name: PackageName,
    #[serde(default)]
    pub authors: Vec<Symbol>,
    pub license: Option<Symbol>,
    pub edition: Option<String>,
    pub flavor: Option<Flavor>,
    #[serde(rename = "published-at")]
    pub published_at: Option<String>,
    #[serde(rename = "original-id")]
    pub original_id: Option<String>,
    #[serde(default)]
    pub custom_properties: BTreeMap<Symbol, String>,
}

#[derive(Debug, Clone, Eq, PartialEq, PartialOrd, Serialize, Deserialize)]
pub enum Dependency {
    /// Parametrised by the binary that will resolve packages for this dependency.
    External(Symbol),
    Internal(InternalDependency),
}

#[derive(Debug, Clone, Eq, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct InternalDependency {
    pub kind: DependencyKind,
    pub subst: Option<Substitution>,
    pub digest: Option<PackageDigest>,
    pub dep_override: DepOverride,
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub enum DependencyKind {
    Local(PathBuf),
    Git(GitInfo),
    OnChain(OnChainInfo),
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct GitInfo {
    pub git_url: Symbol,
    pub git_rev: Symbol,
    pub subdir: PathBuf,
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct OnChainInfo {
    pub id: Symbol,
}

#[derive(Default, Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct BuildInfo {
    pub language_version: Option<Version>,
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub enum SubstOrRename {
    RenameFrom(NamedAddress),
    Assign(AccountAddress),
}
