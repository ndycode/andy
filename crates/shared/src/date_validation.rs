use chrono::{DateTime, Datelike, NaiveDate, Utc};

use crate::time::{MANILA_OFFSET_MINUTES, local_date};

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
}
