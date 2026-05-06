use crate::helper::HelperError;
use crate::lockfile_v4::{LockfileV4PackageManifest, LockfileV4Source};
use crate::manifest_digest::{CombinedDependencySource, CombinedMoveDependency};

use super::types::{ManifestPackagePlanDependency, ManifestPackagePlanSource};

fn manifest_plan_resolve_relative_path(parent_path: &str, local_path: &str) -> String {
    let mut parts = parent_path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    for part in local_path.split('/').filter(|part| !part.is_empty()) {
        match part {
            "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value.to_string()),
        }
    }

    parts.join("/")
}

fn system_package_git_source(
    package_name: &str,
    dep_name: &str,
    system_name: &str,
) -> Result<ManifestPackagePlanSource, HelperError> {
    let source =
        crate::system_packages::system_package_source(system_name).map_err(|code| match code {
            crate::system_packages::SystemPackageSourceError::MissingSnapshot => HelperError::with_code(
                "missing_system_package_snapshot",
                format!(
                    "Dependency '{}.{}' uses system package '{}' but the pinned system package snapshot is unavailable",
                    package_name, dep_name, system_name
                ),
            ),
            crate::system_packages::SystemPackageSourceError::UnsupportedSystemDependency => {
                HelperError::with_code(
                    "unsupported_system_dependency",
                    format!(
                        "Dependency '{}.{}' has unsupported system package '{}'",
                        package_name, dep_name, system_name
                    ),
                )
            }
        })?;

    Ok(ManifestPackagePlanSource::Git {
        git: source.git,
        rev: source.rev,
        subdir: Some(source.subdir),
        is_implicit: true,
    })
}

fn manifest_plan_dependency_source_from_combined(
    package_name: &str,
    dep: &CombinedMoveDependency,
    parent_source: &LockfileV4Source,
) -> Result<ManifestPackagePlanSource, HelperError> {
    match &dep.source {
        CombinedDependencySource::Git { git, rev, subdir } => {
            let rev = rev.as_ref().ok_or_else(|| {
                HelperError::new(format!(
                    "Dependency '{}.{}' has git source without rev",
                    package_name, dep.name
                ))
            })?;
            Ok(ManifestPackagePlanSource::Git {
                git: git.clone(),
                rev: rev.clone(),
                subdir: subdir.clone(),
                is_implicit: false,
            })
        }
        CombinedDependencySource::Local { local } => match parent_source {
            LockfileV4Source::Git { git, rev, subdir } => {
                let resolved_subdir = manifest_plan_resolve_relative_path(
                    subdir.as_deref().unwrap_or_default(),
                    local,
                );
                Ok(ManifestPackagePlanSource::Git {
                    git: git.clone(),
                    rev: rev.clone(),
                    subdir: Some(resolved_subdir),
                    is_implicit: false,
                })
            }
            LockfileV4Source::Local {
                local: parent_local,
            } => Ok(ManifestPackagePlanSource::Local {
                local: manifest_plan_resolve_relative_path(parent_local, local),
            }),
            LockfileV4Source::Root => Ok(ManifestPackagePlanSource::Local {
                local: local.clone(),
            }),
            LockfileV4Source::Unsupported => Err(HelperError::with_code(
                "unsupported_dependency_source",
                format!(
                    "Dependency '{}.{}' has unsupported parent source",
                    package_name, dep.name
                ),
            )),
        },
        CombinedDependencySource::System { system } => {
            system_package_git_source(package_name, &dep.name, system)
        }
    }
}

pub(super) fn manifest_plan_dependencies_from_manifest(
    manifest: &LockfileV4PackageManifest,
    parent_source: &LockfileV4Source,
) -> Result<Vec<ManifestPackagePlanDependency>, HelperError> {
    let mut dependencies = Vec::new();
    for dep in &manifest.combined_dependencies {
        dependencies.push(ManifestPackagePlanDependency {
            name: dep.name.clone(),
            source: manifest_plan_dependency_source_from_combined(
                &manifest.name,
                dep,
                parent_source,
            )?,
            modes: dep.modes.clone().unwrap_or_default(),
            is_override: dep.is_override,
            subst: dep.subst.clone(),
        });
    }
    Ok(dependencies)
}

pub(super) fn plan_source_to_lockfile_source(
    source: &ManifestPackagePlanSource,
) -> LockfileV4Source {
    match source {
        ManifestPackagePlanSource::Git {
            git, rev, subdir, ..
        } => LockfileV4Source::Git {
            git: git.clone(),
            rev: rev.clone(),
            subdir: subdir.clone(),
        },
        ManifestPackagePlanSource::Local { local } => LockfileV4Source::Local {
            local: local.clone(),
        },
    }
}

fn dependency_is_implicit(dep: &ManifestPackagePlanDependency) -> bool {
    matches!(
        dep.source,
        ManifestPackagePlanSource::Git {
            is_implicit: true,
            ..
        }
    )
}

pub(super) fn sort_dependencies(dependencies: &mut [ManifestPackagePlanDependency]) {
    dependencies.sort_by(|left, right| {
        let left_implicit = dependency_is_implicit(left);
        let right_implicit = dependency_is_implicit(right);
        right_implicit
            .cmp(&left_implicit)
            .then_with(|| left.name.cmp(&right.name))
    });
}
