
#![allow(non_camel_case_types)]
pub mod backend {
    pub mod c {
        pub type c_int = i32;
        pub type c_uint = u32;
        pub type RawFd = i32;
        pub const AT_FDCWD: i32 = -100;
        pub const EBADF: i32 = 9;
        pub const FIONBIO: i32 = 0x5421;
        pub const FIONREAD: i32 = 0x541B;
        #[repr(C)] pub struct timespec { pub tv_sec: i64, pub tv_nsec: i64, }
        pub type uid_t = u32;
        pub type gid_t = u32;
    }
}
pub mod fd { 
    pub type RawFd = i32; 
    pub type BorrowedFd<'a> = i32; 
    pub trait AsFd {}
    impl AsFd for RawFd {}
    impl<'a, T: AsFd> AsFd for &'a T {}

}
pub mod fs { 
    pub type FileType = u8;
    pub type Mode = u32;
    pub struct Stat { 
        pub st_mode: u32, 
        pub st_ino: u64, 
        pub st_nlink: u64, 
        pub st_size: u64,
        pub st_dev: u64,  // Added for tempfile
        pub st_uid: u32,
        pub st_gid: u32,
        pub st_atime: i64,
        pub st_mtime: i64,
        pub st_ctime: i64,
        pub st_blksize: u64,
        pub st_blocks: u64,
    }
    pub struct RenameFlags;
    impl RenameFlags {
        pub const NOREPLACE: Self = Self;
    }
    pub const CWD: i32 = -100;

    pub fn fcntl_getfl(_: i32) -> Result<i32, i32> { Ok(0) } 
    pub fn rename<P: AsRef<std::path::Path>, Q: AsRef<std::path::Path>>(_: P, _: Q) -> Result<(), super::io::Errno> { Ok(()) }
    pub fn unlink<P: AsRef<std::path::Path>>(_: P) -> Result<(), super::io::Errno> { Ok(()) }
    pub fn fstat<F>(_fd: F) -> Result<Stat, super::io::Errno> { 
        Ok(Stat { 
            st_mode: 0, st_ino: 0, st_nlink: 0, st_size: 0, st_dev: 0,
            st_uid: 0, st_gid: 0, st_atime: 0, st_mtime: 0, st_ctime: 0,
            st_blksize: 0, st_blocks: 0 
        }) 
    }
    pub fn renameat_with<P: AsRef<std::path::Path>, Q: AsRef<std::path::Path>>(_: i32, _: P, _: i32, _: Q, _: RenameFlags) -> Result<(), super::io::Errno> { Ok(()) }
}
pub mod io { 
    pub mod ioctl {} 
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Errno(pub i32);
    impl Errno {
        pub const NOSYS: Self = Self(38);
        pub const INVAL: Self = Self(22);
    }
    impl std::fmt::Display for Errno {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "Errno({})", self.0) }
    }
    impl std::error::Error for Errno {}
    impl From<i32> for Errno {
         fn from(x: i32) -> Self { Errno(x) }
    }
    impl From<Errno> for std::io::Error {
        fn from(e: Errno) -> Self {
            std::io::Error::from_raw_os_error(e.0)
        }
    }
}
pub mod ioctl { pub type Opcode = u32; }
pub mod ffi { pub type c_int = i32; }
pub mod termios {
    #[derive(Default)]
    pub struct Winsize { pub ws_row: u16, pub ws_col: u16, pub ws_xpixel: u16, pub ws_ypixel: u16 }
    pub fn isatty<T>(_fd: T) -> bool { false }
    pub fn tcgetwinsize<T>(_fd: T) -> Result<Winsize, i32> { Err(0) }
}
pub use backend::c::*;
