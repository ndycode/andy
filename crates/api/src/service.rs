//! Inbound message orchestration.
//!
//! The Sendblue webhook route stays thin (parse, auth, rate-limit, respond);
//! all the work of turning one inbound message into ledger writes and a reply
//! lives here. Extracting it keeps `routes.rs` readable and makes the inbound
//! flow easy to follow end to end: claim → confirmation? → agent → policy →
//! commit + deliver.

use andy_ai::ConfirmReply;
use andy_ai::PolicySettings;
use andy_ai::{
    AgentSnapshot, RunAgentInput, WriteRisk, classify_writes, confirm_reply, openrouter_from_env,
    run_agent,
};
use andy_db::{
    ClaimResult, FlushResult, PgFinanceRead, WriteIntent, budget_statuses_for,
    cancel_pending_confirmations, claim_slot, connect_pool, flush_writes, last_transaction,
    latest_pending_confirmation, list_goals, list_memories, list_recurring, recent_turns,
    resolve_user_id, save_pending_confirmation,
};
use andy_shared::{
    allowlist::is_allowed, budget::budget_reaction_lines, dedup::content_dedup_key, env::Env,
    errors::failure_reply, time::AppTimeConfig,
};
use chrono::Utc;
use sqlx::PgPool;
use std::collections::HashMap;
use tracing::error;
use uuid::Uuid;

use crate::{
    outbound::{SendblueClient, deliver_outbound_by_dedup_key},
    routes::AppState,
};

const CONFIRM_TTL_MINUTES: i64 = 60;

/// Orchestrates one inbound message. Borrows the shared [`AppState`] and the
/// resolved [`Env`]; resolves a pool/Sendblue/OpenRouter lazily when the state
/// doesn't already carry them (serverless lazy mode).
pub struct InboundMessageService<'a> {
    state: &'a AppState,
    env: &'a Env,
    clock: AppTimeConfig,
}

impl<'a> InboundMessageService<'a> {
    #[must_use]
    pub fn new(state: &'a AppState, env: &'a Env) -> Self {
        Self {
            state,
            env,
            clock: AppTimeConfig::from_env(),
        }
    }

    fn sendblue(&self) -> SendblueClient {
        self.state
            .sendblue
            .clone()
            .unwrap_or_else(|| SendblueClient::from_env(self.env))
    }

    async fn pool(&self) -> Result<PgPool, anyhow::Error> {
        Ok(match self.state.pool.clone() {
            Some(pool) => pool,
            None => connect_pool(&self.env.database_url).await?,
        })
    }

    /// Entry point: handle one allowed inbound message end to end.
    pub async fn handle(
        &self,
        phone: String,
        text: String,
        message_id: Option<String>,
    ) -> Result<(), anyhow::Error> {
        if !is_allowed(&phone, &self.env.allowed_phone) {
            return Ok(());
        }
        let pool = self.pool().await?;
        let dedup_id = message_id
            .clone()
            .unwrap_or_else(|| content_dedup_key(&phone, &text, Utc::now()));
        if claim_slot(&pool, &dedup_id, Utc::now()).await? == ClaimResult::Skip {
            return Ok(());
        }

        let user_id = resolve_user_id(&pool, &phone).await?;

        // A bare "yes"/"no" answers an outstanding risky-write confirmation
        // rather than starting a new turn. Falls through when nothing pends.
        if let Some(reply) = confirm_reply(&text)
            && self
                .resolve_pending_confirmation(&pool, user_id, &phone, &dedup_id, reply)
                .await?
                .is_some()
        {
            return Ok(());
        }

        let (last_transaction, goals, recurring, memory_rows, recent_turns) = tokio::try_join!(
            last_transaction(&pool, user_id),
            list_goals(&pool, user_id),
            list_recurring(&pool, user_id),
            list_memories(&pool, user_id, 50),
            recent_turns(&pool, user_id, 12),
        )?;
        let memories = memory_rows
            .into_iter()
            .map(|row| row.content)
            .collect::<Vec<_>>();
        let today = self.clock.local_date(Utc::now());
        // In serverless lazy mode `state.openrouter` is None even when the key
        // is configured, so resolve a client from env. Without this the agent
        // always returns ModelUnavailable in production.
        let local_openrouter = match self.state.openrouter.clone() {
            Some(client) => Some(client),
            None => openrouter_from_env(self.env)?,
        };
        let reader = PgFinanceRead::new(pool.clone());
        let agent = run_agent(RunAgentInput {
            text: &text,
            user_id,
            timezone: &self.clock.label,
            today,
            model: local_openrouter.as_ref(),
            reader: Some(&reader),
            snapshot: AgentSnapshot {
                last_transaction,
                goals,
                recurring,
                memories,
                recent_turns,
            },
        })
        .await;

        let (reply, writes) = match agent {
            Ok(output) => (output.reply, output.writes),
            Err(err) => {
                let sendblue = self.sendblue();
                if let Err(send_err) = sendblue
                    .send_message(&phone, failure_reply(&err.to_string()))
                    .await
                {
                    error!(event = "sendblue.failure_reply.error", error = %send_err);
                }
                return Ok(());
            }
        };

        let reply = append_budget_reaction(&pool, &self.clock, user_id, &reply, &writes).await?;
        let outbound_dedup_key = format!("inbound-reply:{dedup_id}");
        let settings = PolicySettings::from_threshold(self.env.confirm_amount_threshold_centavos);
        let sendblue = self.sendblue();

        // Deterministic safety gate between model output and the ledger.
        match classify_writes(&text, &writes, settings) {
            WriteRisk::Safe => {
                commit_and_reply(
                    &pool,
                    &sendblue,
                    &dedup_id,
                    &outbound_dedup_key,
                    user_id,
                    &phone,
                    reply,
                    writes,
                )
                .await?;
            }
            WriteRisk::NeedsConfirmation { reason, summary } => {
                // Park the ledger writes; persist only the conversation turns
                // and a confirmation request. Nothing risky is committed yet.
                let (ledger, mut turns): (Vec<_>, Vec<_>) =
                    writes.into_iter().partition(|w| !is_conversation_turn(w));
                let expires_at = Utc::now() + chrono::Duration::minutes(CONFIRM_TTL_MINUTES);
                save_pending_confirmation(
                    &pool,
                    user_id,
                    &phone,
                    message_id.as_deref(),
                    &summary,
                    &ledger,
                    expires_at,
                )
                .await?;
                let ask =
                    format!("before i do that — {reason}. confirm? ({summary}). reply yes or no.");
                // The user receives `ask`, not the model's original reply, so
                // record `ask` as the assistant turn — otherwise recent_turns
                // would feed the model a false "done"-style history.
                rewrite_assistant_turn(&mut turns, &ask);
                let mut confirm_writes = turns;
                confirm_writes.push(WriteIntent::OutboundReply {
                    user_id,
                    phone: phone.clone(),
                    content: ask,
                    dedup_key: Some(outbound_dedup_key.clone()),
                });
                commit_and_reply_writes(
                    &pool,
                    &sendblue,
                    &dedup_id,
                    &outbound_dedup_key,
                    confirm_writes,
                )
                .await?;
            }
            WriteRisk::Reject { reason } => {
                // Drop the risky writes; keep the turns and tell the user.
                let (_, mut turns): (Vec<_>, Vec<_>) =
                    writes.into_iter().partition(|w| !is_conversation_turn(w));
                let rejection = format!("i can't do that — {reason}.");
                // Record what was actually sent, not the model's pre-policy
                // reply, so the next turn's history isn't misleading.
                rewrite_assistant_turn(&mut turns, &rejection);
                let mut reject_writes = turns;
                reject_writes.push(WriteIntent::OutboundReply {
                    user_id,
                    phone: phone.clone(),
                    content: rejection,
                    dedup_key: Some(outbound_dedup_key.clone()),
                });
                commit_and_reply_writes(
                    &pool,
                    &sendblue,
                    &dedup_id,
                    &outbound_dedup_key,
                    reject_writes,
                )
                .await?;
            }
        }
        Ok(())
    }

    /// Apply a "yes"/"no" answer to the latest pending confirmation. `Some(())`
    /// means handled (stop); `None` means nothing pended (treat normally).
    async fn resolve_pending_confirmation(
        &self,
        pool: &PgPool,
        user_id: Uuid,
        phone: &str,
        dedup_id: &str,
        reply: ConfirmReply,
    ) -> Result<Option<()>, anyhow::Error> {
        let Some(pending) = latest_pending_confirmation(pool, user_id, Utc::now()).await? else {
            return Ok(None);
        };
        let sendblue = self.sendblue();
        let outbound_dedup_key = format!("inbound-reply:{dedup_id}");
        match reply {
            ConfirmReply::No => {
                cancel_pending_confirmations(pool, user_id).await?;
                let writes = vec![WriteIntent::OutboundReply {
                    user_id,
                    phone: phone.to_string(),
                    content: "okay, cancelled — nothing changed.".to_string(),
                    dedup_key: Some(outbound_dedup_key.clone()),
                }];
                commit_and_reply_writes(pool, &sendblue, dedup_id, &outbound_dedup_key, writes)
                    .await?;
            }
            ConfirmReply::Yes => {
                // Consume + apply atomically: ConsumeConfirmation runs first
                // inside flush_writes, and if the row is no longer pending
                // (double "yes" or superseded retry) the whole flush rolls back
                // so the parked writes never apply twice — and they only apply
                // if the consume itself commits.
                let mut writes = vec![WriteIntent::ConsumeConfirmation {
                    user_id,
                    id: pending.id,
                }];
                writes.extend(pending.writes);
                writes.push(WriteIntent::OutboundReply {
                    user_id,
                    phone: phone.to_string(),
                    content: format!("done — {}.", pending.summary),
                    dedup_key: Some(outbound_dedup_key.clone()),
                });
                commit_and_reply_writes(pool, &sendblue, dedup_id, &outbound_dedup_key, writes)
                    .await?;
            }
        }
        Ok(Some(()))
    }
}

#[must_use]
fn is_conversation_turn(intent: &WriteIntent) -> bool {
    matches!(intent, WriteIntent::SaveTurn { .. })
}

/// Overwrite the assistant `SaveTurn`'s content with the message actually sent.
/// The agent buffers a turn for its original reply, but on confirm/reject the
/// user receives different text; recording `sent` keeps `recent_turns` honest
/// for the next model turn.
fn rewrite_assistant_turn(turns: &mut [WriteIntent], sent: &str) {
    for intent in turns.iter_mut() {
        if let WriteIntent::SaveTurn {
            role: andy_db::writes::MessageRole::Assistant,
            content,
            ..
        } = intent
        {
            *content = sent.to_string();
        }
    }
}

/// Commit a turn's writes (ledger + turns), append the outbound reply, and
/// deliver it — the Safe path.
#[allow(clippy::too_many_arguments)]
async fn commit_and_reply(
    pool: &PgPool,
    sendblue: &SendblueClient,
    dedup_id: &str,
    outbound_dedup_key: &str,
    user_id: Uuid,
    phone: &str,
    reply: String,
    mut writes: Vec<WriteIntent>,
) -> Result<(), anyhow::Error> {
    writes.push(WriteIntent::OutboundReply {
        user_id,
        phone: phone.to_string(),
        content: reply,
        dedup_key: Some(outbound_dedup_key.to_string()),
    });
    commit_and_reply_writes(pool, sendblue, dedup_id, outbound_dedup_key, writes).await
}

/// Flush a prepared write set (which already includes its OutboundReply) under
/// the dedup/supersession guard, then deliver the queued reply.
async fn commit_and_reply_writes(
    pool: &PgPool,
    sendblue: &SendblueClient,
    dedup_id: &str,
    outbound_dedup_key: &str,
    writes: Vec<WriteIntent>,
) -> Result<(), anyhow::Error> {
    let flushed = flush_writes(pool, Some(dedup_id), &writes).await?;
    if flushed == FlushResult::Superseded {
        return Ok(());
    }
    deliver_outbound_by_dedup_key(pool, sendblue, outbound_dedup_key).await?;
    Ok(())
}

/// Append a budget reaction line to `reply` when this turn logged expenses that
/// push a category near/over its budget.
async fn append_budget_reaction(
    pool: &PgPool,
    clock: &AppTimeConfig,
    user_id: Uuid,
    reply: &str,
    writes: &[WriteIntent],
) -> Result<String, sqlx::Error> {
    let (start, end) = clock.month_range(Utc::now());

    let mut just_logged = HashMap::new();
    for write in writes {
        if let WriteIntent::Transaction {
            kind: andy_db::writes::TxKind::Expense,
            category,
            amount_centavos,
            local_date,
            ..
        } = write
            && *local_date >= start
            && *local_date <= end
        {
            *just_logged.entry(*category).or_insert(0) += *amount_centavos;
        }
    }
    if just_logged.is_empty() {
        return Ok(reply.to_string());
    }

    let categories = just_logged.keys().copied().collect::<Vec<_>>();
    let statuses = budget_statuses_for(pool, user_id, &categories, start, end).await?;
    let shared_statuses = statuses
        .into_iter()
        .map(|status| andy_shared::budget::BudgetSnapshot {
            category: status.category,
            limit: status.limit,
            spent: status.spent
                + just_logged
                    .get(&status.category)
                    .copied()
                    .unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    let lines = budget_reaction_lines(&shared_statuses, &just_logged);
    if lines.is_empty() {
        Ok(reply.to_string())
    } else {
        Ok(format!("{reply}\n\n{}", lines.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use andy_db::writes::MessageRole;
    use uuid::Uuid;

    #[test]
    fn rewrite_assistant_turn_replaces_only_assistant_content() {
        let uid = Uuid::nil();
        let mut turns = vec![
            WriteIntent::SaveTurn {
                user_id: uid,
                role: MessageRole::User,
                content: "delete that".into(),
            },
            WriteIntent::SaveTurn {
                user_id: uid,
                role: MessageRole::Assistant,
                content: "deleted it".into(), // model's pre-policy reply
            },
        ];
        rewrite_assistant_turn(
            &mut turns,
            "before i do that — this removes saved data. confirm?",
        );

        match &turns[0] {
            WriteIntent::SaveTurn { role, content, .. } => {
                assert_eq!(*role, MessageRole::User);
                assert_eq!(content, "delete that", "user turn is untouched");
            }
            _ => panic!("expected user turn"),
        }
        match &turns[1] {
            WriteIntent::SaveTurn { role, content, .. } => {
                assert_eq!(*role, MessageRole::Assistant);
                assert!(
                    content.contains("confirm?"),
                    "assistant turn records what was sent"
                );
            }
            _ => panic!("expected assistant turn"),
        }
    }
}
