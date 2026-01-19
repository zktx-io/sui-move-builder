use move_binary_format::errors::PartialVMResult;
use move_vm_runtime::native_functions::NativeContext;
use move_vm_types::{
    loaded_data::runtime_types::Type,
    natives::function::NativeResult,
    values::Value,
};
use move_core_types::gas_algebra::InternalGas;
use std::collections::VecDeque;

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
    // Pop args
    let _ = args.pop_back(); 
    let _ = args.pop_back();
    // Return ENotSupportedError (0)
    Ok(NativeResult::err(context.gas_used(), 0))
}
