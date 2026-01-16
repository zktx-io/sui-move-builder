
pub fn monitored_scope(name: &str) -> () { () }
#[macro_export]
macro_rules! spawn_monitored_task {
    ($($arg:tt)*) => {
        tokio::spawn($($arg)*)
    }
}

#[derive(Clone)]
pub struct StubMetric;
impl StubMetric {
    pub fn with_label_values(&self, _: &[&str]) -> Self { Self }
    pub fn inc(&self) {}
}
#[derive(Clone)]
pub struct Metrics {
    pub system_invariant_violations: StubMetric,
}
pub fn get_metrics() -> Option<Metrics> { None }

pub mod histogram {
    #[derive(Clone)]
    pub struct Histogram;
    impl Histogram {
        pub fn new(_: &str, _: &str, _: &super::Registry) -> Self { Self }
        pub fn observe(&self, _: f64) {}
        pub fn report(&self, _: u64) {}
    }
}
#[derive(Clone)]
pub struct Registry;
impl Registry {
     pub fn register(&self, _: Box<dyn std::any::Any>) -> Result<(), ()> { Ok(()) }
}
