use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::time::MANILA_OFFSET_MINUTES;

const KEY_SEPARATOR: char = '\0';

#[must_use]
pub fn content_dedup_key(phone: &str, text: &str, at: DateTime<Utc>) -> String {
    let offset_ms = i64::from(MANILA_OFFSET_MINUTES) * 60_000;
    let minute_bucket = (at.timestamp_millis() + offset_ms).div_euclid(60_000);
    let input = [phone, text.trim(), &minute_bucket.to_string()].join(&KEY_SEPARATOR.to_string());
    let digest = Sha256::digest(input.as_bytes());
    let hex = format!("{digest:x}");
    format!("ch_{}", &hex[..32])
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
}
