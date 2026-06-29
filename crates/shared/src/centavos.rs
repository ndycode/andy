use crate::money::MAX_AGGREGATE_CENTAVOS;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CentavosError {
    #[error("aggregate exceeds safe cap")]
    AggregateCap,
    #[error("centavo aggregate exceeds safe cap: {0}")]
    SafeCap(String),
    #[error("non-finite centavos: {0}")]
    NonFinite(String),
    #[error("non-integer centavos: {0}")]
    NonInteger(String),
}

pub fn sum_centavos(values: impl IntoIterator<Item = i64>) -> Result<i64, CentavosError> {
    let total = values
        .into_iter()
        .try_fold(0_i64, |acc, value| acc.checked_add(value))
        .ok_or(CentavosError::AggregateCap)?;
    if total.abs() > MAX_AGGREGATE_CENTAVOS {
        return Err(CentavosError::AggregateCap);
    }
    Ok(total)
}

pub fn to_safe_centavos(value: Option<&str>) -> Result<i64, CentavosError> {
    let Some(value) = value else {
        return Ok(0);
    };
    let value = value.trim();
    let parsed = value
        .parse::<i64>()
        .map_err(|_| CentavosError::NonInteger(value.to_string()))?;
    if parsed.abs() > MAX_AGGREGATE_CENTAVOS {
        return Err(CentavosError::SafeCap(value.to_string()));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_exact_centavos_with_cap() {
        assert_eq!(sum_centavos([100, -25, 50]).unwrap(), 125);
        assert_eq!(
            sum_centavos([MAX_AGGREGATE_CENTAVOS, 1]),
            Err(CentavosError::AggregateCap)
        );
    }

    #[test]
    fn coerces_sql_totals_safely() {
        assert_eq!(to_safe_centavos(None).unwrap(), 0);
        assert_eq!(to_safe_centavos(Some("123")).unwrap(), 123);
        assert!(matches!(
            to_safe_centavos(Some("12.5")),
            Err(CentavosError::NonInteger(_))
        ));
    }
}
