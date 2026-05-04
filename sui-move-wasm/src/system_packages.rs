pub(crate) struct SystemPackageSource {
    pub(crate) git: String,
    pub(crate) rev: String,
    pub(crate) subdir: String,
}

pub(crate) enum SystemPackageSourceError {
    MissingSnapshot,
    UnsupportedSystemDependency,
}

pub(crate) fn system_package_source(
    system_name: &str,
) -> Result<SystemPackageSource, SystemPackageSourceError> {
    let git = option_env!("SUI_SYSTEM_PACKAGE_REPO")
        .filter(|value| !value.is_empty())
        .ok_or(SystemPackageSourceError::MissingSnapshot)?;
    let rev = option_env!("SUI_SYSTEM_PACKAGE_REV")
        .filter(|value| !value.is_empty())
        .ok_or(SystemPackageSourceError::MissingSnapshot)?;
    let subdir = match system_name {
        "std" => option_env!("SUI_SYSTEM_STDLIB_SUBDIR"),
        "sui" => option_env!("SUI_SYSTEM_SUI_SUBDIR"),
        "sui_system" => option_env!("SUI_SYSTEM_SUI_SYSTEM_SUBDIR"),
        "bridge" => option_env!("SUI_SYSTEM_BRIDGE_SUBDIR"),
        _ => None,
    }
    .filter(|value| !value.is_empty())
    .ok_or(SystemPackageSourceError::UnsupportedSystemDependency)?;

    Ok(SystemPackageSource {
        git: git.to_string(),
        rev: rev.to_string(),
        subdir: subdir.to_string(),
    })
}
