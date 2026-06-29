use andy_db::writes::{TxKind, WriteIntent};
use andy_shared::{
    categories::{Category, coerce_category},
    money::parse_amount,
};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    finance_tools::{
        AgentSnapshot, FinanceToolContext, execute_finance_tool, finance_tool_specs,
        save_assistant_turn, save_user_turn, snapshot_prompt, synthesize_reply,
    },
    openrouter::{ChatMessage, OpenRouterClient, OpenRouterError},
};

#[derive(Debug, Clone)]
pub struct RunAgentInput<'a> {
    pub text: &'a str,
    pub user_id: Uuid,
    pub timezone: &'a str,
    pub today: NaiveDate,
    pub model: Option<&'a OpenRouterClient>,
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
}

pub async fn run_agent(input: RunAgentInput<'_>) -> Result<RunAgentOutput, AgentError> {
    if let Some(output) = deterministic_finance_turn(&input) {
        return Ok(output);
    }

    let Some(model) = input.model else {
        return Ok(RunAgentOutput {
            reply: "i can help log expenses, income, budgets, goals, and reminders once the model is configured.".into(),
            writes: vec![save_user_turn(input.user_id, input.text), save_assistant_turn(input.user_id, "i can help log expenses, income, budgets, goals, and reminders once the model is configured.")],
        });
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
    };

    for _ in 0..4 {
        let turn = model.chat_turn(&messages, Some(&tools)).await?;
        if turn.tool_calls.is_empty() {
            let reply = turn.content.unwrap_or_else(|| synthesize_reply(&writes));
            return Ok(with_turn_writes(input, reply, writes));
        }

        messages.push(ChatMessage::assistant_tool_calls(turn.tool_calls.clone()));
        for call in &turn.tool_calls {
            let execution = execute_finance_tool(call, &tool_ctx, &mut writes);
            messages.push(ChatMessage::tool_result(&call.id, execution.content));
        }
    }

    let reply = synthesize_reply(&writes);
    Ok(with_turn_writes(input, reply, writes))
}

fn instructions(input: &RunAgentInput<'_>) -> String {
    format!(
        "You are Andy, an iMessage finance assistant. Today is {} ({}).\n\
         Use tools for finance writes. Keep replies short and natural.\n\
         Categories: Food, Transport, Bills, Shopping, Health, Entertainment, Savings/Goals, Income, Other.\n\
         Corrections like 'make that 200' should call editLast; undo/delete should call deleteLast.\n\
         Goal contributions use contributeToGoal, not a generic expense. Recurring reminders do not auto-log.\n\
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

fn deterministic_finance_turn(input: &RunAgentInput<'_>) -> Option<RunAgentOutput> {
    let amount_token = first_amount_token(input.text)?;
    let amount_centavos = parse_amount(amount_token).ok()?;
    let kind = if looks_like_income(input.text) {
        TxKind::Income
    } else {
        TxKind::Expense
    };
    let category = if kind == TxKind::Income {
        Category::Income
    } else {
        best_category(input.text)
    };
    let note = cleanup_note(input.text, amount_token);
    let reply = match kind {
        TxKind::Income => "logged income.".to_string(),
        TxKind::Expense => format!("logged {}.", category),
    };

    Some(RunAgentOutput {
        reply: reply.clone(),
        writes: vec![
            WriteIntent::Transaction {
                kind,
                user_id: input.user_id,
                amount_centavos,
                category,
                note,
                local_date: input.today,
            },
            save_user_turn(input.user_id, input.text),
            save_assistant_turn(input.user_id, reply),
        ],
    })
}

fn first_amount_token(text: &str) -> Option<&str> {
    text.split_whitespace().find(|token| {
        token.chars().any(|ch| ch.is_ascii_digit())
            && token
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | ',' | '₱'))
    })
}

fn looks_like_income(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["income", "salary", "sweldo", "paycheck", "paid me"]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn best_category(text: &str) -> Category {
    text.split(|ch: char| !ch.is_ascii_alphabetic() && ch != '/')
        .map(coerce_category)
        .find(|category| !matches!(category, Category::Other | Category::Income))
        .unwrap_or(Category::Other)
}

fn cleanup_note(text: &str, amount_token: &str) -> Option<String> {
    let note = text.replace(amount_token, "").trim().to_string();
    (!note.is_empty()).then_some(note)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn logs_common_expense_without_provider() {
        let user_id = Uuid::new_v4();
        let output = run_agent(RunAgentInput {
            text: "grab 180",
            user_id,
            timezone: "Asia/Manila",
            today: "2026-06-15".parse().unwrap(),
            model: None,
            snapshot: AgentSnapshot::default(),
        })
        .await
        .unwrap();

        assert_eq!(output.reply, "logged Transport.");
        assert!(matches!(
            output.writes[0],
            WriteIntent::Transaction {
                kind: TxKind::Expense,
                amount_centavos: 18_000,
                category: Category::Transport,
                ..
            }
        ));
    }
}
