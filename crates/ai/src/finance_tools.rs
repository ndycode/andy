use andy_db::{
    GoalRow, RecurringRow, TransactionRow,
    writes::{Cadence, MemoryKind, MessageRole, RecurringInput, TxKind, WriteIntent},
};
use andy_shared::{
    categories::{Category, coerce_category},
    date_validation::{DateResult, validate_calendar_date},
    expense_category::coerce_expense_category,
    money::{format_php, parse_amount},
};
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::openrouter::{ToolCall, ToolFunctionSpec, ToolSpec};

#[derive(Debug, Clone, Default)]
pub struct AgentSnapshot {
    pub last_transaction: Option<TransactionRow>,
    pub goals: Vec<GoalRow>,
    pub recurring: Vec<RecurringRow>,
    pub memories: Vec<String>,
}

#[derive(Debug)]
pub struct FinanceToolContext<'a> {
    pub user_id: Uuid,
    pub today: NaiveDate,
    pub snapshot: &'a AgentSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolExecution {
    pub content: String,
}

#[must_use]
pub fn finance_tool_specs() -> Vec<ToolSpec> {
    vec![
        tool(
            "logExpense",
            "Log one expense. Use for spending, purchases, bills, transport, food, or fees.",
            object(&[
                (
                    "amount",
                    string("Amount exactly as written, e.g. 180 or 25k."),
                ),
                ("category", string("Expense category.")),
                ("note", optional_string("Merchant or short note.")),
                ("date", optional_string("YYYY-MM-DD; omit for today.")),
            ]),
        ),
        tool(
            "logIncome",
            "Log one income/payment/salary entry.",
            object(&[
                (
                    "amount",
                    string("Amount exactly as written, e.g. 180 or 25k."),
                ),
                ("note", optional_string("Short note.")),
                ("date", optional_string("YYYY-MM-DD; omit for today.")),
            ]),
        ),
        tool(
            "editLast",
            "Edit the most recent transaction or the transaction just logged in this same turn.",
            object(&[
                ("amount", optional_string("Replacement amount.")),
                ("category", optional_string("Replacement category.")),
                (
                    "note",
                    optional_string("Replacement note. Empty string clears visible note text."),
                ),
            ]),
        ),
        tool(
            "deleteLast",
            "Delete the most recent transaction or the transaction just logged in this same turn.",
            object(&[]),
        ),
        tool(
            "setBudget",
            "Set a monthly category budget.",
            object(&[
                ("category", string("Budget category.")),
                ("monthlyLimit", string("Monthly limit amount.")),
            ]),
        ),
        tool(
            "removeBudget",
            "Remove a monthly category budget.",
            object(&[("category", string("Budget category."))]),
        ),
        tool(
            "remember",
            "Save a durable user fact or preference.",
            object(&[
                ("fact", string("Fact to remember.")),
                (
                    "kind",
                    optional_string("fact, preference, payday, goal, person, or other."),
                ),
            ]),
        ),
        tool(
            "forgetMemory",
            "Forget a saved memory matching the given text.",
            object(&[("match", string("Memory text to forget."))]),
        ),
        tool(
            "listMemory",
            "List remembered facts already provided in the prompt snapshot.",
            object(&[]),
        ),
        tool(
            "createGoal",
            "Create a savings goal.",
            object(&[
                ("name", string("Goal name.")),
                ("target", string("Target amount.")),
                (
                    "targetDate",
                    optional_string("YYYY-MM-DD deadline; omit for no deadline."),
                ),
            ]),
        ),
        tool(
            "contributeToGoal",
            "Add saved money to an existing savings goal.",
            object(&[
                ("goalName", string("Existing goal name.")),
                ("amount", string("Contribution amount.")),
                ("date", optional_string("YYYY-MM-DD; omit for today.")),
            ]),
        ),
        tool(
            "editGoal",
            "Edit an existing savings goal.",
            object(&[
                ("goalName", string("Existing goal name.")),
                ("newName", optional_string("New goal name.")),
                ("target", optional_string("New target amount.")),
                ("targetDate", optional_string("YYYY-MM-DD, none, or clear.")),
            ]),
        ),
        tool(
            "deleteGoal",
            "Delete an existing savings goal. Historical transactions stay logged.",
            object(&[("goalName", string("Existing goal name."))]),
        ),
        tool(
            "addRecurringBill",
            "Create a recurring reminder; this does not auto-log a transaction.",
            object(&[
                ("label", string("Reminder label.")),
                ("amount", string("Amount.")),
                ("category", string("Category.")),
                (
                    "kind",
                    optional_string("expense or income; defaults to expense."),
                ),
                ("cadence", string("weekly or monthly.")),
                ("dayOfMonth", optional_i64("Monthly day 1-31.")),
                ("dayOfWeek", optional_i64("Weekly day 0=Sun..6=Sat.")),
            ]),
        ),
        tool(
            "editRecurringBill",
            "Edit an existing recurring reminder.",
            object(&[
                ("label", string("Existing reminder label.")),
                ("amount", optional_string("New amount.")),
                ("category", optional_string("New category.")),
                ("cadence", optional_string("weekly or monthly.")),
                ("dayOfMonth", optional_i64("Monthly day 1-31.")),
                ("dayOfWeek", optional_i64("Weekly day 0=Sun..6=Sat.")),
            ]),
        ),
        tool(
            "removeRecurringBill",
            "Remove an existing recurring reminder.",
            object(&[("label", string("Existing reminder label."))]),
        ),
    ]
}

pub fn execute_finance_tool(
    call: &ToolCall,
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
) -> ToolExecution {
    let result = match call.function.name.as_str() {
        "logExpense" => parse_and(call, |args| log_expense(ctx, writes, args)),
        "logIncome" => parse_and(call, |args| log_income(ctx, writes, args)),
        "editLast" => parse_and(call, |args| edit_last(ctx, writes, args)),
        "deleteLast" => parse_and(call, |_args: EmptyArgs| delete_last(ctx, writes)),
        "setBudget" => parse_and(call, |args| set_budget(ctx, writes, args)),
        "removeBudget" => parse_and(call, |args| remove_budget(ctx, writes, args)),
        "remember" => parse_and(call, |args| remember(ctx, writes, args)),
        "forgetMemory" => parse_and(call, |args| forget_memory(ctx, writes, args)),
        "listMemory" => Ok(json!({ "remembered": ctx.snapshot.memories })),
        "createGoal" => parse_and(call, |args| create_goal(ctx, writes, args)),
        "contributeToGoal" => parse_and(call, |args| contribute_to_goal(ctx, writes, args)),
        "editGoal" => parse_and(call, |args| edit_goal(ctx, writes, args)),
        "deleteGoal" => parse_and(call, |args| delete_goal(ctx, writes, args)),
        "addRecurringBill" => parse_and(call, |args| add_recurring(ctx, writes, args)),
        "editRecurringBill" => parse_and(call, |args| edit_recurring(ctx, writes, args)),
        "removeRecurringBill" => parse_and(call, |args| remove_recurring(ctx, writes, args)),
        other => Ok(json!({ "ok": false, "error": format!("unsupported tool {other}") })),
    };
    ToolExecution {
        content: result
            .unwrap_or_else(|err| json!({ "ok": false, "error": err }))
            .to_string(),
    }
}

#[must_use]
pub fn snapshot_prompt(snapshot: &AgentSnapshot) -> String {
    let last = snapshot
        .last_transaction
        .as_ref()
        .map(|tx| {
            format!(
                "last_transaction: id={} kind={} amount={} category={} note={}",
                tx.id,
                tx.kind,
                format_php(tx.amount_centavos),
                tx.category,
                tx.note.as_deref().unwrap_or("")
            )
        })
        .unwrap_or_else(|| "last_transaction: none".to_string());
    let goals = if snapshot.goals.is_empty() {
        "goals: none".to_string()
    } else {
        format!(
            "goals: {}",
            snapshot
                .goals
                .iter()
                .map(|goal| format!(
                    "{} ({}/{})",
                    goal.name,
                    format_php(goal.saved_centavos),
                    format_php(goal.target_centavos)
                ))
                .collect::<Vec<_>>()
                .join("; ")
        )
    };
    let recurring = if snapshot.recurring.is_empty() {
        "recurring: none".to_string()
    } else {
        format!(
            "recurring: {}",
            snapshot
                .recurring
                .iter()
                .map(|item| format!(
                    "{} {} {} {}",
                    item.label,
                    item.kind,
                    format_php(item.amount_centavos),
                    item.cadence
                ))
                .collect::<Vec<_>>()
                .join("; ")
        )
    };
    let memories = if snapshot.memories.is_empty() {
        "memories: none".to_string()
    } else {
        format!("memories: {}", snapshot.memories.join("; "))
    };
    [last, goals, recurring, memories].join("\n")
}

#[must_use]
pub fn save_user_turn(user_id: Uuid, text: impl Into<String>) -> WriteIntent {
    WriteIntent::SaveTurn {
        user_id,
        role: MessageRole::User,
        content: text.into(),
    }
}

#[must_use]
pub fn save_assistant_turn(user_id: Uuid, content: impl Into<String>) -> WriteIntent {
    WriteIntent::SaveTurn {
        user_id,
        role: MessageRole::Assistant,
        content: content.into(),
    }
}

#[must_use]
pub fn synthesize_reply(writes: &[WriteIntent]) -> String {
    for write in writes.iter().rev() {
        match write {
            WriteIntent::Transaction {
                kind: TxKind::Income,
                amount_centavos,
                ..
            } => return format!("logged income {}.", format_php(*amount_centavos)),
            WriteIntent::Transaction {
                kind: TxKind::Expense,
                amount_centavos,
                category,
                ..
            } => return format!("logged {} in {}.", format_php(*amount_centavos), category),
            WriteIntent::GoalContribution {
                amount_centavos, ..
            } => return format!("added {} to the goal.", format_php(*amount_centavos)),
            WriteIntent::CreateGoal {
                name,
                target_centavos,
                ..
            } => return format!("created goal {name} for {}.", format_php(*target_centavos)),
            WriteIntent::SetBudget {
                category,
                monthly_limit_centavos,
                ..
            } => {
                return format!(
                    "set {category} budget to {}.",
                    format_php(*monthly_limit_centavos)
                );
            }
            WriteIntent::RemoveBudget { category, .. } => {
                return format!("removed {category} budget.");
            }
            WriteIntent::SaveMemory { .. } => return "remembered.".to_string(),
            WriteIntent::ForgetMemory { .. } => return "forgot it.".to_string(),
            WriteIntent::AddRecurring { recurring, .. } => {
                return format!("added recurring reminder {}.", recurring.label);
            }
            WriteIntent::RemoveRecurring { .. } => {
                return "removed that recurring reminder.".to_string();
            }
            WriteIntent::EditLast { .. } => return "updated the last transaction.".to_string(),
            WriteIntent::DeleteLast { .. } => return "deleted the last transaction.".to_string(),
            WriteIntent::EditGoal { .. } => return "updated that goal.".to_string(),
            WriteIntent::DeleteGoal { .. } => return "deleted that goal.".to_string(),
            WriteIntent::EditRecurring { .. } => {
                return "updated that recurring reminder.".to_string();
            }
            WriteIntent::SaveTurn { .. } => {}
        }
    }
    "done.".to_string()
}

#[derive(Debug, Deserialize)]
struct EmptyArgs {}

#[derive(Debug, Deserialize)]
struct LogExpenseArgs {
    amount: String,
    category: String,
    note: Option<String>,
    date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LogIncomeArgs {
    amount: String,
    note: Option<String>,
    date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EditLastArgs {
    amount: Option<String>,
    category: Option<String>,
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BudgetArgs {
    category: String,
    #[serde(rename = "monthlyLimit")]
    monthly_limit: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RememberArgs {
    fact: String,
    kind: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ForgetArgs {
    #[serde(alias = "match")]
    query: String,
}

#[derive(Debug, Deserialize)]
struct CreateGoalArgs {
    name: String,
    target: String,
    #[serde(rename = "targetDate")]
    target_date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ContributeGoalArgs {
    #[serde(rename = "goalName")]
    goal_name: String,
    amount: String,
    date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EditGoalArgs {
    #[serde(rename = "goalName")]
    goal_name: String,
    #[serde(rename = "newName")]
    new_name: Option<String>,
    target: Option<String>,
    #[serde(rename = "targetDate")]
    target_date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeleteGoalArgs {
    #[serde(rename = "goalName")]
    goal_name: String,
}

#[derive(Debug, Deserialize)]
struct AddRecurringArgs {
    label: String,
    amount: String,
    category: String,
    kind: Option<String>,
    cadence: String,
    #[serde(rename = "dayOfMonth")]
    day_of_month: Option<i64>,
    #[serde(rename = "dayOfWeek")]
    day_of_week: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct EditRecurringArgs {
    label: String,
    amount: Option<String>,
    category: Option<String>,
    cadence: Option<String>,
    #[serde(rename = "dayOfMonth")]
    day_of_month: Option<i64>,
    #[serde(rename = "dayOfWeek")]
    day_of_week: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RemoveRecurringArgs {
    label: String,
}

fn log_expense(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: LogExpenseArgs,
) -> Result<Value, String> {
    let amount = amount(&args.amount)?;
    let date = log_date(args.date.as_deref(), ctx.today)?;
    let category = coerce_expense_category(Some(&args.category), args.note.as_deref());
    writes.push(WriteIntent::Transaction {
        kind: TxKind::Expense,
        user_id: ctx.user_id,
        amount_centavos: amount,
        category,
        note: args.note.filter(|note| !note.trim().is_empty()),
        local_date: date,
    });
    Ok(json!({ "ok": true, "logged": format_php(amount), "category": category, "date": date }))
}

fn log_income(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: LogIncomeArgs,
) -> Result<Value, String> {
    let amount = amount(&args.amount)?;
    let date = log_date(args.date.as_deref(), ctx.today)?;
    writes.push(WriteIntent::Transaction {
        kind: TxKind::Income,
        user_id: ctx.user_id,
        amount_centavos: amount,
        category: Category::Income,
        note: args.note.filter(|note| !note.trim().is_empty()),
        local_date: date,
    });
    Ok(json!({ "ok": true, "logged": format_php(amount), "date": date }))
}

fn edit_last(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: EditLastArgs,
) -> Result<Value, String> {
    let same_turn = last_buffered_transaction(writes);
    let historical = ctx.snapshot.last_transaction.as_ref();
    let Some(target) = same_turn.or_else(|| historical.map(TransactionTarget::from)) else {
        return Ok(json!({ "ok": false, "error": "nothing to edit" }));
    };
    let amount = args.amount.as_deref().map(amount).transpose()?;
    let category = if let Some(category) = args.category.as_deref() {
        if target.goal_linked {
            return Ok(
                json!({ "ok": false, "error": "that's a goal contribution — its category stays Savings/Goals. edit the amount instead." }),
            );
        }
        if target.category == Category::Income {
            return Ok(
                json!({ "ok": false, "error": "that's income — it stays under Income. edit the amount instead." }),
            );
        }
        Some(coerce_expense_category(
            Some(category),
            args.note.as_deref().or(target.note.as_deref()),
        ))
    } else {
        None
    };
    if amount.is_none() && category.is_none() && args.note.is_none() {
        return Ok(
            json!({ "ok": false, "error": "no change specified — pass the new amount, category, or note" }),
        );
    }
    writes.push(WriteIntent::EditLast {
        user_id: ctx.user_id,
        target_id: (!target.same_turn).then_some(target.id),
        target_same_turn: target.same_turn,
        amount_centavos: amount,
        category,
        note: args.note,
    });
    Ok(json!({ "ok": true, "updated": true }))
}

fn delete_last(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
) -> Result<Value, String> {
    if last_buffered_transaction(writes).is_some() {
        writes.push(WriteIntent::DeleteLast {
            user_id: ctx.user_id,
            target_id: None,
            target_same_turn: true,
        });
        return Ok(json!({ "ok": true, "deleted": true }));
    }
    let Some(last) = ctx.snapshot.last_transaction.as_ref() else {
        return Ok(json!({ "ok": false, "error": "nothing to delete" }));
    };
    writes.push(WriteIntent::DeleteLast {
        user_id: ctx.user_id,
        target_id: Some(last.id),
        target_same_turn: false,
    });
    Ok(json!({ "ok": true, "deleted": true }))
}

fn set_budget(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: BudgetArgs,
) -> Result<Value, String> {
    let Some(monthly_limit) = args.monthly_limit.as_deref() else {
        return Ok(json!({ "ok": false, "error": "monthlyLimit is required" }));
    };
    let limit = amount(monthly_limit)?;
    let category = coerce_category(args.category);
    writes.push(WriteIntent::SetBudget {
        user_id: ctx.user_id,
        category,
        monthly_limit_centavos: limit,
    });
    Ok(json!({ "ok": true, "category": category, "monthlyLimit": format_php(limit) }))
}

fn remove_budget(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: BudgetArgs,
) -> Result<Value, String> {
    let category = coerce_category(args.category);
    writes.push(WriteIntent::RemoveBudget {
        user_id: ctx.user_id,
        category,
    });
    Ok(json!({ "ok": true, "removed": category }))
}

fn remember(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: RememberArgs,
) -> Result<Value, String> {
    let content = args.fact.trim();
    if content.is_empty() {
        return Ok(json!({ "ok": false, "error": "nothing to remember" }));
    }
    writes.push(WriteIntent::SaveMemory {
        user_id: ctx.user_id,
        content: content.to_string(),
        kind: memory_kind(args.kind.as_deref()),
    });
    Ok(json!({ "ok": true, "remembered": content }))
}

fn forget_memory(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: ForgetArgs,
) -> Result<Value, String> {
    if args.query.trim().is_empty() {
        return Ok(json!({ "ok": false, "error": "what should i forget?" }));
    }
    writes.push(WriteIntent::ForgetMemory {
        user_id: ctx.user_id,
        query: args.query,
    });
    Ok(json!({ "ok": true, "forgetting": true }))
}

fn create_goal(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: CreateGoalArgs,
) -> Result<Value, String> {
    let name = args.name.trim();
    if name.is_empty() {
        return Ok(json!({ "ok": false, "error": "what should i call this goal?" }));
    }
    let target = amount(&args.target)?;
    let target_date = optional_calendar(args.target_date.as_deref())?;
    writes.push(WriteIntent::CreateGoal {
        user_id: ctx.user_id,
        name: name.to_string(),
        target_centavos: target,
        target_date,
    });
    Ok(json!({ "ok": true, "name": name, "target": format_php(target), "targetDate": target_date }))
}

fn contribute_to_goal(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: ContributeGoalArgs,
) -> Result<Value, String> {
    let amount = amount(&args.amount)?;
    let date = log_date(args.date.as_deref(), ctx.today)?;
    let goal = find_one_goal(&ctx.snapshot.goals, &args.goal_name)?;
    writes.push(WriteIntent::GoalContribution {
        user_id: ctx.user_id,
        goal_id: goal.id,
        amount_centavos: amount,
        local_date: date,
    });
    Ok(json!({ "ok": true, "goal": goal.name, "added": format_php(amount), "date": date }))
}

fn edit_goal(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: EditGoalArgs,
) -> Result<Value, String> {
    let goal = find_one_goal(&ctx.snapshot.goals, &args.goal_name)?;
    let name = args.new_name.map(|name| name.trim().to_string());
    if name.as_deref() == Some("") {
        return Ok(json!({ "ok": false, "error": "the new name can't be empty" }));
    }
    let target = args.target.as_deref().map(amount).transpose()?;
    let target_date = match args.target_date.as_deref() {
        None => None,
        Some(raw)
            if matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "" | "none" | "clear"
            ) =>
        {
            Some(None)
        }
        Some(raw) => Some(Some(calendar(raw)?)),
    };
    if name.is_none() && target.is_none() && target_date.is_none() {
        return Ok(
            json!({ "ok": false, "error": "no change specified — pass a new name, target, or deadline" }),
        );
    }
    writes.push(WriteIntent::EditGoal {
        user_id: ctx.user_id,
        goal_id: goal.id,
        name,
        target_centavos: target,
        target_date,
    });
    Ok(json!({ "ok": true, "goal": goal.name }))
}

fn delete_goal(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: DeleteGoalArgs,
) -> Result<Value, String> {
    let goal = find_one_goal(&ctx.snapshot.goals, &args.goal_name)?;
    writes.push(WriteIntent::DeleteGoal {
        user_id: ctx.user_id,
        goal_id: goal.id,
    });
    Ok(json!({ "ok": true, "deleted": goal.name }))
}

fn add_recurring(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: AddRecurringArgs,
) -> Result<Value, String> {
    let amount = amount(&args.amount)?;
    let cadence = cadence(&args.cadence)?;
    validate_recurring_days(cadence, args.day_of_month, args.day_of_week)?;
    let kind = tx_kind(args.kind.as_deref());
    let category = if kind == TxKind::Income {
        Category::Income
    } else {
        coerce_category(args.category)
    };
    writes.push(WriteIntent::AddRecurring {
        user_id: ctx.user_id,
        recurring: RecurringInput {
            label: args.label.clone(),
            kind,
            amount_centavos: amount,
            category,
            cadence,
            day_of_month: args.day_of_month,
            day_of_week: args.day_of_week,
        },
    });
    Ok(
        json!({ "ok": true, "label": args.label, "amount": format_php(amount), "cadence": args.cadence }),
    )
}

fn edit_recurring(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: EditRecurringArgs,
) -> Result<Value, String> {
    let hit = find_one_recurring(&ctx.snapshot.recurring, &args.label)?;
    let amount = args.amount.as_deref().map(amount).transpose()?;
    let category = args.category.as_deref().map(coerce_category);
    let cadence = args.cadence.as_deref().map(cadence).transpose()?;
    if let Some(cadence) = cadence {
        validate_recurring_days(cadence, args.day_of_month, args.day_of_week)?;
    }
    if amount.is_none()
        && category.is_none()
        && cadence.is_none()
        && args.day_of_month.is_none()
        && args.day_of_week.is_none()
    {
        return Ok(
            json!({ "ok": false, "error": "no change specified — pass a new amount, category, cadence, or day" }),
        );
    }
    writes.push(WriteIntent::EditRecurring {
        user_id: ctx.user_id,
        query: hit.label.clone(),
        amount_centavos: amount,
        category,
        cadence,
        day_of_month: args.day_of_month.map(Some),
        day_of_week: args.day_of_week.map(Some),
    });
    Ok(json!({ "ok": true, "label": hit.label }))
}

fn remove_recurring(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: RemoveRecurringArgs,
) -> Result<Value, String> {
    let hit = find_one_recurring(&ctx.snapshot.recurring, &args.label)?;
    writes.push(WriteIntent::RemoveRecurring {
        user_id: ctx.user_id,
        query: hit.label.clone(),
    });
    Ok(json!({ "ok": true, "removed": hit.label }))
}

#[derive(Debug, Clone)]
struct TransactionTarget {
    id: Uuid,
    same_turn: bool,
    category: Category,
    note: Option<String>,
    goal_linked: bool,
}

impl From<&TransactionRow> for TransactionTarget {
    fn from(value: &TransactionRow) -> Self {
        Self {
            id: value.id,
            same_turn: false,
            category: value.category,
            note: value.note.clone(),
            goal_linked: value.goal_id.is_some(),
        }
    }
}

fn last_buffered_transaction(writes: &[WriteIntent]) -> Option<TransactionTarget> {
    for write in writes.iter().rev() {
        match write {
            WriteIntent::Transaction {
                kind,
                category,
                note,
                ..
            } => {
                return Some(TransactionTarget {
                    id: Uuid::nil(),
                    same_turn: true,
                    category: if *kind == TxKind::Income {
                        Category::Income
                    } else {
                        *category
                    },
                    note: note.clone(),
                    goal_linked: false,
                });
            }
            WriteIntent::GoalContribution { .. } => {
                return Some(TransactionTarget {
                    id: Uuid::nil(),
                    same_turn: true,
                    category: Category::SavingsGoals,
                    note: None,
                    goal_linked: true,
                });
            }
            WriteIntent::DeleteLast {
                target_same_turn: true,
                ..
            } => return None,
            _ => {}
        }
    }
    None
}

fn parse_and<T: for<'de> Deserialize<'de>>(
    call: &ToolCall,
    f: impl FnOnce(T) -> Result<Value, String>,
) -> Result<Value, String> {
    let args = serde_json::from_str::<T>(&call.function.arguments)
        .map_err(|err| format!("invalid arguments: {err}"))?;
    f(args)
}

fn amount(raw: &str) -> Result<i64, String> {
    parse_amount(raw).map_err(|err| err.to_string())
}

fn log_date(raw: Option<&str>, today: NaiveDate) -> Result<NaiveDate, String> {
    match raw {
        None => Ok(today),
        Some(value) if value.trim().is_empty() => Ok(today),
        Some(value) => {
            let date = calendar(value)?;
            if date > today {
                return Err("can't log a future date".to_string());
            }
            if date.year() < today.year() - 5 {
                return Err("that's too far back".to_string());
            }
            Ok(date)
        }
    }
}

fn optional_calendar(raw: Option<&str>) -> Result<Option<NaiveDate>, String> {
    match raw {
        None => Ok(None),
        Some(value) if value.trim().is_empty() => Ok(None),
        Some(value) => calendar(value).map(Some),
    }
}

fn calendar(raw: &str) -> Result<NaiveDate, String> {
    match validate_calendar_date(raw) {
        DateResult::Ok(date) => Ok(date),
        DateResult::Err(reason) => Err(reason.to_string()),
    }
}

fn memory_kind(raw: Option<&str>) -> MemoryKind {
    match raw.unwrap_or("fact").trim().to_ascii_lowercase().as_str() {
        "preference" => MemoryKind::Preference,
        "payday" => MemoryKind::Payday,
        "goal" => MemoryKind::Goal,
        "person" => MemoryKind::Person,
        "other" => MemoryKind::Other,
        _ => MemoryKind::Fact,
    }
}

fn tx_kind(raw: Option<&str>) -> TxKind {
    match raw
        .unwrap_or("expense")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "income" => TxKind::Income,
        _ => TxKind::Expense,
    }
}

fn cadence(raw: &str) -> Result<Cadence, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "weekly" => Ok(Cadence::Weekly),
        "monthly" => Ok(Cadence::Monthly),
        _ => Err("cadence must be weekly or monthly".to_string()),
    }
}

fn validate_recurring_days(
    cadence: Cadence,
    day_of_month: Option<i64>,
    day_of_week: Option<i64>,
) -> Result<(), String> {
    match cadence {
        Cadence::Monthly => match day_of_month {
            Some(1..=31) => Ok(()),
            _ => Err("a monthly reminder needs a day of month (1-31)".to_string()),
        },
        Cadence::Weekly => match day_of_week {
            Some(0..=6) => Ok(()),
            _ => Err("a weekly reminder needs a day of week (0=Sun..6=Sat)".to_string()),
        },
    }
}

fn find_one_goal<'a>(goals: &'a [GoalRow], query: &str) -> Result<&'a GoalRow, String> {
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return Err("goal name is required".to_string());
    }
    let exact = goals
        .iter()
        .filter(|goal| goal.name.eq_ignore_ascii_case(&q))
        .collect::<Vec<_>>();
    if exact.len() == 1 {
        return Ok(exact[0]);
    }
    let matches = goals
        .iter()
        .filter(|goal| goal.name.to_ascii_lowercase().contains(&q))
        .collect::<Vec<_>>();
    match matches.len() {
        1 => Ok(matches[0]),
        0 => Err(format!("no goal matching \"{query}\".")),
        _ => Err(format!(
            "which one? {} — say the exact name.",
            matches
                .iter()
                .map(|goal| format!("\"{}\"", goal.name))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn find_one_recurring<'a>(
    recurring: &'a [RecurringRow],
    query: &str,
) -> Result<&'a RecurringRow, String> {
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return Err("recurring label is required".to_string());
    }
    let exact = recurring
        .iter()
        .filter(|item| item.label.eq_ignore_ascii_case(&q))
        .collect::<Vec<_>>();
    if exact.len() == 1 {
        return Ok(exact[0]);
    }
    let matches = recurring
        .iter()
        .filter(|item| item.label.to_ascii_lowercase().contains(&q))
        .collect::<Vec<_>>();
    match matches.len() {
        1 => Ok(matches[0]),
        0 => Err(format!("no recurring reminder matching \"{query}\".")),
        _ => Err(format!(
            "which one? {} — say the exact label.",
            matches
                .iter()
                .map(|item| format!("\"{}\"", item.label))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn tool(name: &'static str, description: &'static str, parameters: Value) -> ToolSpec {
    ToolSpec {
        kind: "function",
        function: ToolFunctionSpec {
            name,
            description,
            parameters,
        },
    }
}

fn object(properties: &[(&str, Value)]) -> Value {
    let props = properties
        .iter()
        .map(|(name, schema)| ((*name).to_string(), schema.clone()))
        .collect::<serde_json::Map<_, _>>();
    let required = properties
        .iter()
        .filter(|(_, schema)| {
            !schema
                .get("optional")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .map(|(name, _)| Value::String((*name).to_string()))
        .collect::<Vec<_>>();
    let props = props
        .into_iter()
        .map(|(key, mut schema)| {
            if let Some(obj) = schema.as_object_mut() {
                obj.remove("optional");
            }
            (key, schema)
        })
        .collect::<serde_json::Map<_, _>>();
    json!({
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": false
    })
}

fn string(description: &'static str) -> Value {
    json!({ "type": "string", "description": description })
}

fn optional_string(description: &'static str) -> Value {
    json!({ "type": "string", "description": description, "optional": true })
}

fn optional_i64(description: &'static str) -> Value {
    json!({ "type": "integer", "description": description, "optional": true })
}

trait DateYear {
    fn year(self) -> i32;
}

impl DateYear for NaiveDate {
    fn year(self) -> i32 {
        chrono::Datelike::year(&self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openrouter::FunctionCall;

    fn ctx(snapshot: &AgentSnapshot) -> FinanceToolContext<'_> {
        FinanceToolContext {
            user_id: Uuid::nil(),
            today: "2026-06-15".parse().unwrap(),
            snapshot,
        }
    }

    fn call(name: &str, args: Value) -> ToolCall {
        ToolCall {
            id: "call_1".into(),
            kind: "function".into(),
            function: FunctionCall {
                name: name.into(),
                arguments: args.to_string(),
            },
        }
    }

    #[test]
    fn log_expense_tool_buffers_transaction() {
        let snapshot = AgentSnapshot::default();
        let mut writes = Vec::new();
        let result = execute_finance_tool(
            &call("logExpense", json!({ "amount": "180", "category": "grab" })),
            &ctx(&snapshot),
            &mut writes,
        );

        assert!(result.content.contains("\"ok\":true"));
        assert!(matches!(
            writes[0],
            WriteIntent::Transaction {
                kind: TxKind::Expense,
                amount_centavos: 18_000,
                category: Category::Transport,
                ..
            }
        ));
    }

    #[test]
    fn edit_last_targets_same_turn_write() {
        let snapshot = AgentSnapshot::default();
        let mut writes = vec![WriteIntent::Transaction {
            kind: TxKind::Expense,
            user_id: Uuid::nil(),
            amount_centavos: 18_000,
            category: Category::Transport,
            note: None,
            local_date: "2026-06-15".parse().unwrap(),
        }];
        execute_finance_tool(
            &call("editLast", json!({ "amount": "200" })),
            &ctx(&snapshot),
            &mut writes,
        );

        assert!(matches!(
            writes[1],
            WriteIntent::EditLast {
                target_same_turn: true,
                amount_centavos: Some(20_000),
                ..
            }
        ));
    }
}
