
pub use self::ecdsa::Signature;
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)] pub struct PublicKey(pub [u8; 64]);
impl PublicKey {
    pub fn from_slice(_: &[u8]) -> Result<Self, Error> { Ok(PublicKey([0; 64])) }
    pub fn serialize_uncompressed(&self) -> [u8; 65] { [0; 65] }
    pub fn serialize(&self) -> [u8; 33] { [0; 33] }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub struct SecretKey(pub [u8; 32]);
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub struct Message(pub [u8; 32]);
pub struct Secp256k1<C>(std::marker::PhantomData<C>);
pub struct All;
pub struct Signing;
pub struct Verification;
impl Secp256k1<All> {
    pub fn new() -> Self { Self(std::marker::PhantomData) }
    pub fn generate_keypair<R: rand::Rng + ?Sized>(&self, _: &mut R) -> (SecretKey, PublicKey) { 
        (SecretKey([0; 32]), PublicKey([0; 64])) 
    }
}
impl Secp256k1<Signing> {
    pub fn signing_only() -> Self { Self(std::marker::PhantomData) }
    pub fn sign_ecdsa(&self, _: &Message, _: &SecretKey) -> Signature { Signature([0; 64]) }
    pub fn sign_ecdsa_recoverable(&self, _: &Message, _: &SecretKey) -> ecdsa::RecoverableSignature { ecdsa::RecoverableSignature([0; 65]) }
}
pub mod constants {
    pub const SECRET_KEY_SIZE: usize = 32;
    pub const COMPACT_SIGNATURE_SIZE: usize = 64;
    pub const PUBLIC_KEY_SIZE: usize = 33;
    pub const MESSAGE_SIZE: usize = 32;
    pub const ONE: [u8; 1] = [1];
    pub const CURVE_ORDER: [u8; 32] = [0xff; 32];
    pub const GENERATOR_X: [u8; 32] = [0xff; 32];
    pub const GENERATOR_Y: [u8; 32] = [0xff; 32];
}
pub mod ecdsa { 
    #[derive(Debug, Clone, Copy, PartialEq, Eq)] pub struct Signature(pub [u8; 64]); 
    impl Signature {
        pub fn verify(&self, _: &super::Message, _: &super::PublicKey) -> Result<(), super::Error> { Ok(()) }
        pub fn from_compact(_: &[u8]) -> Result<Self, super::Error> { Ok(Signature([0; 64])) }
        pub fn serialize_compact(&self) -> [u8; 64] { [0; 64] }
    }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)] pub struct RecoverableSignature(pub [u8; 65]);
    impl RecoverableSignature {
        pub fn from_compact(_: &[u8], _: RecoveryId) -> Result<Self, super::Error> { Ok(RecoverableSignature([0; 65])) }
        pub fn serialize_compact(&self) -> (RecoveryId, [u8; 64]) { (RecoveryId(0), [0; 64]) }
        pub fn to_standard(&self) -> Signature { Signature([0; 64]) }
        pub fn recover(&self, _: &super::Message) -> Result<super::PublicKey, super::Error> { Ok(super::PublicKey([0; 64])) }
    }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)] pub struct RecoveryId(pub i32);
    impl RecoveryId {
        pub fn to_i32(&self) -> i32 { self.0 }
        pub fn from_i32(i: i32) -> Result<Self, super::Error> { Ok(RecoveryId(i)) }
    }
    pub const COMPACT_SIGNATURE_SIZE: usize = 64;
    pub const PUBLIC_KEY_SIZE: usize = 33;
    pub const SECRET_KEY_SIZE: usize = 32;
    pub const MESSAGE_SIZE: usize = 32;

    pub mod constants {
        pub const COMPACT_SIGNATURE_SIZE: usize = 64;
        pub const PUBLIC_KEY_SIZE: usize = 33;
        pub const SECRET_KEY_SIZE: usize = 32;
        pub const MESSAGE_SIZE: usize = 32;
        pub const ONE: [u8; 1] = [1];
        pub const CURVE_ORDER: [u8; 32] = [0xff; 32];
        pub const GENERATOR_X: [u8; 32] = [0xff; 32];
        pub const GENERATOR_Y: [u8; 32] = [0xff; 32];
    }
    pub mod consts { pub use super::constants::*; }
    pub mod ecdsa { pub use super::constants::*; }
    // compile_error!("SECP_STUB_USED_OK"); // Commented out to avoid build failure if successful
}
pub mod schnorr {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)] pub struct Signature(pub [u8; 64]);
}
#[derive(Debug)] pub enum Error { InvalidSignature, InvalidPublicKey, InvalidSecretKey, InvalidRecoveryId, InvalidMessage }
impl core::fmt::Display for Error { fn fmt(&self, f: &mut core::fmt::Formatter) -> core::fmt::Result { write!(f, "") } }
impl std::error::Error for Error {}
impl SecretKey { 
    pub fn from_slice(_: &[u8]) -> Result<Self, Error> { Ok(SecretKey([0; 32])) } 
    pub fn public_key<C>(&self, _: &Secp256k1<C>) -> PublicKey { PublicKey([0; 64]) }
    pub fn secret_bytes(&self) -> [u8; 32] { [0; 32] }
    pub fn non_secure_erase(&mut self) {}
}
impl Message {
    pub fn from_slice(_: &[u8]) -> Result<Self, Error> { Ok(Message([0; 32])) }
}
