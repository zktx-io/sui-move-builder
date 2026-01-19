pub fn maybe_grow<R, F: FnOnce() -> R>(_red_zone: usize, _stack_size: usize, callback: F) -> R {
    callback()
}
pub fn remaining_stack() -> Option<usize> {
    None
}
                    