pub mod flavor {
    #[derive(Debug, Clone, Copy, Default)]
    pub struct Vanilla;
    impl Vanilla {
        pub fn default_environment() -> Self {
            Self
        }
    }

    pub mod vanilla {
        pub use super::Vanilla;
    }
}

pub use flavor::Vanilla;
