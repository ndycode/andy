#[must_use]
pub fn constant_time_equal(a: &str, b: &str) -> bool {
    let max_len = a.len().max(b.len());
    let mut diff = a.len() ^ b.len();
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();

    for idx in 0..max_len {
        diff |= byte_at(a_bytes, idx) ^ byte_at(b_bytes, idx);
    }

    diff == 0
}

fn byte_at(bytes: &[u8], index: usize) -> usize {
    usize::from(*bytes.get(index).unwrap_or(&0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_exactly_without_early_length_return() {
        assert!(constant_time_equal("secret", "secret"));
        assert!(!constant_time_equal("secret", "secRet"));
        assert!(!constant_time_equal("secret", "secret!"));
    }
}
