pub mod class_group { 
    pub mod discriminant { pub const DISCRIMINANT_3072: usize = 3072; }
    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct QuadraticForm;
    impl QuadraticForm {
        pub fn hash_to_group_with_default_parameters(_: &[u8], _: &usize) -> Result<Self, fastcrypto::error::FastCryptoError> { Ok(QuadraticForm) }
    }
}
pub mod vdf { 
    pub trait VDF {} 
    pub mod wesolowski { 
        #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
        pub struct DefaultVDF;
        impl DefaultVDF {
            pub fn new(_: usize, _: u64) -> Self { DefaultVDF }
            pub fn verify(&self, _: &super::super::class_group::QuadraticForm, _: &super::super::class_group::QuadraticForm, _: &super::super::class_group::QuadraticForm) -> Result<(), fastcrypto::error::FastCryptoError> { Ok(()) }
        } 
        impl super::VDF for DefaultVDF {} 
    } 
}
                    