//! Shared, `pub(crate)` SQL helpers for the db layer.
//!
//! `escape_like` and `truncate` were previously copy-pasted across
//! `queries.rs`, `writes.rs`, `confirmations.rs`, and `ops.rs`. Centralizing
//! them keeps the LIKE-escaping (which guards against wildcard injection) and
//! the length clamping (which backs the DB `CHECK` constraints) defined exactly
//! once.

/// Clip a string to at most `max` characters (not bytes), matching the column
/// length limits enforced by DB `CHECK` constraints.
pub(crate) fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Escape `%`, `_`, and `\` so a user-supplied string is treated literally
/// inside a `LIKE ... ESCAPE '\'` pattern (prevents wildcard injection).
pub(crate) fn escape_like(value: &str) -> String {
    value
        .replace('\\', r"\\")
        .replace('%', r"\%")
        .replace('_', r"\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_clips_to_char_boundary() {
        assert_eq!(truncate("hello", 3), "hel");
        assert_eq!(truncate("hi", 5), "hi");
    }

    #[test]
    fn escapes_like_metacharacters() {
        assert_eq!(escape_like(r"50%_off\deal"), r"50\%\_off\\deal");
    }
}
