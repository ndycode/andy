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

/// Lowercase hex SHA-256 of the input.
#[must_use]
pub fn sha256_hex(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(value.as_bytes());
    format!("{digest:x}")
}

/// Constant-time check that `sha256(token)` equals the expected lowercase hex
/// digest. Used by the webhook to verify a token against a stored hash so the
/// plaintext token need not live in env.
#[must_use]
pub fn token_matches_hash(token: &str, expected_hex: &str) -> bool {
    constant_time_equal(&sha256_hex(token), expected_hex)
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

    #[test]
    fn token_hash_round_trips() {
        // Known SHA-256 of "abc".
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(token_matches_hash("abc", &sha256_hex("abc")));
        assert!(!token_matches_hash("abd", &sha256_hex("abc")));
    }
}
