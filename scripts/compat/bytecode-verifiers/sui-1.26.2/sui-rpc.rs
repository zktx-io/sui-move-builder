pub mod field {
    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    pub struct FieldMask {
        pub paths: Vec<String>,
    }

    pub trait FieldMaskUtil {}

    impl FieldMask {
        pub fn from_paths<I, S>(paths: I) -> Self
        where
            I: IntoIterator<Item = S>,
            S: Into<String>,
        {
            Self {
                paths: paths.into_iter().map(Into::into).collect(),
            }
        }
    }
}

pub mod proto {
    pub mod sui {
        pub mod rpc {
            pub mod v2 {
                pub struct Checkpoint;

                impl Checkpoint {
                    pub fn path_builder() -> PathBuilder {
                        PathBuilder::default()
                    }
                }

                #[derive(Clone, Debug, Default)]
                pub struct PathBuilder {
                    path: String,
                }

                impl PathBuilder {
                    fn push(mut self, segment: &str) -> Self {
                        if !self.path.is_empty() {
                            self.path.push('.');
                        }
                        self.path.push_str(segment);
                        self
                    }

                    pub fn sequence_number(self) -> String {
                        self.push("sequence_number").finish()
                    }

                    pub fn summary(self) -> Self {
                        self.push("summary")
                    }

                    pub fn bcs(self) -> Self {
                        self.push("bcs")
                    }

                    pub fn value(self) -> String {
                        self.push("value").finish()
                    }

                    pub fn signature(self) -> Self {
                        self.push("signature")
                    }

                    pub fn contents(self) -> Self {
                        self.push("contents")
                    }

                    pub fn transactions(self) -> Self {
                        self.push("transactions")
                    }

                    pub fn transaction(self) -> Self {
                        self.push("transaction")
                    }

                    pub fn effects(self) -> Self {
                        self.push("effects")
                    }

                    pub fn unchanged_loaded_runtime_objects(self) -> Self {
                        self.push("unchanged_loaded_runtime_objects")
                    }

                    pub fn events(self) -> Self {
                        self.push("events")
                    }

                    pub fn objects(self) -> Self {
                        self.push("objects")
                    }

                    pub fn finish(self) -> String {
                        self.path
                    }
                }
            }
        }
    }
}
