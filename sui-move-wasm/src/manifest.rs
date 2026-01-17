// Copied from move-package/src/source_package/parsed_manifest.rs
// Adapted for WASM compatibility (removed file system dependencies where possible)

use anyhow::{Result, bail};
use move_compiler::editions::{Edition, Flavor};
use move_core_types::account_address::AccountAddress;
// use move_symbol_pool::symbol::Symbol; // Removed to avoid WASM issues
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

pub type Symbol = String; // Polyfill Symbol as String

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
    // Removed unused fields to avoid strict parsing issues with 'deps'
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct PackageInfo {
    pub name: PackageName,
    #[serde(default)]
    pub authors: Vec<Symbol>,
    pub license: Option<Symbol>,
    pub edition: Option<String>, // Changed to String for manual parsing
    pub flavor: Option<Flavor>,
    #[serde(rename = "published-at")]
    pub published_at: Option<String>, // Changed to String for safety
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

// NOTE: reroot and normalize_path removed as we don't need them for basic parsing in WASM context
