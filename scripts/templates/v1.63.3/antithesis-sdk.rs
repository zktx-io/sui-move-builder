#[macro_export]
macro_rules! assert_reachable { ($($arg:tt)*) => {} }
#[macro_export]
macro_rules! assert_sometimes { ($($arg:tt)*) => {} }
#[macro_export]
macro_rules! assert_unreachable { ($($arg:tt)*) => {} }

pub mod random { 
    #[derive(Clone)]
    pub struct AntithesisRng;
    impl rand::RngCore for AntithesisRng {
        fn next_u32(&mut self) -> u32 { 0 }
        fn next_u64(&mut self) -> u64 { 0 }
        fn fill_bytes(&mut self, dest: &mut [u8]) { for x in dest { *x = 0; } }
        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand::Error> { self.fill_bytes(dest); Ok(()) }
    }
    impl rand::CryptoRng for AntithesisRng {}
}
                    