use serde::{Serialize, Deserialize};
#[derive(Clone, Debug)]
pub struct PeerId(pub [u8; 32]);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Multiaddr;
impl std::fmt::Display for Multiaddr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "/ip4/127.0.0.1/tcp/0") }
}
impl Multiaddr {
    pub fn to_anemo_address(&self) -> Result<Multiaddr, String> { Ok(self.clone()) }
}
impl TryFrom<String> for Multiaddr {
   type Error = String;
   fn try_from(_: String) -> Result<Self, Self::Error> { Ok(Multiaddr) }
}

pub mod types {
     use super::{PeerId, Multiaddr};
     #[derive(Clone, Debug)]
     pub struct PeerInfo {
         pub peer_id: PeerId,
         pub affinity: PeerAffinity,
         pub address: Vec<Multiaddr>,
     }
     #[derive(Clone, Debug)]
     pub enum PeerAffinity { High, Low }
}
                    