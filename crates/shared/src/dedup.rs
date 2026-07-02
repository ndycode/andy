use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::time::MANILA_OFFSET_MINUTES;

const KEY_SEPARATOR: char = '\0';

#[must_use]
pub fn content_dedup_key(phone: &str, text: &str, at: DateTime<Utc>) -> String {
    let offset_ms = i64::from(MANILA_OFFSET_MINUTES) * 60_000;
    let minute_bucket = (at.timestamp_millis() + offset_ms).div_euclid(60_000);
    // Strip control chars (notably the \0 that serves as the field separator)
    // before joining, so no phone/text content can inject a separator and shift
    // the field boundary to collide with a different (phone, text) pair. Keeps
    // the key injective over the three fields.
    let phone = strip_control(phone);
    let text = strip_control(text.trim());
    let input = [phone.as_str(), text.as_str(), &minute_bucket.to_string()]
        .join(&KEY_SEPARATOR.to_string());
    let digest = Sha256::digest(input.as_bytes());
    let hex = format!("{digest:x}");
    format!("ch_{}", &hex[..32])
}

fn strip_control(value: &str) -> String {
    value.chars().filter(|c| !c.is_control()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_dedup_key_is_stable_inside_one_minute_bucket() {
        let a = "2026-06-15T00:00:10Z".parse().unwrap();
        let b = "2026-06-15T00:00:50Z".parse().unwrap();
        assert_eq!(
            content_dedup_key("+1", " grab 180 ", a),
            content_dedup_key("+1", "grab 180", b)
        );
    }

    // Characterization: the key must DIFFER across every dimension that should
    // not collapse, so double-log protection stays scoped to true duplicates.
    #[test]
    fn adjacent_minute_buckets_differ() {
        let a = "2026-06-15T00:00:59Z".parse().unwrap();
        let b = "2026-06-15T00:01:00Z".parse().unwrap();
        assert_ne!(
            content_dedup_key("+1", "grab 180", a),
            content_dedup_key("+1", "grab 180", b)
        );
    }

    #[test]
    fn same_text_from_two_phones_differs() {
        let at = "2026-06-15T00:00:10Z".parse().unwrap();
        assert_ne!(
            content_dedup_key("+1", "grab 180", at),
            content_dedup_key("+2", "grab 180", at)
        );
    }

    #[test]
    fn two_texts_in_one_bucket_differ() {
        let at = "2026-06-15T00:00:10Z".parse().unwrap();
        assert_ne!(
            content_dedup_key("+1", "grab 180", at),
            content_dedup_key("+1", "grab 200", at)
        );
    }

    #[test]
    fn separator_prevents_field_boundary_collision() {
        // Without the \0 separator, ("+1","23") and ("+12","3") would hash the
        // same concatenation. The separator must keep them distinct.
        let at = "2026-06-15T00:00:10Z".parse().unwrap();
        assert_ne!(
            content_dedup_key("+1", "23", at),
            content_dedup_key("+12", "3", at)
        );
    }
}
