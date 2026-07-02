use regex::Regex;
use rust_decimal::Decimal;
use std::{str::FromStr, sync::LazyLock};
use thiserror::Error;

pub const MAX_ENTRY_CENTAVOS: i64 = 100_000_000_000;
pub const MAX_AGGREGATE_CENTAVOS: i64 = 10_000_000_000_000;

static RANGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\d\s*(?:-|to|–|—)\s*\d").expect("valid range regex"));
static GROUPED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{1,3}(,\d{3})+(\.\d+)?$").expect("valid grouped regex"));
static DECIMAL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d*\.?\d+$").expect("valid decimal regex"));

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MoneyError {
    #[error("empty")]
    Empty,
    #[error("looks like a range - send one amount")]
    Range,
    #[error("that grouping looks off - send the plain number")]
    Grouping,
    #[error("unparseable amount: \"{0}\"")]
    Unparseable(String),
    #[error("not finite")]
    NotFinite,
    #[error("must be positive")]
    NonPositive,
    #[error("exceeds per-entry cap")]
    ExceedsCap,
}

pub fn parse_amount(raw: &str) -> Result<i64, MoneyError> {
    let original = raw.to_string();
    let mut s = raw.trim().to_ascii_lowercase();
    if s.is_empty() {
        return Err(MoneyError::Empty);
    }

    s = s
        .replace('₱', "")
        .replace("php", "")
        .replace("pesos", "")
        .replace("peso", "")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .trim()
        .to_string();

    if RANGE_RE.is_match(&s) {
        return Err(MoneyError::Range);
    }

    let suffix_exp = match s.chars().last() {
        Some('k') => {
            s.pop();
            3_u32
        }
        Some('m') => {
            s.pop();
            6_u32
        }
        _ => 0_u32,
    };

    if s.ends_with('.') {
        s.pop();
    }
    if s.starts_with('.') {
        s.insert(0, '0');
    }

    if s.contains(',') {
        if !GROUPED_RE.is_match(&s) {
            return Err(MoneyError::Grouping);
        }
        s = s.replace(',', "");
    }

    if s.is_empty() || !DECIMAL_RE.is_match(&s) {
        return Err(MoneyError::Unparseable(original));
    }

    let multiplier = Decimal::from(10_i64.pow(2 + suffix_exp));
    let pesos = Decimal::from_str(&s).map_err(|_| MoneyError::NotFinite)?;
    // checked_mul: a hostile-but-numeric input (e.g. a 27-digit run) can make
    // the Decimal multiply overflow. That must be a clean Err, never a panic —
    // this path is reachable from the unauthenticated webhook body.
    let centavos = pesos
        .checked_mul(multiplier)
        .map(|product| product.round())
        .and_then(|rounded| rounded.to_i64())
        .ok_or(MoneyError::NotFinite)?;

    if centavos <= 0 {
        return Err(MoneyError::NonPositive);
    }
    if centavos > MAX_ENTRY_CENTAVOS {
        return Err(MoneyError::ExceedsCap);
    }
    Ok(centavos)
}

#[must_use]
pub fn format_php(centavos: i64) -> String {
    let sign = if centavos < 0 { "-" } else { "" };
    // unsigned_abs, not abs(): i64::MIN.abs() has no positive i64 and panics
    // (debug) / corrupts (release). format_php runs on sums/deltas/goal
    // balances, not just capped entries, so a large negative aggregate can
    // reach i64::MIN. u64 covers |i64::MIN| exactly.
    let abs = centavos.unsigned_abs();
    let pesos = abs / 100;
    let cents = abs % 100;
    format!("{sign}₱{}.{cents:02}", group_thousands(pesos))
}

fn group_thousands(value: u64) -> String {
    let raw = value.to_string();
    let mut out = String::with_capacity(raw.len() + raw.len() / 3);
    for (idx, ch) in raw.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

trait DecimalToI64 {
    fn to_i64(self) -> Option<i64>;
}

impl DecimalToI64 for Decimal {
    fn to_i64(self) -> Option<i64> {
        i64::from_str(&self.to_string()).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_human_amounts_to_centavos() {
        assert_eq!(parse_amount("180").unwrap(), 18_000);
        assert_eq!(parse_amount("180.50").unwrap(), 18_050);
        assert_eq!(parse_amount("25k").unwrap(), 2_500_000);
        assert_eq!(parse_amount("1.5k").unwrap(), 150_000);
        assert_eq!(parse_amount("₱1,250.75").unwrap(), 125_075);
        assert_eq!(parse_amount(".99").unwrap(), 99);
    }

    #[test]
    fn rejects_ranges_grouping_and_non_positive_values() {
        assert_eq!(parse_amount("100-200"), Err(MoneyError::Range));
        assert_eq!(parse_amount("12,34"), Err(MoneyError::Grouping));
        assert_eq!(parse_amount("0"), Err(MoneyError::NonPositive));
    }

    #[test]
    fn formats_php_from_integer_centavos() {
        assert_eq!(format_php(2_500_000), "₱25,000.00");
        assert_eq!(format_php(-18_050), "-₱180.50");
    }

    // Characterization tests: pin the current rounding + cap contract so any
    // refactor of the parse path is caught. Rounding follows rust_decimal's
    // default `.round()` (banker's / half-to-even) on the centavo value.
    #[test]
    fn rounding_at_half_centavo_boundaries_is_locked() {
        assert_eq!(parse_amount("180.505").unwrap(), 18_050); // 18050.5 -> even 18050
        assert_eq!(parse_amount("180.995").unwrap(), 18_100); // 18099.5 -> even 18100
        assert_eq!(parse_amount("0.015").unwrap(), 2); // 1.5 -> even 2
        assert_eq!(parse_amount("2.675").unwrap(), 268); // 267.5 -> even 268
    }

    #[test]
    fn million_suffix_scales_to_centavos() {
        assert_eq!(parse_amount("2m").unwrap(), 200_000_000);
    }

    #[test]
    fn grouped_amount_with_fraction_rounds() {
        assert_eq!(parse_amount("1,000,000.999").unwrap(), 100_000_100);
    }

    #[test]
    fn value_just_over_entry_cap_is_rejected() {
        // MAX_ENTRY_CENTAVOS is exactly 1_000_000_000.00 pesos.
        assert_eq!(parse_amount("1000000000.00").unwrap(), MAX_ENTRY_CENTAVOS);
        assert_eq!(parse_amount("1000000000.01"), Err(MoneyError::ExceedsCap));
    }

    #[test]
    fn value_overflowing_i64_is_not_finite() {
        // 1e17 pesos * 100 overflows i64 before the cap check runs.
        assert_eq!(
            parse_amount("99999999999999999"),
            Err(MoneyError::NotFinite)
        );
    }
}
