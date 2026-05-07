use move_binary_format::errors::PartialVMResult;
use move_core_types::gas_algebra::InternalGas;
use move_vm_runtime::{
    execution::{values::Value, Type},
    natives::functions::{NativeContext, NativeResult},
};
use std::collections::VecDeque;

pub const NOT_SUPPORTED_ERROR: u64 = 0;

#[derive(Clone)]
pub struct NitroAttestationCostParams {
    pub parse_base_cost: Option<InternalGas>,
    pub parse_cost_per_byte: Option<InternalGas>,
    pub verify_base_cost: Option<InternalGas>,
    pub verify_cost_per_cert: Option<InternalGas>,
}

pub fn load_nitro_attestation_internal(
    context: &mut NativeContext,
    _ty_args: Vec<Type>,
    mut args: VecDeque<Value>,
) -> PartialVMResult<NativeResult> {
    let _ = args.pop_back();
    let _ = args.pop_back();
    Ok(NativeResult::err(context.gas_used(), NOT_SUPPORTED_ERROR))
}
