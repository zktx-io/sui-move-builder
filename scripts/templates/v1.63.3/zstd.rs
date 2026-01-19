
pub struct Encoder<W: std::io::Write>(W);
impl<W: std::io::Write> Encoder<W> {
    pub fn new(writer: W, _level: i32) -> Result<Self, std::io::Error> { Ok(Self(writer)) }
    pub fn finish(self) -> Result<W, std::io::Error> { Ok(self.0) }
}
impl<W: std::io::Write> std::io::Write for Encoder<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> { self.0.write(buf) }
    fn flush(&mut self) -> std::io::Result<()> { self.0.flush() }
}
pub fn decode_all<R: std::io::Read>(_read: R) -> Result<Vec<u8>, std::io::Error> { Ok(vec![]) }
pub fn encode_all<R: std::io::Read>(_read: R, _level: i32) -> Result<Vec<u8>, std::io::Error> { Ok(vec![]) }
pub fn bulk_decompress(_src: &[u8], _dst: &mut [u8]) -> Result<usize, std::io::Error> { Ok(0) }
pub mod stream {
    pub use super::Encoder;
    pub struct Decoder<'a, R: std::io::Read>(R, std::marker::PhantomData<&'a ()>);
    impl<'a, R: std::io::Read> Decoder<'a, R> {
        pub fn new(reader: R) -> Result<Self, std::io::Error> { Ok(Self(reader, std::marker::PhantomData)) }
    }
    impl<'a, R: std::io::Read> std::io::Read for Decoder<'a, R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> { self.0.read(buf) }
    }
    pub fn copy_encode<R: std::io::Read, W: std::io::Write>(_read: R, _write: W, _level: i32) -> Result<(), std::io::Error> { Ok(()) }
}
