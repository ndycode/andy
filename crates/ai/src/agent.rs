use andy_db::{FinanceRead, writes::WriteIntent};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    finance_tools::{
        AgentSnapshot, FinanceToolContext, execute_finance_tool, finance_tool_specs,
        save_assistant_turn, save_user_turn, snapshot_prompt,
    },
    openrouter::{ChatMessage, OpenRouterClient, OpenRouterError},
};

pub struct RunAgentInput<'a> {
    pub text: &'a str,
    pub user_id: Uuid,
    pub timezone: &'a str,
    pub today: NaiveDate,
    pub model: Option<&'a OpenRouterClient>,
    /// Read-only DB access for analytics tools. `None` disables read tools
    /// (they report unavailability rather than guessing).
    pub reader: Option<&'a dyn FinanceRead>,
    pub snapshot: AgentSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunAgentOutput {
    pub reply: String,
    pub writes: Vec<WriteIntent>,
}

#[derive(Debug, Error)]
pub enum AgentError {
    #[error(transparent)]
    OpenRouter(#[from] OpenRouterError),
    #[error("OPENROUTER_API_KEY is not configured; refusing to use a scripted backup answer")]
    ModelUnavailable,
    #[error("model did not produce a final user reply")]
    MissingFinalReply,
}

pub async fn run_agent(input: RunAgentInput<'_>) -> Result<RunAgentOutput, AgentError> {
    let Some(model) = input.model else {
        return Err(AgentError::ModelUnavailable);
    };

    run_tool_loop(&input, model).await
}

async fn run_tool_loop(
    input: &RunAgentInput<'_>,
    model: &OpenRouterClient,
) -> Result<RunAgentOutput, AgentError> {
    let tools = finance_tool_specs();
    let mut messages = vec![
        ChatMessage::text("system", instructions(input)),
        ChatMessage::text("user", input.text),
    ];
    let mut writes = Vec::new();
    let tool_ctx = FinanceToolContext {
        user_id: input.user_id,
        today: input.today,
        snapshot: &input.snapshot,
        reader: input.reader,
    };

    for _ in 0..4 {
        let turn = model.chat_turn(&messages, Some(&tools)).await?;
        if turn.tool_calls.is_empty() {
            let reply = turn.content.ok_or(AgentError::MissingFinalReply)?;
            return Ok(with_turn_writes(input, reply, writes));
        }

        messages.push(ChatMessage::assistant_tool_calls(turn.tool_calls.clone()));
        for call in &turn.tool_calls {
            let execution = execute_finance_tool(call, &tool_ctx, &mut writes).await;
            messages.push(ChatMessage::tool_result(&call.id, execution.content));
        }
    }

    let reply = model
        .chat_turn(&messages, None)
        .await?
        .content
        .ok_or(AgentError::MissingFinalReply)?;
    Ok(with_turn_writes(input, reply, writes))
}

fn instructions(input: &RunAgentInput<'_>) -> String {
    format!(
        "You are Andy, an iMessage finance assistant. Today is {} ({}).\n\
         Use tools for finance writes. Keep replies short and natural.\n\
         Categories: Food, Transport, Bills, Shopping, Health, Entertainment, Savings/Goals, Income, Other.\n\
         Corrections like 'make that 200' should call editLast; undo/delete should call deleteLast.\n\
         Goal contributions use contributeToGoal, not a generic expense. Recurring reminders do not auto-log.\n\
         Use remember only for durable facts or preferences, never for ordinary transactions or one-off chat.\n\
         Use listMemory before answering what you remember. Never invent memories; use only the server snapshot and tool results.\n\
         For questions about money — 'how much did I spend on food this month?', 'what was my biggest expense?',\n\
         'what are my budgets?', 'show recent grab expenses', 'am I okay this month?' — call a read tool\n\
         (getMonthOverview, getCategorySpend, searchTransactions, listBudgets, listGoals, listRecurring) and answer\n\
         from its result. Never guess numbers. When you give an analytics answer, state the period and total, the\n\
         count when the tool returns one, and the largest relevant item when available\n\
         (e.g. \"You spent ₱4,820.00 on Food this month across 12 entries. Biggest was lunch ₱780.00 on Jun 12.\").\n\
         Server snapshot:\n{}",
        input.today,
        input.timezone,
        snapshot_prompt(&input.snapshot)
    )
}

fn with_turn_writes(
    input: &RunAgentInput<'_>,
    reply: String,
    mut writes: Vec<WriteIntent>,
) -> RunAgentOutput {
    writes.push(save_user_turn(input.user_id, input.text));
    writes.push(save_assistant_turn(input.user_id, reply.clone()));
    RunAgentOutput { reply, writes }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refuses_scripted_backup_without_provider() {
        let user_id = Uuid::new_v4();
        let err = run_agent(RunAgentInput {
            text: "grab 180",
            user_id,
            timezone: "Asia/Manila",
            today: "2026-06-15".parse().unwrap(),
            model: None,
            reader: None,
            snapshot: AgentSnapshot::default(),
        })
        .await
        .unwrap_err();

        assert!(matches!(err, AgentError::ModelUnavailable));
    }
}
