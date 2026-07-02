//! Property-based stress tests for the deterministic write-safety gate.
//!
//! `classify_writes` is the sole authority that decides whether money writes
//! commit, need confirmation, or are rejected. These properties lock the
//! guarantees that matter regardless of what combination of writes the model
//! (or an attacker steering it) produces:
//!   - a destructive write is NEVER classified Safe;
//!   - a turn whose aggregate amount reaches the threshold NEVER commits
//!     silently (closes the split-into-sub-threshold-writes bypass);
//!   - classify_writes never panics for any write vector.

use andy_ai::policy::{DEFAULT_CONFIRM_THRESHOLD_CENTAVOS, MAX_WRITES_PER_TURN};
use andy_ai::{PolicySettings, WriteRisk, classify_writes};
use andy_shared::categories::Category;
use andy_shared::domain::{TxKind, WriteIntent};
use chrono::NaiveDate;
use proptest::prelude::*;
use uuid::Uuid;

fn expense(amount: i64) -> WriteIntent {
    WriteIntent::Transaction {
        kind: TxKind::Expense,
        user_id: Uuid::nil(),
        amount_centavos: amount,
        category: Category::Food,
        note: None,
        local_date: NaiveDate::from_ymd_opt(2026, 6, 15).unwrap(),
        account: None,
    }
}

fn delete_last() -> WriteIntent {
    WriteIntent::DeleteLast {
        user_id: Uuid::nil(),
        target_id: None,
        target_same_turn: false,
    }
}

proptest! {
    /// classify_writes never panics for any vector of amounts.
    #[test]
    fn classify_never_panics(amounts in prop::collection::vec(any::<i64>(), 0..10)) {
        let writes: Vec<WriteIntent> = amounts.into_iter().map(expense).collect();
        let _ = classify_writes("stress", &writes, PolicySettings::default());
    }

    /// A turn containing any destructive write is NEVER Safe — it must require
    /// confirmation (or reject). This is the core safety invariant.
    #[test]
    fn destructive_is_never_safe(
        n_expenses in 0usize..6,
        amount in 1i64..1_000_000,
    ) {
        let mut writes: Vec<WriteIntent> = (0..n_expenses).map(|_| expense(amount)).collect();
        writes.push(delete_last());
        let risk = classify_writes("delete stuff", &writes, PolicySettings::default());
        prop_assert_ne!(risk, WriteRisk::Safe, "a destructive write was classified Safe");
    }

    /// If the ABSOLUTE TOTAL of amount-bearing writes reaches the threshold, the
    /// turn is never Safe — even when every individual write is below it and the
    /// count is within MAX_WRITES_PER_TURN. This closes the aggregate-bypass.
    #[test]
    fn large_aggregate_is_never_safe(
        // 2..=MAX writes, each strictly below the threshold, chosen so their sum
        // reaches it: per-write in [threshold/MAX + 1 .. threshold-1].
        count in 2usize..=MAX_WRITES_PER_TURN,
    ) {
        let per_write = DEFAULT_CONFIRM_THRESHOLD_CENTAVOS / (MAX_WRITES_PER_TURN as i64) + 1;
        // Each is below threshold; count>=2 so the sum can reach it.
        prop_assume!(per_write < DEFAULT_CONFIRM_THRESHOLD_CENTAVOS);
        let writes: Vec<WriteIntent> = (0..count).map(|_| expense(per_write)).collect();
        let total: i64 = per_write * (count as i64);
        prop_assume!(total >= DEFAULT_CONFIRM_THRESHOLD_CENTAVOS);
        let risk = classify_writes("split", &writes, PolicySettings::default());
        prop_assert_ne!(risk, WriteRisk::Safe, "large aggregate committed without confirmation");
    }

    /// Conversely, a turn whose per-write max AND total are both well below the
    /// threshold, with a small non-destructive write count, IS Safe — the gate
    /// doesn't over-trigger on ordinary activity.
    #[test]
    fn small_ordinary_turn_is_safe(
        amounts in prop::collection::vec(1i64..10_000, 1..=3),
    ) {
        let writes: Vec<WriteIntent> = amounts.iter().copied().map(expense).collect();
        let risk = classify_writes("normal day", &writes, PolicySettings::default());
        prop_assert_eq!(risk, WriteRisk::Safe);
    }
}
