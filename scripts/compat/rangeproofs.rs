use move_binary_format::errors::PartialVMResult;
use move_core_types::gas_algebra::InternalGas;
use move_vm_runtime::{
    execution::{Type, values::Value},
    natives::functions::{NativeContext, NativeResult},
};
use std::collections::VecDeque;

pub const NOT_SUPPORTED: u64 = 0;

#[derive(Clone)]
pub struct BulletproofsCostParams {
    pub verify_bulletproofs_ristretto255_base_cost: Option<InternalGas>,
    pub verify_bulletproofs_ristretto255_cost_per_bit_and_commitment: Option<InternalGas>,
}

pub fn verify_bulletproofs_ristretto255(
    context: &mut NativeContext,
    _ty_args: Vec<Type>,
    mut args: VecDeque<Value>,
) -> PartialVMResult<NativeResult> {
    let _ = args.pop_back();
    let _ = args.pop_back();
    let _ = args.pop_back();
    Ok(NativeResult::err(context.gas_used(), NOT_SUPPORTED))
}
