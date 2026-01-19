pub use self::ecdsa::Signature;
use k256::ecdsa::{VerifyingKey, SigningKey, Signature as K256Signature, RecoveryId as K256RecoveryId};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::ecdsa::signature::hazmat::{PrehashVerifier, PrehashSigner};
use k256::schnorr::signature::Verifier as SchnorrVerifier;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct PublicKey(pub VerifyingKey);

impl PartialOrd for PublicKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for PublicKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.serialize().cmp(&other.serialize())
    }
}

impl PublicKey {
    pub fn from_slice(data: &[u8]) -> Result<Self, Error> {
        VerifyingKey::from_sec1_bytes(data)
            .map(PublicKey)
            .map_err(|_| Error::InvalidPublicKey)
    }
    pub fn serialize_uncompressed(&self) -> [u8; 65] {
        let encoded = self.0.to_encoded_point(false);
        let bytes = encoded.as_bytes();
        let mut arr = [0u8; 65];
        arr.copy_from_slice(bytes);
        arr
    }
    pub fn serialize(&self) -> [u8; 33] {
        let encoded = self.0.to_encoded_point(true);
        let bytes = encoded.as_bytes();
        let mut arr = [0u8; 33];
        arr.copy_from_slice(bytes);
        arr
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct SecretKey(pub [u8; 32]);

impl SecretKey {
    pub fn from_slice(data: &[u8]) -> Result<Self, Error> {
        if data.len() != 32 { return Err(Error::InvalidSecretKey); }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(data);
        SigningKey::from_bytes(&arr.into()).map_err(|_| Error::InvalidSecretKey)?;
        Ok(SecretKey(arr))
    }
    pub fn public_key<C>(&self, _: &Secp256k1<C>) -> PublicKey {
        let sk = SigningKey::from_bytes(&self.0.into()).unwrap();
        PublicKey(VerifyingKey::from(&sk))
    }
    pub fn secret_bytes(&self) -> [u8; 32] {
        self.0
    }
    pub fn non_secure_erase(&mut self) {
        self.0.fill(0);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Message(pub [u8; 32]);

impl Message {
    pub fn from_slice(data: &[u8]) -> Result<Self, Error> {
        if data.len() != 32 { return Err(Error::InvalidMessage); }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(data);
        Ok(Message(arr))
    }
    pub fn from_digest_slice(data: &[u8]) -> Result<Self, Error> {
        Self::from_slice(data)
    }
    pub fn from_digest(data: [u8; 32]) -> Self {
        Message(data)
    }
}
impl AsRef<[u8]> for Message {
    fn as_ref(&self) -> &[u8] { &self.0 }
}
impl From<[u8; 32]> for Message {
    fn from(data: [u8; 32]) -> Self { Message(data) }
}

pub struct Secp256k1<C>(std::marker::PhantomData<C>);
pub struct All;
pub struct Signing;
pub struct Verification;

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct KeyPair(SecretKey, PublicKey);

impl KeyPair {
    pub fn from_secret_key<C>(secp: &Secp256k1<C>, sk: &SecretKey) -> Self {
        let pk = sk.public_key(secp);
        KeyPair(*sk, pk)
    }
    pub fn public_key(&self) -> PublicKey { self.1 }
    pub fn secret_key(&self) -> SecretKey { self.0 }
}

impl Secp256k1<All> {
    pub fn new() -> Self { Self(std::marker::PhantomData) }
    pub fn generate_keypair<R: rand::Rng + rand::CryptoRng>(&self, rng: &mut R) -> (SecretKey, PublicKey) {
        let signing_key = SigningKey::random(rng);
        let verifying_key = VerifyingKey::from(&signing_key);
        let secret_bytes: [u8; 32] = signing_key.to_bytes().into();
        (SecretKey(secret_bytes), PublicKey(verifying_key))
    }
}

impl Secp256k1<Signing> {
    pub fn signing_only() -> Self { Self(std::marker::PhantomData) }
    pub fn sign_ecdsa(&self, msg: &Message, sk: &SecretKey) -> Signature {
        let signing_key = SigningKey::from_bytes(&sk.0.into()).expect("valid secret key");
        let (signature, _) = signing_key.sign_prehash(&msg.0).expect("sign failed");
        Signature(signature)
    }
    pub fn sign_ecdsa_recoverable(&self, msg: &Message, sk: &SecretKey) -> ecdsa::RecoverableSignature {
        let signing_key = SigningKey::from_bytes(&sk.0.into()).expect("valid secret key");
        let (sig, recid) = signing_key.sign_prehash_recoverable(&msg.0).expect("signing failed");
        ecdsa::RecoverableSignature(sig, recid)
    }

    pub fn sign_schnorr(&self, msg: &Message, keypair: &KeyPair) -> schnorr::Signature {
        let sk_bytes = (keypair.0).0;
        let signing_key = k256::schnorr::SigningKey::from_bytes(&sk_bytes).expect("valid key");
        let sig: k256::schnorr::Signature = k256::schnorr::signature::Signer::sign(&signing_key, &msg.0);
        let bytes: [u8; 64] = sig.to_bytes().into();
        schnorr::Signature(bytes)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct XOnlyPublicKey(pub [u8; 32]);

impl XOnlyPublicKey {
    pub fn from_slice(data: &[u8]) -> Result<Self, Error> {
        if data.len() != 32 { return Err(Error::InvalidPublicKey); }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(data);
        Ok(XOnlyPublicKey(arr))
    }
    pub fn serialize(&self) -> [u8; 32] {
        self.0
    }
}

impl Secp256k1<Verification> {
    pub fn verification_only() -> Self { Self(std::marker::PhantomData) }
}

impl<C> Secp256k1<C> {
     pub fn verify_schnorr(&self, sig: &schnorr::Signature, msg: &Message, pk: &XOnlyPublicKey) -> Result<(), Error> {
        let vk = k256::schnorr::VerifyingKey::from_bytes(&pk.0).map_err(|_| Error::InvalidPublicKey)?; 
        let k256_sig = k256::schnorr::Signature::try_from(sig.as_ref()).map_err(|_| Error::IncorrectSignature)?;
        SchnorrVerifier::verify(&vk, &msg.0, &k256_sig).map_err(|_| Error::IncorrectSignature)
    }
}

pub mod ecdsa {
    use k256::ecdsa::{VerifyingKey, Signature as K256Signature, RecoveryId as K256RecoveryId};
    use k256::ecdsa::signature::hazmat::PrehashVerifier;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    #[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
    pub struct Signature(pub K256Signature);

    impl Signature {
        pub fn verify(&self, msg: &super::Message, pk: &super::PublicKey) -> Result<(), super::Error> {
            pk.0.verify_prehash(&msg.0, &self.0).map_err(|_| super::Error::IncorrectSignature)
        }
        pub fn from_compact(data: &[u8]) -> Result<Self, super::Error> {
            K256Signature::try_from(data).map(Signature).map_err(|_| super::Error::IncorrectSignature)
        }
        pub fn serialize_compact(&self) -> [u8; 64] {
            let bytes = self.0.to_bytes();
            let mut arr = [0u8; 64];
            arr.copy_from_slice(&bytes);
            arr
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    #[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
    pub struct RecoverableSignature(pub K256Signature, pub K256RecoveryId);

    impl RecoverableSignature {
        pub fn from_compact(data: &[u8], recid: RecoveryId) -> Result<Self, super::Error> {
            let sig = K256Signature::try_from(data).map_err(|_| super::Error::IncorrectSignature)?;
            let rec = K256RecoveryId::try_from(recid.0 as u8).map_err(|_| super::Error::InvalidRecoveryId)?;
            Ok(RecoverableSignature(sig, rec))
        }
        pub fn serialize_compact(&self) -> (RecoveryId, [u8; 64]) {
            let bytes = self.0.to_bytes();
            let mut arr = [0u8; 64];
            arr.copy_from_slice(&bytes);
            (RecoveryId(self.1.to_byte() as i32), arr)
        }
        pub fn to_standard(&self) -> Signature {
            Signature(self.0)
        }
        pub fn recover(&self, msg: &super::Message) -> Result<super::PublicKey, super::Error> {
             VerifyingKey::recover_from_prehash(&msg.0, &self.0, self.1)
                .map(super::PublicKey)
                .map_err(|_| super::Error::IncorrectSignature)
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    #[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
    pub struct RecoveryId(pub i32);
    impl RecoveryId {
        pub fn to_i32(&self) -> i32 { self.0 }
        pub fn from_i32(i: i32) -> Result<Self, super::Error> {
            if i < 0 || i > 3 { return Err(super::Error::InvalidRecoveryId); } 
            Ok(RecoveryId(i))
        }
    }
}

pub mod schnorr {
    use k256::schnorr::{Signature as K256SchnorrSig};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)] 
    #[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
    pub struct Signature(pub [u8; 64]);

    impl Signature {
        pub fn from_slice(data: &[u8]) -> Result<Self, super::Error> {
            if data.len() != 64 { return Err(super::Error::IncorrectSignature); }
            let mut arr = [0u8; 64];
            arr.copy_from_slice(data);
            K256SchnorrSig::try_from(data).map_err(|_| super::Error::IncorrectSignature)?;
            Ok(Signature(arr))
        }
        pub fn serialize(&self) -> [u8; 64] {
            self.0
        }
        pub fn as_ref(&self) -> &[u8] {
            &self.0
        }
    }
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

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Error {
    IncorrectSignature,
    InvalidPublicKey,
    InvalidSecretKey,
    InvalidRecoveryId,
    InvalidMessage,
    TweakOutOfRange,
    NotEnoughMemory,
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter) -> core::fmt::Result {
        write!(f, "{:?}", self)
    }
}
impl std::error::Error for Error {}
