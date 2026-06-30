//! Memory text normalization — single source of truth.
//!
//! Saving and forgetting memories must agree on how content is normalized for
//! duplicate detection, and on which memory kind "wins" when the same fact is
//! saved twice. These helpers were duplicated across DB write paths; they live
//! here now so both paths (and their tests) share one definition.

/// Lowercase, strip non-alphanumerics to single spaces, collapse runs. Used to
/// match memories that differ only by punctuation/casing
/// ("Payday: Friday!" == "payday friday").
#[must_use]
pub fn normalize_memory_content(content: &str) -> String {
    content
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Like [`normalize_memory_content`] but with spaces removed, catching
/// tokenization differences ("pay day" == "payday").
#[must_use]
pub fn compact_memory_content(content: &str) -> String {
    normalize_memory_content(content).replace(' ', "")
}

/// Whether saving `next` over an existing `current` kind should upgrade it.
/// Lower rank = stronger; a stronger incoming kind promotes the stored row.
#[must_use]
pub fn should_promote_memory_kind(current: &str, next: &str) -> bool {
    memory_kind_rank(next) < memory_kind_rank(current)
}

fn memory_kind_rank(kind: &str) -> i64 {
    match kind {
        "payday" => 0,
        "fact" | "preference" => 1,
        "goal" => 2,
        _ => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_matches_punctuated_duplicates() {
        assert_eq!(
            normalize_memory_content("  Payday: every Friday! "),
            "payday every friday"
        );
        assert_eq!(compact_memory_content("Pay day"), "payday");
    }

    #[test]
    fn kind_promotion_keeps_stronger_kind() {
        assert!(should_promote_memory_kind("other", "payday"));
        assert!(!should_promote_memory_kind("payday", "fact"));
        assert!(should_promote_memory_kind("goal", "fact"));
    }
}
