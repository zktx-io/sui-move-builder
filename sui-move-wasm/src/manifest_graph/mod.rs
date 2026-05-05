mod builder;
mod order;
mod resolve;
mod source;
mod types;

#[cfg(feature = "verification")]
pub(crate) use resolve::resolve_package_groups_from_value;

#[cfg(not(feature = "verification"))]
pub(crate) use resolve::resolve_package_groups_json;
