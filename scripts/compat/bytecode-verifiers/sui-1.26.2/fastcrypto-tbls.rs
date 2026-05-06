#![allow(dead_code)]
#![allow(unused_imports)]
pub mod dkg_v1 {
    use fastcrypto::error::FastCryptoError;

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct Poly<T>(std::marker::PhantomData<T>);
    impl<T> Poly<T> {
        pub fn degree(&self) -> u64 {
            0
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct Message<Pk, EncPk> {
        pub sender: u16,
        pub vss_pk: Poly<Pk>,
        pub encrypted_shares: Vec<EncPk>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct Confirmation<EncPk> {
        pub sender: u16,
        pub complaints: Vec<u16>,
        pub phantom: std::marker::PhantomData<EncPk>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct Party<Pk, EncPk>(std::marker::PhantomData<(Pk, EncPk)>);

    impl<Pk, EncPk> Party<Pk, EncPk> {
        pub fn create_message<R>(
            &self,
            _rng: &mut R,
        ) -> Result<Message<Pk, EncPk>, FastCryptoError> {
            Ok(Message {
                sender: 0,
                vss_pk: Poly(std::marker::PhantomData),
                encrypted_shares: vec![],
            })
        }
    }
}
pub mod dkg {
    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct EncryptedShares<EG>(std::marker::PhantomData<EG>);

    impl<EG> EncryptedShares<EG> {
        pub fn len(&self) -> usize {
            0
        }

        pub fn size_of<T>(&self, _ops: &mut T) -> usize {
            0
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct Complaint<G>(std::marker::PhantomData<G>);

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct Confirmation<G> {
        pub complaints: Vec<u16>,
        pub phantom: std::marker::PhantomData<G>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct Message<G, EG> {
        pub encrypted_shares: EncryptedShares<EG>,
        pub phantom: std::marker::PhantomData<G>,
    }
}
pub mod types {
    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct Signature;
}
pub mod tbls {
    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct PartialSignature<T>(std::marker::PhantomData<T>);
}
pub mod ecies_v1 {
    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct PrivateKey<T>(std::marker::PhantomData<T>);
}
pub mod ecies {
    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct Encryption<G>(std::marker::PhantomData<G>);

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct MultiRecipientEncryption<G>(std::marker::PhantomData<G>);

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct PrivateKey<T>(std::marker::PhantomData<T>);

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct PublicKey<T>(std::marker::PhantomData<T>);
}
pub mod dl_verification {}
pub mod mocked_dkg {}
pub mod nizk {}
pub mod nodes {}
pub mod polynomial {
    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct Poly<T>(std::marker::PhantomData<T>);

    impl<T> Poly<T> {
        pub fn degree(&self) -> u64 {
            0
        }
    }
}
pub mod random_oracle {}
pub mod threshold_schnorr {}
