
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Errno(pub i32);
impl core::fmt::Display for Errno {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { write!(f, "errno {}", self.0) }
}
pub fn errno() -> Errno { Errno(0) }
pub fn set_errno(_: Errno) {}
