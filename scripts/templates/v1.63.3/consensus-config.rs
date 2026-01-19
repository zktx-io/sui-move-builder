
pub type Epoch = u64;
pub type Stake = u64;
pub mod base_types {
    #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
    pub struct AuthorityName;
}
#[derive(Clone, Debug)]
pub struct ProtocolPublicKey;
impl ProtocolPublicKey { pub fn new<T>(_: T) -> Self { Self } }

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct AuthorityPublicKey;
impl AuthorityPublicKey { 
    pub fn new<T>(_: T) -> Self { Self } 
    pub fn to_bytes(&self) -> [u8; 96] { [0u8; 96] }
}
#[derive(Clone, Debug)]
pub struct NetworkPublicKey;
impl NetworkPublicKey { pub fn new<T>(_: T) -> Self { Self } }

#[derive(Clone, Debug)]
pub struct Authority {
    pub stake: Stake,
    pub protocol_key: ProtocolPublicKey,
    pub network_key: NetworkPublicKey,
    pub authority_key: AuthorityPublicKey,
    pub address: mysten_network::multiaddr::Multiaddr,
    pub hostname: String,
}
#[derive(Clone, Debug)]
pub struct Committee;
impl Committee {
     pub fn new<A, B>(_: A, _: B) -> Self { Self }
}
pub type ConsensusCommittee = Committee;
