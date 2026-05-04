use std::collections::BTreeMap;
use std::str::FromStr;

use move_core_types::account_address::AccountAddress;
use serde::{Deserialize, Serialize};
use sui_types::base_types::ObjectID;
use toml_edit::{
    visit_mut::{self, VisitMut},
    Array, ArrayOfTables, DocumentMut, InlineTable, Item, KeyMut, Table, Value,
};

use crate::helper::{self, HelperError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootPublicationMetadataInput {
    environment: String,
    files: BTreeMap<String, String>,
}

pub(crate) fn root_publication_metadata_json(input_json: &str) -> String {
    let input: RootPublicationMetadataInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return helper::error(format!(
                "Invalid root publication metadata input: {}",
                error
            ))
        }
    };

    match crate::lockfile_v4_manifest_from_files("root", &input.files, &input.environment) {
        Ok((manifest, _)) => serde_json::json!({
            "status": "ok",
            "packageName": manifest.name,
            "publishedAt": manifest.published_at,
            "originalId": manifest.original_id,
        })
        .to_string(),
        Err(error) => helper::error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum PublicationUpdateCommand {
    Publish,
    Upgrade,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicationUpdateInput {
    command: PublicationUpdateCommand,
    files: BTreeMap<String, String>,
    network: String,
    chain_id: String,
    published_id: String,
    version: u64,
    upgrade_capability: Option<String>,
    toolchain_version: String,
    transaction_digest: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationBuildConfigOutput {
    edition: String,
    flavor: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationUpdatePublicationOutput {
    network: String,
    chain_id: String,
    published_at: String,
    original_id: String,
    version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    toolchain_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    build_config: Option<PublicationBuildConfigOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upgrade_capability: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transaction_digest: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPublicationMigrationInput {
    files: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPublicationMigrationOutput {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_toml: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    move_lock: Option<String>,
}

type EnvironmentName = String;

#[derive(Serialize, Deserialize, Debug, Clone)]
struct WasmSuiBuildParams {
    flavor: String,
    edition: String,
}

impl Default for WasmSuiBuildParams {
    fn default() -> Self {
        Self {
            flavor: "sui".to_string(),
            edition: "2024".to_string(),
        }
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct WasmPublishedID(AccountAddress);

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct WasmOriginalID(AccountAddress);

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "kebab-case")]
struct WasmPublishAddresses {
    published_at: WasmPublishedID,
    original_id: WasmOriginalID,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "kebab-case")]
struct WasmPublishedFile {
    #[serde(default)]
    published: BTreeMap<EnvironmentName, WasmPublication>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct WasmPublication {
    chain_id: String,
    #[serde(flatten)]
    addresses: WasmPublishAddresses,
    version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    toolchain_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    build_config: Option<WasmSuiBuildParams>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upgrade_capability: Option<ObjectID>,
}

impl Serialize for WasmPublishedID {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0.to_canonical_string(true))
    }
}

impl<'de> Deserialize<'de> for WasmPublishedID {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        parse_account_address(&value, "published-at")
            .map(Self)
            .map_err(|error| serde::de::Error::custom(error.to_string()))
    }
}

impl Serialize for WasmOriginalID {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0.to_canonical_string(true))
    }
}

impl<'de> Deserialize<'de> for WasmOriginalID {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        parse_account_address(&value, "original-id")
            .map(Self)
            .map_err(|error| serde::de::Error::custom(error.to_string()))
    }
}

impl std::fmt::Display for WasmPublishedID {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0.to_canonical_string(true))
    }
}

impl std::fmt::Debug for WasmPublishedID {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0.to_canonical_string(true))
    }
}

impl std::fmt::Display for WasmOriginalID {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0.to_canonical_string(true))
    }
}

impl std::fmt::Debug for WasmOriginalID {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0.to_canonical_string(true))
    }
}

fn parse_account_address(value: &str, field_name: &str) -> Result<AccountAddress, HelperError> {
    if value.starts_with("0x") {
        AccountAddress::from_hex_literal(value)
    } else {
        AccountAddress::from_hex(value)
    }
    .map_err(|error| HelperError::new(format!("Invalid {field_name}: {error}")))
}

fn parse_object_id(value: &str) -> Result<ObjectID, HelperError> {
    value
        .parse::<ObjectID>()
        .map_err(|error| HelperError::new(format!("Invalid object id: {error}")))
}

fn parse_published_file(
    files: &BTreeMap<String, String>,
) -> Result<WasmPublishedFile, HelperError> {
    let Some(content) = files.get("Published.toml") else {
        return Ok(WasmPublishedFile::default());
    };
    toml_edit::de::from_str(content)
        .map_err(|error| HelperError::new(format!("Failed to parse Published.toml: {error}")))
}

fn expand_toml_document(toml: &mut DocumentMut) {
    struct Expander;

    impl VisitMut for Expander {
        fn visit_table_mut(&mut self, table: &mut Table) {
            table.set_implicit(true);
            visit_mut::visit_table_mut(self, table);
        }

        fn visit_table_like_kv_mut(&mut self, mut key: KeyMut<'_>, node: &mut Item) {
            key.fmt();

            if let Item::Value(Value::InlineTable(inline_table)) = node {
                let inline_table = std::mem::replace(inline_table, InlineTable::new());
                *node = Item::Table(inline_table.into_table());
            } else if let Item::Value(Value::Array(array)) = node {
                if array.iter().all(|item| item.is_inline_table()) {
                    let array = std::mem::replace(array, Array::new());
                    let mut tables = ArrayOfTables::new();
                    for item in array.into_iter() {
                        let Value::InlineTable(table) = item else {
                            continue;
                        };
                        tables.push(table.into_table());
                    }
                    *node = Item::ArrayOfTables(tables);
                }
                return;
            }

            visit_mut::visit_table_like_kv_mut(self, key, node);
        }
    }

    Expander.visit_document_mut(toml);
}

fn flatten_toml_item(toml: &mut Item) {
    struct Inliner;

    impl VisitMut for Inliner {
        fn visit_table_mut(&mut self, table: &mut Table) {
            table.set_implicit(false);
            visit_mut::visit_table_mut(self, table);
        }

        fn visit_table_like_kv_mut(&mut self, mut key: KeyMut<'_>, node: &mut Item) {
            if let Item::Table(table) = node {
                let table = std::mem::replace(table, Table::new());
                key.fmt();
                *node = Item::Value(Value::InlineTable(table.into_inline_table()));
            }
        }
    }

    Inliner.visit_item_mut(toml);
}

fn render_published_file(published_file: &WasmPublishedFile) -> String {
    let mut toml =
        toml_edit::ser::to_document(published_file).expect("toml serialization succeeds");
    expand_toml_document(&mut toml);

    if let Some(published) = toml["published"].as_table_like_mut() {
        for (_, chain) in published.iter_mut() {
            flatten_toml_item(chain);
        }
    }

    toml.decor_mut().set_prefix(
        "# Generated by Move\n# This file contains metadata about published versions of this package in different environments\n# This file SHOULD be committed to source control\n\n",
    );

    toml.to_string()
}

fn publication_update_output(
    network: String,
    publication: &WasmPublication,
    transaction_digest: Option<String>,
) -> PublicationUpdatePublicationOutput {
    PublicationUpdatePublicationOutput {
        network,
        chain_id: publication.chain_id.clone(),
        published_at: publication.addresses.published_at.to_string(),
        original_id: publication.addresses.original_id.to_string(),
        version: publication.version,
        toolchain_version: publication.toolchain_version.clone(),
        build_config: publication.build_config.as_ref().map(|build_config| {
            PublicationBuildConfigOutput {
                edition: build_config.edition.clone(),
                flavor: build_config.flavor.clone(),
            }
        }),
        upgrade_capability: publication
            .upgrade_capability
            .map(|upgrade_capability| upgrade_capability.to_string()),
        transaction_digest,
    }
}

fn publication_update_impl(
    input: PublicationUpdateInput,
) -> Result<(String, PublicationUpdatePublicationOutput), HelperError> {
    let mut pubfile = parse_published_file(&input.files)?;

    let publication = match input.command {
        PublicationUpdateCommand::Publish => {
            let upgrade_capability = input
                .upgrade_capability
                .as_deref()
                .ok_or_else(|| {
                    HelperError::new("Expected a valid published package with a upgrade cap")
                })
                .and_then(parse_object_id)?;
            let published_id = parse_account_address(&input.published_id, "published-at")?;
            WasmPublication {
                chain_id: input.chain_id,
                addresses: WasmPublishAddresses {
                    published_at: WasmPublishedID(published_id),
                    original_id: WasmOriginalID(published_id),
                },
                version: input.version,
                toolchain_version: Some(input.toolchain_version),
                build_config: Some(WasmSuiBuildParams::default()),
                upgrade_capability: Some(upgrade_capability),
            }
        }
        PublicationUpdateCommand::Upgrade => {
            let publication = pubfile.published.get_mut(&input.network).ok_or_else(|| {
                HelperError::new(format!(
                    "Published.toml has no {} publication record",
                    input.network
                ))
            })?;
            publication.addresses.published_at =
                WasmPublishedID(parse_account_address(&input.published_id, "published-at")?);
            publication.version = input.version;
            publication.build_config = Some(WasmSuiBuildParams::default());
            publication.toolchain_version = Some(input.toolchain_version);
            publication.clone()
        }
    };

    pubfile
        .published
        .insert(input.network.clone(), publication.clone());
    let rendered = render_published_file(&pubfile);
    let output = publication_update_output(input.network, &publication, input.transaction_digest);
    Ok((rendered, output))
}

pub(crate) fn publication_update_json(input_json: &str) -> String {
    let input: PublicationUpdateInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => return helper::error(format!("Invalid publication update input: {}", error)),
    };

    match publication_update_impl(input) {
        Ok((published_toml, publication)) => serde_json::json!({
            "status": "ok",
            "publishedToml": published_toml,
            "publication": publication,
        })
        .to_string(),
        Err(error) => helper::error_from_helper(error),
    }
}

fn parse_legacy_publications(
    lockfile: &toml::map::Map<String, toml::Value>,
) -> Result<BTreeMap<EnvironmentName, WasmPublication>, HelperError> {
    let mut published = BTreeMap::new();
    let Some(envs) = lockfile.get("env").and_then(|value| value.as_table()) else {
        return Ok(published);
    };

    for (name, data) in envs {
        let env_table = data.as_table().ok_or_else(|| {
            HelperError::with_code(
                "malformed_lockfile",
                format!("Could not parse lockfile: expected [env.{name}] to be a table"),
            )
        })?;
        let chain_id = env_table
            .get("chain-id")
            .map(|value| value.as_str().unwrap_or_default().to_string());
        let original_id = env_table
            .get("original-published-id")
            .map(|value| {
                parse_account_address(value.as_str().unwrap_or_default(), "original-published-id")
                    .map_err(|error| {
                        HelperError::with_code("malformed_lockfile", error.to_string())
                    })
            })
            .transpose()?;
        let latest_id = env_table
            .get("latest-published-id")
            .map(|value| {
                parse_account_address(value.as_str().unwrap_or_default(), "latest-published-id")
                    .map_err(|error| {
                        HelperError::with_code("malformed_lockfile", error.to_string())
                    })
            })
            .transpose()?;
        let published_version = env_table
            .get("published-version")
            .map(|value| value.as_str().unwrap_or_default().to_string())
            .and_then(|value| value.parse::<u64>().ok());

        if let (Some(chain_id), Some(original_id), Some(latest_id), Some(version)) =
            (chain_id, original_id, latest_id, published_version)
        {
            published.insert(
                name.clone(),
                WasmPublication {
                    chain_id,
                    addresses: WasmPublishAddresses {
                        original_id: WasmOriginalID(original_id),
                        published_at: WasmPublishedID(latest_id),
                    },
                    version,
                    toolchain_version: None,
                    build_config: None,
                    upgrade_capability: None,
                },
            );
        }
    }

    Ok(published)
}

fn legacy_publication_migration_impl(
    input: LegacyPublicationMigrationInput,
) -> Result<LegacyPublicationMigrationOutput, HelperError> {
    let Some(lockfile_content) = input.files.get("Move.lock") else {
        return Ok(LegacyPublicationMigrationOutput {
            status: "ok",
            published_toml: None,
            move_lock: None,
        });
    };

    let toml_value = toml::from_str::<toml::Value>(lockfile_content).map_err(|error| {
        HelperError::with_code(
            "malformed_lockfile",
            format!("Failed to parse Move.lock: {error}"),
        )
    })?;
    let lockfile = toml_value.as_table().ok_or_else(|| {
        HelperError::with_code(
            "malformed_lockfile",
            "Could not parse lockfile: expected a toml table",
        )
    })?;
    let header = lockfile
        .get("move")
        .and_then(|value| value.as_table())
        .ok_or_else(|| {
            HelperError::with_code(
                "malformed_lockfile",
                "Could not parse lockfile: expected a [move] section",
            )
        })?;
    let version = header
        .get("version")
        .and_then(|value| value.as_integer())
        .unwrap_or(0);

    if version > 3 {
        return Ok(LegacyPublicationMigrationOutput {
            status: "ok",
            published_toml: None,
            move_lock: None,
        });
    }

    if lockfile.get("pinned").is_some() {
        let mut original = DocumentMut::from_str(lockfile_content).map_err(|error| {
            HelperError::with_code(
                "malformed_lockfile",
                format!("Failed to parse Move.lock: {error}"),
            )
        })?;
        let pinned = original.remove("pinned").ok_or_else(|| {
            HelperError::with_code(
                "malformed_lockfile",
                "Could not parse lockfile: expected a [pinned] section",
            )
        })?;
        let mut lockfile = DocumentMut::new();
        lockfile
            .decor_mut()
            .set_prefix("# Generated by move; do not edit\n# This file should be checked in.\n\n");
        lockfile["move"]["version"] = toml_edit::value(4);
        lockfile["pinned"] = pinned;
        return Ok(LegacyPublicationMigrationOutput {
            status: "ok",
            published_toml: None,
            move_lock: Some(lockfile.to_string()),
        });
    }

    let publications = parse_legacy_publications(lockfile)?;
    if publications.is_empty() {
        return Ok(LegacyPublicationMigrationOutput {
            status: "ok",
            published_toml: None,
            move_lock: None,
        });
    }

    let mut pubfile = WasmPublishedFile {
        published: publications,
    };
    if let Some(existing) = input.files.get("Published.toml") {
        let existing: WasmPublishedFile = toml_edit::de::from_str(existing).map_err(|error| {
            HelperError::new(format!("Failed to parse Published.toml: {error}"))
        })?;
        pubfile.published.extend(existing.published);
    }

    Ok(LegacyPublicationMigrationOutput {
        status: "ok",
        published_toml: Some(render_published_file(&pubfile)),
        move_lock: None,
    })
}

pub(crate) fn legacy_publication_migration_json(input_json: &str) -> String {
    let input: LegacyPublicationMigrationInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => {
            return helper::error(format!(
                "Invalid legacy publication migration input: {}",
                error
            ))
        }
    };

    match legacy_publication_migration_impl(input) {
        Ok(output) => serde_json::to_string(&output).unwrap_or_else(|error| {
            serde_json::json!({
                "status": "error",
                "error": format!("Failed to encode legacy publication migration output: {}", error),
            })
            .to_string()
        }),
        Err(error) => helper::error_from_helper(error),
    }
}

#[cfg(feature = "verification")]
pub(crate) fn legacy_publication_migration_from_value(input: serde_json::Value) -> String {
    let input: LegacyPublicationMigrationInput = match serde_json::from_value(input) {
        Ok(input) => input,
        Err(error) => {
            return helper::error_with_code(
                "invalid_helper_input",
                format!("Invalid legacy publication migration input: {}", error),
            );
        }
    };

    match legacy_publication_migration_impl(input) {
        Ok(output) => serde_json::to_string(&output).unwrap_or_else(|error| {
            serde_json::json!({
                "status": "error",
                "error": format!(
                    "Failed to encode legacy publication migration output: {}",
                    error
                ),
            })
            .to_string()
        }),
        Err(error) => helper::error_from_helper(error),
    }
}
