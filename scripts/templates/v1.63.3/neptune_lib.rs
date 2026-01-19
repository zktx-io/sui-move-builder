use std::marker::PhantomData;
pub mod poseidon {
    pub enum HashMode { OptimizedStatic, Dynamic }
    #[derive(Clone)]
    pub struct PoseidonConstants<F, U>(std::marker::PhantomData<(F, U)>);
    impl<F, U> PoseidonConstants<F, U> {
        pub fn new_from_parameters<A, B, C, D, E, G, H>(_: A, _: B, _: C, _: D, _: E, _: G, _: H) -> Self { 
            Self(std::marker::PhantomData) 
        }
    }
}
pub mod hash_type { 
    pub enum HashType<F, U> { Sponge, Phantom(std::marker::PhantomData<(F, U)>) }
}
#[derive(Clone)]
pub struct Poseidon<F> {
    pub elements: Vec<F>,
    _marker: PhantomData<F>,
}
impl<F> Poseidon<F> {
    pub fn new<U>(_constants: &poseidon::PoseidonConstants<F, U>) -> Self { 
        Self { elements: Vec::new(), _marker: PhantomData } 
    }
    pub fn reset(&mut self) {}
    pub fn input(&mut self, _input: F) -> Result<(), ()> { Ok(()) }
    pub fn hash(&mut self) -> F { panic!("Stubbed") }
    pub fn hash_in_mode(&mut self, _mode: poseidon::HashMode) -> F { panic!("Stubbed") }
}
#[derive(Clone, Copy)]
pub enum Strength { Standard }
