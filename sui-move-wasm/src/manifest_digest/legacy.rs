use std::collections::BTreeSet;

fn dependency_aliases_from_section(value: &toml::Value, section: &str) -> BTreeSet<String> {
    value
        .get(section)
        .and_then(|deps| deps.as_table())
        .map(|deps| deps.keys().cloned().collect())
        .unwrap_or_default()
}

pub(crate) fn legacy_implicit_dependencies(
    legacy_name: &str,
    value: &toml::Value,
    implicit_dependencies: bool,
) -> bool {
    if !implicit_dependencies || is_active_legacy_system_dep_name(legacy_name) {
        return false;
    }

    let mut aliases = dependency_aliases_from_section(value, "dependencies");
    aliases.extend(dependency_aliases_from_section(value, "dev-dependencies"));
    !aliases
        .iter()
        .any(|alias| is_active_legacy_system_dep_name(alias))
}

pub(crate) fn normalize_legacy_name_to_identifier(name: &str) -> String {
    let mut result = name
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>();
    if result.is_empty() || result == "_" {
        return "__".to_string();
    }
    if result
        .chars()
        .next()
        .map(|ch| ch.is_ascii_digit())
        .unwrap_or(false)
    {
        result.insert(0, '_');
    }
    result
}

pub(crate) fn is_legacy_system_dep_name(name: &str) -> bool {
    matches!(
        name,
        "Sui" | "MoveStdlib" | "Bridge" | "DeepBook" | "SuiSystem"
    )
}

fn is_active_legacy_system_dep_name(name: &str) -> bool {
    is_legacy_system_dep_name(name) && name != "DeepBook"
}
