
pub mod build_config {
    #[derive(Default)]
    pub struct BuildConfig;
    impl BuildConfig {
        pub async fn move_model_from_path<A, B>(
            &self,
            _: &std::path::Path,
            _: A,
            _: &mut B,
        ) -> anyhow::Result<move_model_2::model::Model<move_model_2::source_kind::WithSource>> {
            Err(anyhow::anyhow!("Stubbed function called: move_model_from_path not supported in Wasm"))
        }
    }
}
