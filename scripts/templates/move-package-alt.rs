
pub mod flavor {
    pub struct Vanilla;
    pub mod vanilla {
        pub fn default_environment() -> super::Vanilla { super::Vanilla }
    }
}
