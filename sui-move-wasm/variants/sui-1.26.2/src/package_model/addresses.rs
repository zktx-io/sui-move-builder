use move_compiler::shared::NumberFormat;
use move_compiler::shared::NumericalAddress;

pub(crate) fn parse_hex_address_to_bytes(addr: &str) -> Option<[u8; 32]> {
    let addr_clean = addr.trim().trim_start_matches("0x");
    if addr_clean.is_empty() {
        return None;
    }
    let addr_str_normalized = if addr_clean.len() % 2 != 0 {
        format!("0{}", addr_clean)
    } else {
        addr_clean.to_string()
    };
    let bytes = hex::decode(addr_str_normalized).ok()?;
    if bytes.len() > 32 {
        return None;
    }
    let mut addr_bytes = [0u8; 32];
    let start = 32 - bytes.len();
    addr_bytes[start..].copy_from_slice(&bytes);
    Some(addr_bytes)
}

pub(super) fn numerical_address(addr: &str) -> Option<NumericalAddress> {
    NumericalAddress::parse_str(addr).ok()
}

pub(super) fn zero_numerical_address() -> Option<NumericalAddress> {
    numerical_address("0x0")
}

pub(super) fn numerical_address_from_bytes(bytes: &[u8; 32]) -> NumericalAddress {
    NumericalAddress::new(*bytes, NumberFormat::Hex)
}

pub(super) fn source_address_is_unpublished(addr_opt: Option<&String>) -> bool {
    match addr_opt.map(|addr| addr.trim()) {
        None => true,
        Some("_") => true,
        _ => false,
    }
}
