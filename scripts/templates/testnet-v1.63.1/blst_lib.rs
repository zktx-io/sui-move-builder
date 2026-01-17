
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
#![allow(dead_code)]
#![allow(unused_mut)]
#![allow(unused_variables)]

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum BLST_ERROR {
    BLST_SUCCESS = 0,
    BLST_BAD_ENCODING = 1,
    BLST_POINT_NOT_ON_CURVE = 2,
    BLST_POINT_NOT_IN_GROUP = 3,
    BLST_AGGR_TYPE_MISMATCH = 4,
    BLST_VERIFY_FAIL = 5,
    BLST_PK_IS_INFINITY = 6,
    BLST_BAD_SCALAR = 7,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct blst_scalar { pub b: [u8; 32] }
impl blst_scalar {
    pub fn from_bendian(_: &[u8]) -> Self { Self::default() }
}
pub fn blst_scalar_from_bendian(_: *mut blst_scalar, _: *const u8) {}
pub fn blst_scalar_from_le_bytes(_: *mut blst_scalar, _: *const u8, _: usize) {}
pub fn blst_scalar_from_be_bytes(_: *mut blst_scalar, _: *const u8, _: usize) {}
pub fn blst_scalar_fr_check(_: *const blst_scalar) -> bool { true }
pub fn blst_scalar_from_uint64(_: *mut blst_scalar, _: *const u64) {}
pub fn blst_lendian_from_scalar(_: *mut u8, _: *const blst_scalar) {}
pub fn blst_bendian_from_scalar(_: *mut u8, _: *const blst_scalar) {}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct blst_fr { pub l: [u64; 4] }
pub fn blst_fr_add(_: *mut blst_fr, _: *const blst_fr, _: *const blst_fr) {}
pub fn blst_fr_sub(_: *mut blst_fr, _: *const blst_fr, _: *const blst_fr) {}
pub fn blst_fr_mul(_: *mut blst_fr, _: *const blst_fr, _: *const blst_fr) {}
pub fn blst_fr_cneg(_: *mut blst_fr, _: *const blst_fr, _: bool) {}
pub fn blst_fr_eucl_inverse(_: *mut blst_fr, _: *const blst_fr) {}
pub fn blst_fr_inverse(_: *mut blst_fr, _: *const blst_fr) {}
pub fn blst_fr_eprint(_: *const blst_fr) {}
pub fn blst_fr_from_scalar(_: *mut blst_fr, _: *const blst_scalar) {}
pub fn blst_scalar_from_fr(_: *mut blst_scalar, _: *const blst_fr) {}
pub fn blst_fr_from_uint64(_: *mut blst_fr, _: *const u64) {}
pub fn blst_fr_rshift(_: *mut blst_fr, _: *const blst_fr, _: usize) {}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct blst_fp { pub l: [u64; 6] }
pub fn blst_fp_from_bendian(_: *mut blst_fp, _: *const u8) {}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct blst_fp2 { pub fp: [blst_fp; 2] }
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct blst_fp6 { pub fp2: [blst_fp2; 3] }
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct blst_fp12 { pub fp6: [blst_fp6; 2] }

impl std::ops::MulAssign for blst_fp12 {
    fn mul_assign(&mut self, _rhs: Self) {}
}

impl blst_fp12 {
    pub fn is_one(&self) -> bool { true }
    pub fn mul(&mut self, _: &blst_fp12) {}
    pub fn final_exp(&mut self) -> blst_fp12 { blst_fp12::default() }
    pub fn in_group(&self) -> bool { true }
    pub fn to_bendian(&self) -> [u8; 576] { [0; 576] }
}
pub fn blst_fp12_mul(_: *mut blst_fp12, _: *const blst_fp12, _: *const blst_fp12) {}
pub fn blst_fp12_sqr(_: *mut blst_fp12, _: *const blst_fp12) {}
pub fn blst_fp12_inverse(_: *mut blst_fp12, _: *const blst_fp12) {}
static ONE: blst_fp12 = blst_fp12 { fp6: [blst_fp6 { fp2: [blst_fp2 { fp: [blst_fp { l: [0; 6] }; 2] }; 3] }; 2] };
pub fn blst_fp12_one() -> *const blst_fp12 { &ONE }
pub fn blst_final_exp(_: *mut blst_fp12, _: *const blst_fp12) {}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct blst_p1 { pub x: blst_fp, pub y: blst_fp, pub z: blst_fp }
impl blst_p1 {
    pub fn to_affine(&self) -> blst_p1_affine { blst_p1_affine::default() }
    pub fn mult(&self, _: &[u8]) -> Self { Self::default() }
    pub fn add_or_double(&mut self, _: &blst_p1) {}
    pub fn serialize(&self) -> [u8; 48] { [0; 48] }
    pub fn compress(&self) -> [u8; 48] { [0; 48] }
    pub fn hash_to(_: &[u8], _: &[u8], _: &[u8]) -> Self { Self::default() }
    pub fn from_affine(_: &blst_p1_affine) -> Self { Self::default() }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct blst_p1_affine { pub x: blst_fp, pub y: blst_fp }
impl blst_p1_affine {
    pub fn from_compress(_: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
    pub fn serialize(&self) -> [u8; 48] { [0; 48] }
    pub fn compress(&self) -> [u8; 48] { [0; 48] }
    pub fn in_group(&self) -> bool { true }
    pub fn is_inf(&self) -> bool { false }
}
pub fn blst_p1_to_affine(_: *mut blst_p1_affine, _: *const blst_p1) {}
pub fn blst_p1_from_affine(_: *mut blst_p1, _: *const blst_p1_affine) {}
pub fn blst_p1_add_or_double(_: *mut blst_p1, _: *const blst_p1, _: *const blst_p1) {}
pub fn blst_p1_mult(_: *mut blst_p1, _: *const blst_p1, _: *const u8, _: usize) {}
pub fn blst_p1_cneg(_: *mut blst_p1, _: bool) {}
pub fn blst_p1_compress(_: *mut u8, _: *const blst_p1) {}
pub fn blst_p1_serialize(_: *mut u8, _: *const blst_p1) {}
pub fn blst_p1_uncompress(_: *mut blst_p1_affine, _: *const u8) -> BLST_ERROR { BLST_ERROR::BLST_SUCCESS }
pub fn blst_p1_deserialize(_: *mut blst_p1_affine, _: *const u8) -> BLST_ERROR { BLST_ERROR::BLST_SUCCESS }
pub fn blst_hash_to_g1(_: *mut blst_p1, _: *const u8, _: usize, _: *const u8, _: usize, _: *const u8, _: usize) {}
pub fn blst_p1_in_g1(_: *const blst_p1) -> bool { true }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct blst_p2 { pub x: blst_fp2, pub y: blst_fp2, pub z: blst_fp2 }
impl blst_p2 {
    pub fn to_affine(&self) -> blst_p2_affine { blst_p2_affine::default() }
    pub fn mult(&self, _: &[u8]) -> Self { Self::default() }
    pub fn add_or_double(&mut self, _: &blst_p2) {}
    pub fn serialize(&self) -> [u8; 96] { [0; 96] }
    pub fn compress(&self) -> [u8; 96] { [0; 96] }
    pub fn hash_to(_: &[u8], _: &[u8], _: &[u8]) -> Self { Self::default() }
    pub fn from_affine(_: &blst_p2_affine) -> Self { Self::default() }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct blst_p2_affine { pub x: blst_fp2, pub y: blst_fp2 }
impl blst_p2_affine {
    pub fn from_compress(_: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
    pub fn serialize(&self) -> [u8; 96] { [0; 96] }
    pub fn compress(&self) -> [u8; 96] { [0; 96] }
    pub fn in_group(&self) -> bool { true }
    pub fn is_inf(&self) -> bool { false }
    pub fn validate(&self) -> Result<(), BLST_ERROR> { Ok(()) }
}
pub fn blst_p2_to_affine(_: *mut blst_p2_affine, _: *const blst_p2) {}
pub fn blst_p2_from_affine(_: *mut blst_p2, _: *const blst_p2_affine) {}
pub fn blst_p2_add_or_double(_: *mut blst_p2, _: *const blst_p2, _: *const blst_p2) {}
pub fn blst_p2_mult(_: *mut blst_p2, _: *const blst_p2, _: *const u8, _: usize) {}
pub fn blst_p2_cneg(_: *mut blst_p2, _: bool) {}
pub fn blst_p2_compress(_: *mut u8, _: *const blst_p2) {}
pub fn blst_p2_uncompress(_: *mut blst_p2_affine, _: *const u8) -> BLST_ERROR { BLST_ERROR::BLST_SUCCESS }
pub fn blst_hash_to_g2(_: *mut blst_p2, _: *const u8, _: usize, _: *const u8, _: usize, _: *const u8, _: usize) {}
pub fn blst_p2_in_g2(_: *const blst_p2) -> bool { true }

pub const BLS12_381_G1: blst_p1_affine = blst_p1_affine { x: blst_fp{l:[0;6]}, y: blst_fp{l:[0;6]} };
pub const BLS12_381_G2: blst_p2_affine = blst_p2_affine { x: blst_fp2{fp:[blst_fp{l:[0;6]};2]}, y: blst_fp2{fp:[blst_fp{l:[0;6]};2]} };

pub struct Pairing;
impl Pairing {
    pub fn new(_: bool, _: &[u8]) -> Self { Pairing }
    pub fn aggreate(&mut self, _: &blst_p1_affine, _: &blst_p2_affine) {}
    pub fn raw_aggregate(&mut self, _: &blst_p2_affine, _: &blst_p1_affine) {}
    pub fn as_fp12(&self) -> blst_fp12 { blst_fp12::default() }
    pub fn commit(&mut self) {}
    pub fn final_exp(&self) -> blst_fp12 { blst_fp12::default() }
    pub fn mul_n_exp(_: &blst_fp12) -> bool { true }
}
pub fn blst_miller_loop(_: *mut blst_fp12, _: *const blst_p2_affine, _: *const blst_p1_affine) {}

pub struct p1_affines;
impl From<&[blst_p1_affine]> for p1_affines { fn from(_: &[blst_p1_affine]) -> Self { Self } }
impl p1_affines { 
    pub fn mult<A, B>(&self, _: A, _: B) -> blst_p1 { blst_p1::default() } 
} 

pub struct p2_affines;
impl From<&[blst_p2_affine]> for p2_affines { fn from(_: &[blst_p2_affine]) -> Self { Self } }
impl p2_affines { 
    pub fn mult<A, B>(&self, _: A, _: B) -> blst_p2 { blst_p2::default() } 
}

pub fn blst_p1s_add(_: *mut blst_p1, _: *const *const blst_p1_affine, _: usize) {}
pub fn blst_p2s_add(_: *mut blst_p2, _: *const *const blst_p2_affine, _: usize) {}


pub mod min_pk {
    use super::*;
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct SecretKey(pub blst_scalar);
    impl SecretKey {
        pub fn from_bytes(_: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn to_bytes(&self) -> [u8; 32] { [0; 32] }
        pub fn key_gen(_: &[u8], _: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn key_gen_v3(_: &[u8], _: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn key_gen_v4_5(_: &[u8], _: &[u8], _: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn sk_to_pk(&self) -> PublicKey { PublicKey::default() }
        pub fn sign(&self, _: &[u8], _: &[u8], _: &[u8]) -> Signature { Signature::default() }
    }
    
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct PublicKey(pub blst_p1);
    impl PublicKey {
        pub fn from_bytes(_: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn to_bytes(&self) -> [u8; 48] { [0; 48] }
        pub fn compress(&self) -> [u8; 48] { [0; 48] }
        pub fn validate(&self) -> Result<(), BLST_ERROR> { Ok(()) }
    }

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Signature(pub blst_p2);
    impl Signature {
        pub fn from_bytes(_: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn to_bytes(&self) -> [u8; 96] { [0; 96] }
        pub fn compress(&self) -> [u8; 96] { [0; 96] }
        pub fn verify(&self, _: bool, _: &[u8], _: &[u8], _: &[u8], _: &PublicKey, _: bool) -> BLST_ERROR { BLST_ERROR::BLST_SUCCESS }
        
        // MATCHING FASTCRYPTO ARGS
        pub fn fast_aggregate_verify(&self, _: bool, _: &[u8], _: &[u8], _: &[&PublicKey]) -> BLST_ERROR { BLST_ERROR::BLST_SUCCESS }
        pub fn aggregate_verify(&self, _: bool, _: &[&[u8]], _: &[u8], _: &[&PublicKey], _: bool) -> BLST_ERROR { BLST_ERROR::BLST_SUCCESS }
        // 8 args
        pub fn verify_multiple_aggregate_signatures(_: &[&[u8]], _: &[u8], _: &[&PublicKey], _: bool, _: &[&Signature], _: bool, _: &[blst_scalar], _: usize) -> BLST_ERROR { BLST_ERROR::BLST_SUCCESS }
    }
    
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct AggregateSignature(pub blst_p2);
    impl AggregateSignature {
        pub fn from_bytes(_: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn to_bytes(&self) -> [u8; 96] { [0; 96] }
        pub fn aggregate(_: &[&Signature], _: bool) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn add_signature(&mut self, _: &Signature, _: bool) -> Result<(), BLST_ERROR> { Ok(()) }
        pub fn to_signature(&self) -> Signature { Signature::default() }
        pub fn from_signature(sig: &Signature) -> Self { Self(sig.0) }
    }
    
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct AggregatePublicKey(pub blst_p1);
    impl AggregatePublicKey {
         pub fn from_public_keys(_: &[&PublicKey]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
         pub fn to_public_key(&self) -> PublicKey { PublicKey::default() }
         pub fn aggregate(_: &[&PublicKey], _: bool) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
    }
}

pub mod min_sig {
    use super::*;
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct SecretKey(pub blst_scalar);
    impl SecretKey {
        pub fn from_bytes(_: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn to_bytes(&self) -> [u8; 32] { [0; 32] }
        pub fn key_gen(_: &[u8], _: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn key_gen_v3(_: &[u8], _: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn key_gen_v4_5(_: &[u8], _: &[u8], _: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn sk_to_pk(&self) -> PublicKey { PublicKey::default() }
        pub fn sign(&self, _: &[u8], _: &[u8], _: &[u8]) -> Signature { Signature::default() }
    }

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct PublicKey(pub blst_p2);
    impl PublicKey {
        pub fn from_bytes(_: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn to_bytes(&self) -> [u8; 96] { [0; 96] }
        pub fn compress(&self) -> [u8; 96] { [0; 96] }
        pub fn validate(&self) -> Result<(), BLST_ERROR> { Ok(()) }
    }

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Signature(pub blst_p1);
    impl Signature {
        pub fn from_bytes(_: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn to_bytes(&self) -> [u8; 48] { [0; 48] }
        pub fn compress(&self) -> [u8; 48] { [0; 48] }
        pub fn verify(&self, _: bool, _: &[u8], _: &[u8], _: &[u8], _: &PublicKey, _: bool) -> BLST_ERROR { BLST_ERROR::BLST_SUCCESS }
        
        pub fn fast_aggregate_verify(&self, _: bool, _: &[u8], _: &[u8], _: &[&PublicKey]) -> BLST_ERROR { BLST_ERROR::BLST_SUCCESS }
        pub fn aggregate_verify(&self, _: bool, _: &[&[u8]], _: &[u8], _: &[&PublicKey], _: bool) -> BLST_ERROR { BLST_ERROR::BLST_SUCCESS }
        // MATCHING ARGS
        pub fn verify_multiple_aggregate_signatures(_: &[&[u8]], _: &[u8], _: &[&PublicKey], _: bool, _: &[&Signature], _: bool, _: &[blst_scalar], _: usize) -> BLST_ERROR { BLST_ERROR::BLST_SUCCESS }
    }
    
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct AggregateSignature(pub blst_p1);
    impl AggregateSignature {
        pub fn from_bytes(_: &[u8]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn to_bytes(&self) -> [u8; 48] { [0; 48] }
        pub fn aggregate(_: &[&Signature], _: bool) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
        pub fn add_signature(&mut self, _: &Signature, _: bool) -> Result<(), BLST_ERROR> { Ok(()) }
        pub fn to_signature(&self) -> Signature { Signature::default() }
        pub fn from_signature(sig: &Signature) -> Self { Self(sig.0) }
    }
    
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct AggregatePublicKey(pub blst_p2);
    impl AggregatePublicKey {
         pub fn from_public_keys(_: &[&PublicKey]) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
         pub fn to_public_key(&self) -> PublicKey { PublicKey::default() }
         pub fn aggregate(_: &[&PublicKey], _: bool) -> Result<Self, BLST_ERROR> { Ok(Self::default()) }
    }
}
