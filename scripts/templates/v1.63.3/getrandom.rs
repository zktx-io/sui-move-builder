
use core::num::NonZeroU32;
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Error(NonZeroU32);
impl Error {
    pub const fn raw_os_error(&self) -> Option<i32> { Some(self.0.get() as i32) }
}
impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { f.write_str("getrandom stub error") }
}
impl std::error::Error for Error {}

pub fn getrandom(dest: &mut [u8]) -> Result<(), Error> {
    for b in dest.iter_mut() { *b = 0; }
    Ok(())
}
pub fn fill(dest: &mut [u8]) -> Result<(), Error> { getrandom(dest) }
pub fn u32() -> Result<u32, Error> { Ok(0) }
pub fn u64() -> Result<u64, Error> { Ok(0) }
