use move_core_types::account_address::AccountAddress;
use serde_json::Value;

pub(super) fn normalize_optional_dependencies(
    dependencies: Option<Vec<Value>>,
) -> Result<Vec<String>, String> {
    match dependencies {
        Some(dependencies) => dependencies
            .iter()
            .map(normalize_dependency_value)
            .collect::<Result<Vec<_>, _>>(),
        None => Ok(Vec::new()),
    }
}

pub(super) fn normalize_string_dependencies(dependencies: &[String]) -> Vec<String> {
    dependencies
        .iter()
        .map(|dependency| normalize_dependency_string(dependency))
        .collect()
}

fn normalize_dependency_value(value: &Value) -> Result<String, String> {
    match value {
        Value::String(value) => Ok(normalize_dependency_string(value)),
        _ => Err(format!("Unsupported dependency value: {}", value)),
    }
}

fn normalize_dependency_string(value: &str) -> String {
    let lower = value.trim().to_ascii_lowercase();
    let clean = lower.strip_prefix("0x").unwrap_or(&lower);
    if !clean.is_empty() && clean.len() <= 64 && clean.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return format!("0x{:0>64}", clean);
    }
    lower
}

pub(super) fn normalize_optional_digest(digest: Option<Value>) -> Result<Option<String>, String> {
    match digest {
        Some(digest) => normalize_digest_value(&digest).map(Some),
        None => Ok(None),
    }
}

pub(super) fn normalize_optional_root_address(
    address: Option<String>,
) -> Result<Option<AccountAddress>, String> {
    match address {
        Some(address) => AccountAddress::from_hex_literal(&address)
            .or_else(|_| AccountAddress::from_hex_literal(&format!("0x{}", address)))
            .map(Some)
            .map_err(|error| format!("Invalid reference root address: {}", error)),
        None => Ok(None),
    }
}

pub(super) fn normalize_digest_value(digest: &Value) -> Result<String, String> {
    match digest {
        Value::String(value) => Ok(value.trim().trim_start_matches("0x").to_ascii_lowercase()),
        Value::Array(values) => {
            let mut bytes = Vec::new();
            for value in values {
                let byte = value
                    .as_u64()
                    .ok_or_else(|| format!("Unsupported digest byte: {}", value))?;
                if byte > u8::MAX as u64 {
                    return Err(format!("Digest byte out of range: {}", byte));
                }
                bytes.push(byte as u8);
            }
            Ok(hex::encode(bytes))
        }
        _ => Err(format!("Unsupported digest value: {}", digest)),
    }
}
