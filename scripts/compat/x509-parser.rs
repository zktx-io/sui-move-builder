pub mod certificate {
    #[derive(Clone)]
    pub struct X509Certificate;
    impl X509Certificate {
        pub fn from_der(bytes: &[u8]) -> Result<(&[u8], Self), crate::prelude::X509Error> { Ok((&[], Self)) }
        pub fn public_key(&self) -> &[u8] { &[] }
        pub fn key_usage(&self) -> Result<Option<crate::extensions::KeyUsage>, crate::prelude::X509Error> { Ok(Some(crate::extensions::KeyUsage::default())) }
        pub fn basic_constraints(&self) -> Result<Option<crate::extensions::BasicConstraints>, crate::prelude::X509Error> { Ok(Some(crate::extensions::BasicConstraints::default())) }
        pub fn validity(&self) -> crate::time::Validity { crate::time::Validity }
        pub fn issuer(&self) -> &[u8] { &[] }
        pub fn subject(&self) -> &[u8] { &[] }
        pub fn verify_signature(&self, _: Option<&[u8]>) -> Result<(), crate::prelude::X509Error> { Ok(()) }
    }
}
pub mod public_key {
    pub struct EcKey;
    impl EcKey { pub fn data(&self) -> &[u8] { &[] } }
    pub enum PublicKey { EC(EcKey) }
}
pub mod time {
    #[derive(Clone, Copy)]
    pub struct ASN1Time;
    impl ASN1Time {
        pub fn from_timestamp(_: i64) -> Result<Self, crate::prelude::X509Error> { Ok(Self) }
    }
    pub struct Validity;
    impl Validity {
        pub fn is_valid_at(&self, _: ASN1Time) -> bool { true }
    }
}
pub mod extensions {
    #[derive(Default)]
    pub struct KeyUsage { pub value: KeyUsageValue }
    #[derive(Default)]
    pub struct KeyUsageValue;
    impl KeyUsageValue {
        pub fn digital_signature(&self) -> bool { true }
        pub fn key_cert_sign(&self) -> bool { true }
    }
    #[derive(Default)]
    pub struct BasicConstraints { pub critical: bool, pub value: BasicConstraintsValue }
    #[derive(Default)]
    pub struct BasicConstraintsValue { pub ca: bool, pub path_len_constraint: Option<u64> }
}
pub mod x509 {
    pub struct SubjectPublicKeyInfo;
    impl SubjectPublicKeyInfo {
        pub fn parsed(_: &[u8]) -> Result<crate::public_key::PublicKey, crate::prelude::X509Error> { Ok(crate::public_key::PublicKey::EC(crate::public_key::EcKey)) }
    }
}
pub mod prelude {
    pub trait FromDer {}
    #[derive(Debug)]
    pub struct X509Error;
    impl std::fmt::Display for X509Error {
        fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { write!(f, "X509Error") }
    }
    impl std::error::Error for X509Error {}
}
                    