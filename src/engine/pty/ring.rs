//! pty 输出字节环形缓冲（补屏/回放窗口）。
//!
//! 有界约束（performance-and-safety §P1）：字节维度上限 `capacity`，
//! 超限丢弃最旧块；单个超大块只保留尾部 `capacity` 字节。
//! 切片 A 用它做重连补屏的过渡方案（原始字节，可能含转义序列碎片），
//! 切片 B 接入 VT 模拟器后由服务端 grid 重渲染取代。

use std::collections::VecDeque;

/// 单会话补屏窗口默认上限（256KB，D5 内存环同量级）。
pub const DEFAULT_REPLAY_BYTES: usize = 256 * 1024;

pub struct ByteRing {
    capacity: usize,
    chunks: VecDeque<Vec<u8>>,
    total: usize,
}

impl ByteRing {
    pub fn new(capacity: usize) -> Self {
        Self { capacity: capacity.max(1), chunks: VecDeque::new(), total: 0 }
    }

    /// 追加一块输出。超限丢最旧；单块超容量只留尾部。
    pub fn push(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let chunk: Vec<u8> = if data.len() > self.capacity {
            data[data.len() - self.capacity..].to_vec()
        } else {
            data.to_vec()
        };
        self.total += chunk.len();
        self.chunks.push_back(chunk);
        while self.total > self.capacity
            && let Some(old) = self.chunks.pop_front()
        {
            self.total -= old.len();
        }
    }

    /// 按序拼接窗口内全部字节。
    pub fn snapshot(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.total);
        for c in &self.chunks {
            out.extend_from_slice(c);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_oldest_beyond_capacity() {
        let mut ring = ByteRing::new(10);
        ring.push(b"aaaaa");
        ring.push(b"bbbbb");
        ring.push(b"ccccc");
        assert_eq!(ring.snapshot(), b"bbbbbccccc");
    }

    #[test]
    fn oversized_single_chunk_keeps_tail() {
        let mut ring = ByteRing::new(4);
        ring.push(b"0123456789");
        assert_eq!(ring.snapshot(), b"6789");
    }

    #[test]
    fn order_preserved_across_many_chunks() {
        let mut ring = ByteRing::new(6);
        for i in 0..10u8 {
            ring.push(&[i]);
        }
        assert_eq!(ring.snapshot(), vec![4, 5, 6, 7, 8, 9]);
    }

    #[test]
    fn empty_push_is_noop() {
        let mut ring = ByteRing::new(4);
        ring.push(b"");
        assert!(ring.snapshot().is_empty());
    }
}
