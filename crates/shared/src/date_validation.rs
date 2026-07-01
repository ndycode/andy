use chrono::{DateTime, Datelike, NaiveDate, Utc};

use crate::time::{local_date, MANILA_OFFSET_MINUTES};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DateResult {
    Ok(NaiveDate),
    Err(&'static str),
}

pub fn validate_log_date(input: &str, now: DateTime<Utc>) -> DateResult {
    let parsed = match parse_calendar_date(input) {
        DateResult::Ok(date) => date,
        err => return err,
    };
    let today = local_date(now, MANILA_OFFSET_MINUTES);
    if parsed > today {
        return DateResult::Err("can't log a future date");
    }
    if parsed.year() < today.year() - 5 {
        return DateResult::Err("that's too far back");
    }
    DateResult::Ok(parsed)
}

pub fn validate_calendar_date(input: &str) -> DateResult {
    parse_calendar_date(input)
}

fn parse_calendar_date(input: &str) -> DateResult {
    let s = input.trim();
    let parts = s.split('-').collect::<Vec<_>>();
    if parts.len() != 3 || parts.iter().any(|part| part.len() != 2 && part.len() != 4) {
        return DateResult::Err("date must be YYYY-MM-DD");
    }
    if parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return DateResult::Err("date must be YYYY-MM-DD");
    }
    let Ok(year) = parts[0].parse::<i32>() else {
        return DateResult::Err("date must be YYYY-MM-DD");
    };
    let Ok(month) = parts[1].parse::<u32>() else {
        return DateResult::Err("date must be YYYY-MM-DD");
    };
    let Ok(day) = parts[2].parse::<u32>() else {
        return DateResult::Err("date must be YYYY-MM-DD");
    };
    NaiveDate::from_ymd_opt(year, month, day)
        .map(DateResult::Ok)
        .unwrap_or(DateResult::Err("not a real date"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_real_calendar_dates() {
        assert_eq!(
            validate_calendar_date("2026-02-28"),
            DateResult::Ok("2026-02-28".parse().unwrap())
        );
        assert_eq!(
            validate_calendar_date("2026-02-30"),
            DateResult::Err("not a real date")
        );
        assert_eq!(
            validate_calendar_date("2026/02/28"),
            DateResult::Err("date must be YYYY-MM-DD")
        );
    }

    #[test]
    fn rejects_future_and_too_old_log_dates() {
        let now = "2026-06-15T00:00:00Z".parse().unwrap();
        assert_eq!(
            validate_log_date("2026-06-16", now),
            DateResult::Err("can't log a future date")
        );
        assert_eq!(
            validate_log_date("2020-01-01", now),
            DateResult::Err("that's too far back")
        );
    }

    // Characterization: the "too far back" bound is a whole-year comparison at
    // today.year() - 5, so the entire year-5 is accepted and year-6 is rejected.
    #[test]
    fn log_date_year_bound_is_inclusive_at_minus_five() {
        let now = "2026-06-15T00:00:00Z".parse().unwrap();
        // year() - 5 == 2021: accepted even on Jan 1.
        assert_eq!(
            validate_log_date("2021-01-01", now),
            DateResult::Ok("2021-01-01".parse().unwrap())
        );
        // year() - 6 == 2020: rejected.
        assert_eq!(
            validate_log_date("2020-12-31", now),
            DateResult::Err("that's too far back")
        );
    }

    #[test]
    fn same_day_log_is_accepted() {
        let now = "2026-06-15T00:00:00Z".parse().unwrap();
        assert_eq!(
            validate_log_date("2026-06-15", now),
            DateResult::Ok("2026-06-15".parse().unwrap())
        );
    }

    #[test]
    fn leap_day_validates_through_log_path() {
        let now = "2026-06-15T00:00:00Z".parse().unwrap();
        // 2024 is a leap year: Feb 29 is real and within range.
        assert_eq!(
            validate_log_date("2024-02-29", now),
            DateResult::Ok("2024-02-29".parse().unwrap())
        );
        // 2026 is not a leap year: Feb 29 is not a real date.
        assert_eq!(
            validate_calendar_date("2026-02-29"),
            DateResult::Err("not a real date")
        );
    }
}
