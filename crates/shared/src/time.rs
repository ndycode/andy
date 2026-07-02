use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike, Utc};

pub const MANILA_OFFSET_MINUTES: i32 = 8 * 60;
pub const APP_TIMEZONE_DEFAULT: &str = "Asia/Manila";

/// Single source of truth for app date math.
///
/// Andy is a single-user, Asia/Manila product, so the timezone is a fixed
/// product invariant rather than per-request state. This struct makes that
/// invariant explicit and injectable: business logic that needs the offset
/// should take an `AppTimeConfig` instead of reaching for `MANILA_OFFSET_MINUTES`
/// or reading env deep in a helper. Build it from validated config via
/// [`crate::env::Env::time_config`], which honors the `APP_TIMEZONE` /
/// `APP_TIMEZONE_OFFSET_MINUTES` overrides and defaults to Manila.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppTimeConfig {
    pub label: String,
    pub offset_minutes: i32,
}

impl Default for AppTimeConfig {
    fn default() -> Self {
        Self {
            label: APP_TIMEZONE_DEFAULT.to_string(),
            offset_minutes: MANILA_OFFSET_MINUTES,
        }
    }
}

impl AppTimeConfig {
    /// Build from explicit values (clamped offset is the caller's job; see
    /// [`crate::env::Env`]).
    #[must_use]
    pub fn new(label: impl Into<String>, offset_minutes: i32) -> Self {
        Self {
            label: label.into(),
            offset_minutes,
        }
    }

    /// Local calendar date for an instant under this config.
    #[must_use]
    pub fn local_date(&self, at: DateTime<Utc>) -> NaiveDate {
        local_date(at, self.offset_minutes)
    }

    /// Inclusive month bounds for the month containing `at`.
    #[must_use]
    pub fn month_range(&self, at: DateTime<Utc>) -> (NaiveDate, NaiveDate) {
        month_range(at, self.offset_minutes)
    }
}

#[must_use]
pub fn local_date(at: DateTime<Utc>, offset_minutes: i32) -> NaiveDate {
    // checked_add_signed, not `+`: chrono's Add panics at the DateTime::MAX/MIN
    // extreme. No current caller reaches it (all `at` derive from Utc::now()
    // and offsets are clamped to +/-14h), but this keeps local_date total.
    at.checked_add_signed(Duration::minutes(i64::from(offset_minutes)))
        .unwrap_or(at)
        .date_naive()
}

#[must_use]
pub fn local_date_string(at: DateTime<Utc>, offset_minutes: i32) -> String {
    local_date(at, offset_minutes).to_string()
}

#[must_use]
pub fn month_range(at: DateTime<Utc>, offset_minutes: i32) -> (NaiveDate, NaiveDate) {
    month_bounds(local_date(at, offset_minutes))
}

/// Inclusive first/last day of the month containing `date`. Pure date math, so
/// it is deterministic in tests and reusable wherever a `NaiveDate` is already
/// in hand (read tools, budget reactions) without re-deriving from a clock.
#[must_use]
pub fn month_bounds(date: NaiveDate) -> (NaiveDate, NaiveDate) {
    let first = NaiveDate::from_ymd_opt(date.year(), date.month(), 1).expect("valid month first");
    // December's last day is always the 31st — computing it directly avoids
    // constructing year+1, which panics at chrono's max year. For other months
    // the last day is (first-of-next-month - 1 day), same year.
    let last = if date.month() == 12 {
        NaiveDate::from_ymd_opt(date.year(), 12, 31).expect("Dec 31 is valid")
    } else {
        NaiveDate::from_ymd_opt(date.year(), date.month() + 1, 1).expect("valid next month")
            - Duration::days(1)
    };
    (first, last)
}

/// Parse a `YYYY-MM` string into a validated `(year, month)` pair. Returns
/// `None` for malformed input or an out-of-range year (2000..=2100) / month.
/// Single source of truth for [`month_bounds_from_str`] and [`month_anchor`].
#[must_use]
pub fn parse_year_month(yyyymm: &str) -> Option<(i32, u32)> {
    let (year, month) = yyyymm.trim().split_once('-')?;
    let year = year.parse::<i32>().ok()?;
    let month = month.parse::<u32>().ok()?;
    if !(2000..=2100).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    Some((year, month))
}

/// Parse a `YYYY-MM` month string into its inclusive first/last day bounds.
/// Returns `None` for malformed input or out-of-range year/month.
#[must_use]
pub fn month_bounds_from_str(yyyymm: &str) -> Option<(NaiveDate, NaiveDate)> {
    let (year, month) = parse_year_month(yyyymm)?;
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    Some(month_bounds(first))
}

#[must_use]
pub fn current_week_start(at: DateTime<Utc>, offset_minutes: i32) -> NaiveDate {
    let d = local_date(at, offset_minutes);
    let days_since_monday = i64::from(d.weekday().num_days_from_monday());
    d - Duration::days(days_since_monday)
}

#[must_use]
pub fn local_hour(at: DateTime<Utc>, offset_minutes: i32) -> u32 {
    (at + Duration::minutes(i64::from(offset_minutes))).hour()
}

#[must_use]
pub fn local_day_of_month(at: DateTime<Utc>, offset_minutes: i32) -> u32 {
    local_date(at, offset_minutes).day()
}

#[must_use]
pub fn local_day_of_week(at: DateTime<Utc>, offset_minutes: i32) -> u32 {
    local_date(at, offset_minutes)
        .weekday()
        .num_days_from_sunday()
}

#[must_use]
pub fn days_in_local_month(at: DateTime<Utc>, offset_minutes: i32) -> u32 {
    let (_, end) = month_range(at, offset_minutes);
    end.day()
}

#[must_use]
pub fn month_anchor(yyyymm: &str) -> Option<DateTime<Utc>> {
    let (year, month) = parse_year_month(yyyymm)?;
    Utc.with_ymd_and_hms(year, month, 15, 4, 0, 0).single()
}

#[must_use]
pub fn prev_month_anchor(at: DateTime<Utc>, offset_minutes: i32) -> DateTime<Utc> {
    let d = local_date(at, offset_minutes);
    let (year, month) = if d.month() == 1 {
        (d.year() - 1, 12)
    } else {
        (d.year(), d.month() - 1)
    };
    Utc.with_ymd_and_hms(year, month, 15, 4, 0, 0)
        .single()
        .expect("valid previous month anchor")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn local_date_uses_fixed_offset() {
        assert_eq!(
            local_date_string(dt("2026-06-14T16:01:00Z"), MANILA_OFFSET_MINUTES),
            "2026-06-15"
        );
    }

    #[test]
    fn month_range_is_inclusive() {
        let (start, end) = month_range(dt("2026-02-20T00:00:00Z"), MANILA_OFFSET_MINUTES);
        assert_eq!(start.to_string(), "2026-02-01");
        assert_eq!(end.to_string(), "2026-02-28");
    }

    #[test]
    fn app_time_config_default_is_manila() {
        let cfg = AppTimeConfig::default();
        assert_eq!(cfg.label, "Asia/Manila");
        assert_eq!(cfg.offset_minutes, MANILA_OFFSET_MINUTES);
        assert_eq!(
            cfg.local_date(dt("2026-06-14T16:01:00Z")).to_string(),
            "2026-06-15"
        );
        let custom = AppTimeConfig::new("UTC", 0);
        assert_eq!(
            custom.local_date(dt("2026-06-14T16:01:00Z")).to_string(),
            "2026-06-14"
        );
    }

    #[test]
    fn week_start_is_monday() {
        assert_eq!(
            current_week_start(dt("2026-06-18T00:00:00Z"), MANILA_OFFSET_MINUTES).to_string(),
            "2026-06-15"
        );
    }

    #[test]
    fn month_bounds_from_date_and_string_agree() {
        let date = "2026-02-15".parse::<NaiveDate>().unwrap();
        assert_eq!(
            month_bounds(date),
            ("2026-02-01".parse().unwrap(), "2026-02-28".parse().unwrap())
        );
        assert_eq!(month_bounds_from_str("2026-02"), Some(month_bounds(date)));
        assert_eq!(month_bounds_from_str("2026-13"), None);
        assert_eq!(month_bounds_from_str("nope"), None);
    }
}
