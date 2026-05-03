use std::sync::Mutex;
use std::collections::BTreeMap;
use std::ops::Range;

pub mod iter {
    pub struct Map<I, F> {
        pub(crate) base: I,
        pub(crate) map_op: F,
    }
    
    pub struct Chain<A, B> {
        pub(crate) a: A,
        pub(crate) b: B,
    }

    pub use crate::IntoParallelRefIterator;
    pub use crate::IntoParallelRefMutIterator;
    pub use crate::IntoParallelIterator;
    pub use crate::ParallelIterator;
}

pub mod collections {
    pub mod btree_map {
        pub type IntoIter<K, V> = crate::StubIter<std::collections::btree_map::IntoIter<K, V>>;
        pub type Iter<'a, K, V> = crate::StubIter<std::collections::btree_map::Iter<'a, K, V>>;
        pub type IterMut<'a, K, V> = crate::StubIter<std::collections::btree_map::IterMut<'a, K, V>>;
    }
}

pub mod prelude {
    pub use crate::IntoParallelRefIterator;
    pub use crate::IntoParallelRefMutIterator;
    pub use crate::IntoParallelIterator;
    pub use crate::ParallelIterator;
    pub use crate::TryReduceResultExt;
}

pub struct ThreadPoolBuilder {
    num_threads: usize,
}

impl ThreadPoolBuilder {
    pub fn new() -> Self {
        Self { num_threads: 0 }
    }
    pub fn num_threads(mut self, num: usize) -> Self {
        self.num_threads = num;
        self
    }
    pub fn build(self) -> Result<ThreadPool, ()> {
        Ok(ThreadPool)
    }
}

pub struct ThreadPool;

impl ThreadPool {
    pub fn install<OP, R>(&self, op: OP) -> R
    where
        OP: FnOnce() -> R + Send,
    {
        op()
    }
}

pub struct StubIter<I>(pub I);

// ParallelIterator Trait (Relaxed bounds to FnMut)
pub trait ParallelIterator: Sized {
    type Item;

    fn map<F, R>(self, f: F) -> crate::iter::Map<Self, F>
    where F: FnMut(Self::Item) -> R {
        crate::iter::Map { base: self, map_op: f }
    }
    
    fn chain<T>(self, other: T) -> crate::iter::Chain<Self, T> 
    where T: ParallelIterator<Item = Self::Item> {
        crate::iter::Chain { a: self, b: other }
    }

    fn reduce<OP, ID>(self, identity: ID, op: OP) -> Self::Item
    where
        OP: FnMut(Self::Item, Self::Item) -> Self::Item,
        ID: FnMut() -> Self::Item;
        
    fn try_fold<T, E, ID, F>(self, identity: ID, fold_op: F) -> Result<T, E>
    where
        ID: FnMut() -> T,
        F: FnMut(T, Self::Item) -> Result<T, E>;
        
    fn for_each<OP>(self, op: OP)
    where OP: FnMut(Self::Item);
    
    fn collect<C>(self) -> C
    where C: FromIterator<Self::Item>;
}

// Implement for StubIter
impl<I: Iterator> ParallelIterator for StubIter<I> {
    type Item = I::Item;
    
    fn reduce<OP, ID>(self, mut identity: ID, op: OP) -> Self::Item
    where OP: FnMut(Self::Item, Self::Item) -> Self::Item, ID: FnMut() -> Self::Item 
    {
        self.0.fold(identity(), op)
    }

    fn try_fold<T, E, ID, F>(mut self, mut identity: ID, mut fold_op: F) -> Result<T, E>
    where ID: FnMut() -> T, F: FnMut(T, Self::Item) -> Result<T, E>
    {
        let mut acc = identity();
        for item in self.0 {
            acc = fold_op(acc, item)?;
        }
        Ok(acc)
    }
    
    fn for_each<OP>(self, op: OP) where OP: FnMut(Self::Item) {
        self.0.for_each(op)
    }
    
    fn collect<C>(self) -> C where C: FromIterator<Self::Item> {
        self.0.collect()
    }
}

// Implement for Map
impl<I: ParallelIterator, F, R> ParallelIterator for crate::iter::Map<I, F>
where F: FnMut(I::Item) -> R 
{
    type Item = R;
    
    fn reduce<OP, ID>(self, identity: ID, mut op: OP) -> Self::Item
    where OP: FnMut(Self::Item, Self::Item) -> Self::Item, ID: FnMut() -> Self::Item
    {
        // Use try_fold to implement reduce since base.reduce expects I::Item, but we produce R
        let mut map_op = self.map_op;
        self.base.try_fold(identity, |acc, item| {
             Ok::<R, ()>(op(acc, map_op(item)))
        }).unwrap()
    }
    
    fn try_fold<T, E, ID, FoldOp>(self, identity: ID, mut fold_op: FoldOp) -> Result<T, E>
    where ID: FnMut() -> T, FoldOp: FnMut(T, Self::Item) -> Result<T, E>
    {
        let mut map_op = self.map_op;
        self.base.try_fold(identity, |acc, item| fold_op(acc, map_op(item)))
    }

    fn for_each<OP>(self, mut op: OP) where OP: FnMut(Self::Item) {
        let mut map_op = self.map_op;
        self.base.for_each(|item| op(map_op(item)))
    }
    
    fn collect<C>(self) -> C where C: FromIterator<Self::Item> {
        let mut vec = Vec::new();
        let mut map_op = self.map_op;
        self.base.for_each(|item| vec.push(map_op(item)));
        vec.into_iter().collect()
    }
}

// Implement for Chain
impl<A, B> ParallelIterator for crate::iter::Chain<A, B>
where A: ParallelIterator, B: ParallelIterator<Item = A::Item>
{
    type Item = A::Item;
    
    fn reduce<OP, ID>(self, mut identity: ID, mut op: OP) -> Self::Item
    where OP: FnMut(Self::Item, Self::Item) -> Self::Item, ID: FnMut() -> Self::Item
    {
        let mut vec = Vec::new();
        self.a.for_each(|i| vec.push(i));
        self.b.for_each(|i| vec.push(i));
        
        let mut acc = identity();
        for item in vec {
            acc = op(acc, item);
        }
        acc
    }
    
    fn try_fold<T, E, ID, F>(self, mut identity: ID, mut fold_op: F) -> Result<T, E>
    where ID: FnMut() -> T, F: FnMut(T, Self::Item) -> Result<T, E>
    {
        let mut vec = Vec::new();
        self.a.for_each(|i| vec.push(i));
        self.b.for_each(|i| vec.push(i));
        
        let mut acc = identity();
        for item in vec {
            acc = fold_op(acc, item)?;
        }
        Ok(acc)
    }

    fn for_each<OP>(self, mut op: OP) where OP: FnMut(Self::Item) {
        let mut vec = Vec::new();
        self.a.for_each(|i| vec.push(i));
        self.b.for_each(|i| vec.push(i));
        for item in vec {
            op(item);
        }
    }

    fn collect<C>(self) -> C where C: FromIterator<Self::Item> {
        let mut vec = Vec::new();
        self.a.for_each(|i| vec.push(i));
        self.b.for_each(|i| vec.push(i));
        vec.into_iter().collect()
    }
}

pub trait TryReduceResultExt<T, E> {
    fn try_reduce<ID, OP>(self, identity: ID, op: OP) -> Result<T, E>
    where
        ID: FnMut() -> T,
        OP: FnMut(T, T) -> Result<T, E>;
}

impl<T, E> TryReduceResultExt<T, E> for Result<T, E> {
    fn try_reduce<ID, OP>(self, _identity: ID, _op: OP) -> Result<T, E>
    where
        ID: FnMut() -> T,
        OP: FnMut(T, T) -> Result<T, E> 
    {
        self
    }
}

pub trait IntoParallelRefIterator<'data> {
    type Item;
    type Iter: ParallelIterator<Item = Self::Item>;
    fn par_iter(&'data self) -> Self::Iter;
}
impl<'data, T: 'data> IntoParallelRefIterator<'data> for Vec<T> {
    type Item = &'data T;
    type Iter = StubIter<std::slice::Iter<'data, T>>;
    fn par_iter(&'data self) -> Self::Iter { StubIter(self.iter()) }
}
impl<'data, T: 'data> IntoParallelRefIterator<'data> for [T] {
    type Item = &'data T;
    type Iter = StubIter<std::slice::Iter<'data, T>>;
    fn par_iter(&'data self) -> Self::Iter { StubIter(self.iter()) }
}
impl<'data, K: 'data + Ord, V: 'data> IntoParallelRefIterator<'data> for BTreeMap<K, V> {
    type Item = (&'data K, &'data V);
    type Iter = StubIter<std::collections::btree_map::Iter<'data, K, V>>;
    fn par_iter(&'data self) -> Self::Iter { StubIter(self.iter()) }
}

pub trait IntoParallelRefMutIterator<'data> {
    type Item;
    type Iter: ParallelIterator<Item = Self::Item>;
    fn par_iter_mut(&'data mut self) -> Self::Iter;
}
impl<'data, T: 'data> IntoParallelRefMutIterator<'data> for Vec<T> {
    type Item = &'data mut T;
    type Iter = StubIter<std::slice::IterMut<'data, T>>;
    fn par_iter_mut(&'data mut self) -> Self::Iter { StubIter(self.iter_mut()) }
}
impl<'data, T: 'data> IntoParallelRefMutIterator<'data> for [T] {
    type Item = &'data mut T;
    type Iter = StubIter<std::slice::IterMut<'data, T>>;
    fn par_iter_mut(&'data mut self) -> Self::Iter { StubIter(self.iter_mut()) }
}
impl<'data, K: 'data + Ord, V: 'data> IntoParallelRefMutIterator<'data> for BTreeMap<K, V> {
    type Item = (&'data K, &'data mut V);
    type Iter = StubIter<std::collections::btree_map::IterMut<'data, K, V>>;
    fn par_iter_mut(&'data mut self) -> Self::Iter { StubIter(self.iter_mut()) }
}

pub trait IntoParallelIterator {
    type Item;
    type Iter: ParallelIterator<Item = Self::Item>;
    fn into_par_iter(self) -> Self::Iter;
}
impl<T> IntoParallelIterator for Vec<T> {
    type Item = T;
    type Iter = StubIter<std::vec::IntoIter<T>>;
    fn into_par_iter(self) -> Self::Iter { StubIter(self.into_iter()) }
}
impl<K: Ord, V> IntoParallelIterator for BTreeMap<K, V> {
    type Item = (K, V);
    type Iter = StubIter<std::collections::btree_map::IntoIter<K, V>>;
    fn into_par_iter(self) -> Self::Iter { StubIter(self.into_iter()) }
}
impl<Idx> IntoParallelIterator for Range<Idx>
where
    Range<Idx>: Iterator,
{
    type Item = <Range<Idx> as Iterator>::Item;
    type Iter = StubIter<Range<Idx>>;
    fn into_par_iter(self) -> Self::Iter { StubIter(self) }
}
