#![allow(dead_code)]
#![allow(unused_imports)]

pub mod zk_login_utils { 
    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)] 
    pub struct Bn254FrElement;
    impl Bn254FrElement {
        pub fn padded(&self) -> Vec<u8> { vec![] }
        pub fn unpadded(&self) -> &[u8] { &[] }
    }
}

pub mod bn254 {
    pub mod poseidon {
        pub fn poseidon_bytes(_: &Vec<Vec<u8>>) -> Result<Vec<u8>, String> { Ok(vec![]) }
    }
    pub mod api {
        pub const SCALAR_SIZE: usize = 32;
        pub fn prepare_pvk_bytes(_: &[u8]) -> Result<Vec<Vec<u8>>, String> { Ok(vec![]) }
        pub fn verify_groth16_in_bytes(_: &[u8], _: &[u8], _: &[u8], _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, String> { Ok(true) }
    }

    pub mod zk_login {
        use fastcrypto::error::FastCryptoError;
        use crate::zk_login_utils::Bn254FrElement;
        
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize, Hash)]
        pub struct JWK { pub alg: String, pub kty: String, pub use_: String, pub n: String, pub e: String }
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize, Hash)]
        pub struct JwkId { pub iss: String, pub kid: String }
        
        #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
        pub struct OIDCProvider;
        impl OIDCProvider { pub fn from_iss(_iss: &str) -> Result<Self, String> { Ok(OIDCProvider) } }
        
        #[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
        pub struct ZkLoginInputs;
        
        static MOCK_FR: Bn254FrElement = Bn254FrElement;

        impl ZkLoginInputs {
            pub fn get_iss(&self) -> &str { "mock_iss" }
            pub fn get_address_seed(&self) -> &Bn254FrElement { &MOCK_FR }
            pub fn init(&self) -> Result<(), FastCryptoError> { Ok(()) }
            pub fn from_json<T: AsRef<[u8]>>(_s: &str, _seed: T) -> Result<Self, String> { Ok(ZkLoginInputs) }
        }
    }
    pub mod zk_login_api {
        use super::zk_login::{ZkLoginInputs, JWK, JwkId};
        use im::HashMap;
        use fastcrypto::error::FastCryptoError;
        #[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
        pub struct ZkLoginEnv;
        
        pub fn verify_zk_login(_inputs: &ZkLoginInputs, _max: u64, _pk: &[u8], _jwks: &HashMap<JwkId, JWK>, _env: &ZkLoginEnv) -> Result<(), FastCryptoError> { Ok(()) }
        pub fn verify_zk_login_id(_addr: &[u8], _kcn: &str, _kcv: &str, _aud: &str, _iss: &str, _pin: &str) -> Result<(), FastCryptoError> { Ok(()) }
        pub fn verify_zk_login_iss(_addr: &[u8], _seed: &str, _iss: &str) -> Result<(), FastCryptoError> { Ok(()) }
    }
}

pub mod bls12381 { 
    pub struct Fr; 
    pub mod api {
        pub fn prepare_pvk_bytes(_: &[u8]) -> Result<Vec<Vec<u8>>, String> { Ok(vec![]) }
        pub fn verify_groth16_in_bytes(_: &[u8], _: &[u8], _: &[u8], _: &[u8], _: &[u8], _: &[u8]) -> Result<bool, String> { Ok(true) }
    }
}
pub mod dummy_circuits {}
pub mod groth16 {}
                    