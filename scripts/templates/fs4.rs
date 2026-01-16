
pub mod fs_std {
    pub trait FileExt {
        fn lock_exclusive(&self) -> std::io::Result<()> { Ok(()) }
        fn unlock(&self) -> std::io::Result<()> { Ok(()) }
        fn lock_shared(&self) -> std::io::Result<()> { Ok(()) }
        fn try_lock_exclusive(&self) -> std::io::Result<()> { Ok(()) }
        fn try_lock_shared(&self) -> std::io::Result<()> { Ok(()) }
    }
    impl FileExt for std::fs::File {}
}
