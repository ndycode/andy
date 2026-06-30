//! Deterministic write-safety policy.
//!
//! The model proposes [`WriteIntent`]s, but it must not be the final authority
//! on dangerous finance actions. [`classify_writes`] runs between agent output
//! and the DB flush and decides whether a turn is safe to commit, needs
//! explicit user confirmation, or must be rejected outright. It is pure and
//! fully testable — no IO, no clock — so the rules are auditable.

use andy_db::writes::{TxKind, WriteIntent};
use serde::{Deserialize, Serialize};

/// Default high-value threshold: ₱50,000.00 in centavos. A single create/edit
/// at or above this asks for confirmation even though it is otherwise ordinary.
pub const DEFAULT_CONFIRM_THRESHOLD_CENTAVOS: i64 = 5_000_000;

/// More than this many ledger-affecting writes in one turn is treated as
/// suspicious and asks for confirmation.
pub const MAX_WRITES_PER_TURN: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicySettings {
    /// Confirmation threshold in centavos for create/edit amounts.
    pub confirm_threshold_centavos: i64,
}

impl Default for PolicySettings {
    fn default() -> Self {
        Self {
            confirm_threshold_centavos: DEFAULT_CONFIRM_THRESHOLD_CENTAVOS,
        }
    }
}

impl PolicySettings {
    /// Build from an optional env-configured threshold, falling back to the
    /// default when unset or non-positive.
    #[must_use]
    pub fn from_threshold(threshold: Option<i64>) -> Self {
        Self {
            confirm_threshold_centavos: threshold
                .filter(|&t| t > 0)
                .unwrap_or(DEFAULT_CONFIRM_THRESHOLD_CENTAVOS),
        }
    }
}

/// Outcome of classifying a turn's writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WriteRisk {
    /// Safe to commit immediately.
    Safe,
    /// Hold the writes, ask the user to confirm, commit only on yes.
    NeedsConfirmation { reason: String, summary: String },
    /// Refuse; the combination could corrupt ledger integrity.
    Reject { reason: String },
}

/// A short, standalone reply to an outstanding confirmation prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmReply {
    Yes,
    No,
}

/// Detect whether a message is a bare yes/no answer to a pending confirmation.
/// Deliberately strict: only short, unambiguous affirmations/cancellations
/// count, so a normal finance message ("yes please log 200") is NOT treated as
/// a blind confirmation.
#[must_use]
pub fn confirm_reply(text: &str) -> Option<ConfirmReply> {
    let normalized = text
        .trim()
        .to_ascii_lowercase()
        .trim_matches(|c: char| !c.is_ascii_alphanumeric())
        .to_string();
    match normalized.as_str() {
        "yes" | "y" | "yeah" | "yep" | "yup" | "confirm" | "confirmed" | "ok" | "okay" | "sure"
        | "go ahead" | "do it" | "proceed" | "g" | "sige" | "oo" => Some(ConfirmReply::Yes),
        "no" | "n" | "nope" | "cancel" | "stop" | "nvm" | "nevermind" | "never mind" | "wag"
        | "huwag" | "dont" => Some(ConfirmReply::No),
        _ => None,
    }
}

/// True for writes that delete or remove durable state — the destructive set.
#[must_use]
fn is_destructive(intent: &WriteIntent) -> bool {
    matches!(
        intent,
        WriteIntent::DeleteLast { .. }
            | WriteIntent::DeleteGoal { .. }
            | WriteIntent::RemoveBudget { .. }
            | WriteIntent::RemoveRecurring { .. }
            | WriteIntent::ForgetMemory { .. }
    )
}

/// True for writes that create or modify ledger/financial state (used to count
/// "real" writes and detect constructive actions mixed with destructive ones).
#[must_use]
fn is_constructive_ledger(intent: &WriteIntent) -> bool {
    matches!(
        intent,
        WriteIntent::Transaction { .. }
            | WriteIntent::GoalContribution { .. }
            | WriteIntent::EditLast { .. }
            | WriteIntent::CreateGoal { .. }
            | WriteIntent::EditGoal { .. }
            | WriteIntent::SetBudget { .. }
            | WriteIntent::AddRecurring { .. }
            | WriteIntent::EditRecurring { .. }
            | WriteIntent::Transfer { .. }
    )
}

/// Conversation bookkeeping (turns, outbound replies) never affects the ledger
/// and is excluded from all counts and checks.
#[must_use]
fn is_bookkeeping(intent: &WriteIntent) -> bool {
    matches!(
        intent,
        WriteIntent::SaveTurn { .. } | WriteIntent::OutboundReply { .. }
    )
}

/// The largest create/edit amount in the turn, if any. `EditLast` with no new
/// amount contributes nothing.
#[must_use]
fn max_amount_centavos(writes: &[WriteIntent]) -> Option<i64> {
    writes
        .iter()
        .filter_map(|intent| match intent {
            WriteIntent::Transaction {
                amount_centavos, ..
            }
            | WriteIntent::GoalContribution {
                amount_centavos, ..
            }
            | WriteIntent::Transfer {
                amount_centavos, ..
            } => Some(*amount_centavos),
            WriteIntent::EditLast {
                amount_centavos, ..
            } => *amount_centavos,
            WriteIntent::SetBudget {
                monthly_limit_centavos,
                ..
            } => Some(*monthly_limit_centavos),
            WriteIntent::CreateGoal {
                target_centavos, ..
            } => Some(*target_centavos),
            _ => None,
        })
        .max()
}

/// Short human label for a single write, used to build a confirmation summary.
#[must_use]
fn describe(intent: &WriteIntent) -> &'static str {
    match intent {
        WriteIntent::Transaction {
            kind: TxKind::Income,
            ..
        } => "log income",
        WriteIntent::Transaction { .. } => "log expense",
        WriteIntent::GoalContribution { .. } => "add to a goal",
        WriteIntent::EditLast { .. } => "edit the last entry",
        WriteIntent::DeleteLast { .. } => "delete the last entry",
        WriteIntent::CreateGoal { .. } => "create a goal",
        WriteIntent::SetBudget { .. } => "set a budget",
        WriteIntent::RemoveBudget { .. } => "remove a budget",
        WriteIntent::EditGoal { .. } => "edit a goal",
        WriteIntent::DeleteGoal { .. } => "delete a goal",
        WriteIntent::SaveMemory { .. } => "save a memory",
        WriteIntent::ForgetMemory { .. } => "forget a memory",
        WriteIntent::AddRecurring { .. } => "add a recurring reminder",
        WriteIntent::RemoveRecurring { .. } => "remove a recurring reminder",
        WriteIntent::EditRecurring { .. } => "edit a recurring reminder",
        WriteIntent::Transfer { .. } => "move money between accounts",
        WriteIntent::SaveTurn { .. } | WriteIntent::OutboundReply { .. } => "note the conversation",
    }
}

/// Build a short, comma-joined summary of the ledger-affecting writes for a
/// confirmation prompt.
#[must_use]
fn summarize(writes: &[WriteIntent]) -> String {
    let parts: Vec<&str> = writes
        .iter()
        .filter(|w| !is_bookkeeping(w))
        .map(describe)
        .collect();
    parts.join(", ")
}

/// Classify a turn's writes. `input_text` is the user's message (reserved for
/// future correction-targeting heuristics; unused fields are intentional).
#[must_use]
pub fn classify_writes(
    _input_text: &str,
    writes: &[WriteIntent],
    settings: PolicySettings,
) -> WriteRisk {
    let ledger: Vec<&WriteIntent> = writes.iter().filter(|w| !is_bookkeeping(w)).collect();
    if ledger.is_empty() {
        return WriteRisk::Safe;
    }

    // Reject: a memory write whose content is plainly a one-off transaction
    // would corrupt durable memory with ephemeral data.
    for intent in &ledger {
        if let WriteIntent::SaveMemory { content, .. } = intent
            && looks_like_one_off_transaction(content)
        {
            return WriteRisk::Reject {
                reason: "refusing to store a one-off transaction as durable memory".to_string(),
            };
        }
    }

    let destructive = ledger.iter().filter(|w| is_destructive(w)).count();
    let constructive = ledger.iter().filter(|w| is_constructive_ledger(w)).count();
    let summary = summarize(writes);

    // Needs confirmation: any destructive action.
    if destructive > 0 {
        // Mixed destructive + constructive in one turn is ambiguous.
        let reason = if constructive > 0 {
            "this turn both removes and changes records".to_string()
        } else {
            "this removes saved data".to_string()
        };
        return WriteRisk::NeedsConfirmation { reason, summary };
    }

    // Needs confirmation: too many writes at once.
    if ledger.len() > MAX_WRITES_PER_TURN {
        return WriteRisk::NeedsConfirmation {
            reason: format!("{} changes in one message", ledger.len()),
            summary,
        };
    }

    // Needs confirmation: a high-value create/edit.
    if let Some(max) = max_amount_centavos(writes)
        && max >= settings.confirm_threshold_centavos
    {
        return WriteRisk::NeedsConfirmation {
            reason: "that's a large amount".to_string(),
            summary,
        };
    }

    WriteRisk::Safe
}

/// Heuristic: does memory content read like a logged transaction (has a number
/// and a spend verb)? Mirrors the agent's own remember-gate so the policy is a
/// backstop, not the only guard.
#[must_use]
fn looks_like_one_off_transaction(content: &str) -> bool {
    let normalized = content.to_ascii_lowercase();
    let has_digit = normalized.chars().any(|c| c.is_ascii_digit());
    const SPEND_CUES: &[&str] = &[
        "spent", "bought", "paid", "ordered", "logged", "grab", "lunch", "dinner", "coffee",
    ];
    has_digit && SPEND_CUES.iter().any(|cue| normalized.contains(cue))
}

#[cfg(test)]
mod tests {
    use super::*;
    use andy_shared::categories::Category;
    use uuid::Uuid;

    fn expense(amount: i64) -> WriteIntent {
        WriteIntent::Transaction {
            kind: TxKind::Expense,
            user_id: Uuid::nil(),
            amount_centavos: amount,
            category: Category::Food,
            note: None,
            local_date: "2026-06-15".parse().unwrap(),
            account: None,
        }
    }

    fn settings() -> PolicySettings {
        PolicySettings::default()
    }

    #[test]
    fn ordinary_expense_is_safe() {
        assert_eq!(
            classify_writes("lunch 180", &[expense(18_000)], settings()),
            WriteRisk::Safe
        );
    }

    #[test]
    fn bookkeeping_only_is_safe() {
        let writes = vec![WriteIntent::SaveTurn {
            user_id: Uuid::nil(),
            role: andy_db::writes::MessageRole::User,
            content: "hi".into(),
        }];
        assert_eq!(classify_writes("hi", &writes, settings()), WriteRisk::Safe);
    }

    #[test]
    fn delete_needs_confirmation() {
        let writes = vec![WriteIntent::DeleteLast {
            user_id: Uuid::nil(),
            target_id: None,
            target_same_turn: false,
        }];
        assert!(matches!(
            classify_writes("undo that", &writes, settings()),
            WriteRisk::NeedsConfirmation { .. }
        ));
    }

    #[test]
    fn high_amount_needs_confirmation() {
        assert!(matches!(
            classify_writes("paid 60k", &[expense(6_000_000)], settings()),
            WriteRisk::NeedsConfirmation { .. }
        ));
    }

    #[test]
    fn too_many_writes_need_confirmation() {
        let writes = vec![
            expense(100),
            expense(100),
            expense(100),
            expense(100),
            expense(100),
            expense(100),
        ];
        assert!(matches!(
            classify_writes("batch", &writes, settings()),
            WriteRisk::NeedsConfirmation { .. }
        ));
    }

    #[test]
    fn mixed_destructive_and_constructive_needs_confirmation() {
        let writes = vec![
            expense(100),
            WriteIntent::DeleteGoal {
                user_id: Uuid::nil(),
                goal_id: Uuid::nil(),
            },
        ];
        match classify_writes("change stuff", &writes, settings()) {
            WriteRisk::NeedsConfirmation { reason, .. } => {
                assert!(reason.contains("removes and changes"));
            }
            other => panic!("expected confirmation, got {other:?}"),
        }
    }

    #[test]
    fn one_off_transaction_as_memory_is_rejected() {
        let writes = vec![WriteIntent::SaveMemory {
            user_id: Uuid::nil(),
            content: "spent 180 on coffee today".into(),
            kind: andy_db::writes::MemoryKind::Fact,
        }];
        assert!(matches!(
            classify_writes("remember I spent 180 on coffee", &writes, settings()),
            WriteRisk::Reject { .. }
        ));
    }

    #[test]
    fn threshold_is_configurable() {
        let strict = PolicySettings {
            confirm_threshold_centavos: 10_000,
        };
        assert!(matches!(
            classify_writes("paid 200", &[expense(20_000)], strict),
            WriteRisk::NeedsConfirmation { .. }
        ));
    }

    #[test]
    fn confirm_reply_detects_bare_yes_no_only() {
        assert_eq!(confirm_reply("yes"), Some(ConfirmReply::Yes));
        assert_eq!(confirm_reply("Confirm!"), Some(ConfirmReply::Yes));
        assert_eq!(confirm_reply(" go ahead "), Some(ConfirmReply::Yes));
        assert_eq!(confirm_reply("no"), Some(ConfirmReply::No));
        assert_eq!(confirm_reply("cancel"), Some(ConfirmReply::No));
        // Not bare answers — must not be treated as confirmations.
        assert_eq!(confirm_reply("yes please log 200 for grab"), None);
        assert_eq!(confirm_reply("grab 180"), None);
    }

    #[test]
    fn ordinary_transfer_is_safe_but_large_one_confirms() {
        let small = WriteIntent::Transfer {
            user_id: Uuid::nil(),
            amount_centavos: 50_000,
            from_account: Some("BPI".into()),
            to_account: Some("savings".into()),
            note: None,
            local_date: "2026-06-15".parse().unwrap(),
        };
        assert_eq!(
            classify_writes("move to savings", std::slice::from_ref(&small), settings()),
            WriteRisk::Safe
        );
        let big = WriteIntent::Transfer {
            user_id: Uuid::nil(),
            amount_centavos: 9_000_000,
            from_account: Some("BPI".into()),
            to_account: Some("savings".into()),
            note: None,
            local_date: "2026-06-15".parse().unwrap(),
        };
        assert!(matches!(
            classify_writes("move 90k to savings", &[big], settings()),
            WriteRisk::NeedsConfirmation { .. }
        ));
    }
}
