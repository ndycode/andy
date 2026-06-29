use crate::security::constant_time_equal;

#[must_use]
pub fn normalize_phone(raw: &str) -> String {
    let trimmed = raw.trim();
    let digits: String = trimmed.chars().filter(char::is_ascii_digit).collect();
    if digits.is_empty() {
        String::new()
    } else {
        format!("+{digits}")
    }
}

#[must_use]
pub fn is_allowed(inbound: &str, allowed: &str) -> bool {
    let inbound = normalize_phone(inbound);
    let allowed = normalize_phone(allowed);
    !inbound.is_empty() && !allowed.is_empty() && constant_time_equal(&inbound, &allowed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_compares_e164_style_numbers() {
        assert_eq!(normalize_phone(" +63 917 123 4567 "), "+639171234567");
        assert!(is_allowed("+63 917 123 4567", "639171234567"));
        assert!(!is_allowed("+639171234567", "+639171234568"));
    }
}
