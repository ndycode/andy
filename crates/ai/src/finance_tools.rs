use andy_db::{
    ConversationTurn, FinanceRead, GoalRow, RecurringRow, TransactionRow, TransactionSearch,
    writes::{Cadence, MemoryKind, MessageRole, RecurringInput, TxKind, WriteIntent},
};
use andy_shared::{
    categories::{Category, coerce_category},
    date_validation::{DateResult, validate_calendar_date},
    expense_category::coerce_expense_category,
    money::{format_php, parse_amount},
    time::{month_bounds, month_bounds_from_str},
};
use chrono::{Datelike, NaiveDate};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::openrouter::{ToolCall, ToolFunctionSpec, ToolSpec};

/// Max transactions a read tool will return to the model. Keeps tool output
/// compact and bounds prompt growth.
const READ_RESULT_CAP: i64 = 20;
/// Max characters of a note echoed back through a read tool. Notes are
/// user-authored free text; clip them so nothing oversized reaches the model.
const READ_NOTE_CAP: usize = 80;

#[derive(Debug, Clone, Default)]
pub struct AgentSnapshot {
    pub last_transaction: Option<TransactionRow>,
    pub goals: Vec<GoalRow>,
    pub recurring: Vec<RecurringRow>,
    pub memories: Vec<String>,
    pub recent_turns: Vec<ConversationTurn>,
}

pub struct FinanceToolContext<'a> {
    pub user_id: Uuid,
    pub today: NaiveDate,
    pub snapshot: &'a AgentSnapshot,
    /// Optional read-only DB access. When `None` (e.g. unit tests without a
    /// pool), read tools answer from the snapshot or report unavailability —
    /// they never fabricate numbers.
    pub reader: Option<&'a dyn FinanceRead>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolExecution {
    pub content: String,
}

/// The finance tools Andy can call, parsed once from the model's tool-call
/// name. This is the single source of truth for the tool name set and the
/// read-vs-write classification, so the spec catalog, dispatch, and routing
/// can never silently drift: a spec with no dispatch arm is a compile error,
/// and a misclassified tool is caught by the enum's exhaustive `is_read`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tool {
    LogExpense,
    LogIncome,
    LogTransfer,
    EditLast,
    DeleteLast,
    SetBudget,
    RemoveBudget,
    Remember,
    ForgetMemory,
    ListMemory,
    CreateGoal,
    ContributeToGoal,
    EditGoal,
    DeleteGoal,
    AddRecurringBill,
    EditRecurringBill,
    RemoveRecurringBill,
    GetMonthOverview,
    GetCategorySpend,
    SearchTransactions,
    ListBudgets,
    ListGoals,
    ListRecurring,
    SearchTransfers,
}

impl Tool {
    /// Parse a model-supplied tool name. `None` for an unrecognized name (the
    /// caller reports it as unsupported rather than guessing).
    fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "logExpense" => Self::LogExpense,
            "logIncome" => Self::LogIncome,
            "logTransfer" => Self::LogTransfer,
            "editLast" => Self::EditLast,
            "deleteLast" => Self::DeleteLast,
            "setBudget" => Self::SetBudget,
            "removeBudget" => Self::RemoveBudget,
            "remember" => Self::Remember,
            "forgetMemory" => Self::ForgetMemory,
            "listMemory" => Self::ListMemory,
            "createGoal" => Self::CreateGoal,
            "contributeToGoal" => Self::ContributeToGoal,
            "editGoal" => Self::EditGoal,
            "deleteGoal" => Self::DeleteGoal,
            "addRecurringBill" => Self::AddRecurringBill,
            "editRecurringBill" => Self::EditRecurringBill,
            "removeRecurringBill" => Self::RemoveRecurringBill,
            "getMonthOverview" => Self::GetMonthOverview,
            "getCategorySpend" => Self::GetCategorySpend,
            "searchTransactions" => Self::SearchTransactions,
            "listBudgets" => Self::ListBudgets,
            "listGoals" => Self::ListGoals,
            "listRecurring" => Self::ListRecurring,
            "searchTransfers" => Self::SearchTransfers,
            _ => return None,
        })
    }

    /// Read tools are async and never touch `writes`; everything else buffers
    /// writes synchronously. `listMemory` is intentionally NOT a read tool: it
    /// answers from the in-memory snapshot via the write path but never mutates
    /// the ledger. Keeping this exhaustive makes a new tool's classification a
    /// deliberate choice rather than an accidental default.
    const fn is_read(self) -> bool {
        match self {
            Self::GetMonthOverview
            | Self::GetCategorySpend
            | Self::SearchTransactions
            | Self::ListBudgets
            | Self::ListGoals
            | Self::ListRecurring
            | Self::SearchTransfers => true,
            Self::LogExpense
            | Self::LogIncome
            | Self::LogTransfer
            | Self::EditLast
            | Self::DeleteLast
            | Self::SetBudget
            | Self::RemoveBudget
            | Self::Remember
            | Self::ForgetMemory
            | Self::ListMemory
            | Self::CreateGoal
            | Self::ContributeToGoal
            | Self::EditGoal
            | Self::DeleteGoal
            | Self::AddRecurringBill
            | Self::EditRecurringBill
            | Self::RemoveRecurringBill => false,
        }
    }
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
                (
                    "account",
                    optional_string("Account/wallet it came from, e.g. BPI, GCash, cash."),
                ),
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
                (
                    "account",
                    optional_string("Account/wallet it landed in, e.g. BPI, GCash, cash."),
                ),
            ]),
        ),
        tool(
            "logTransfer",
            "Record moving money between the user's own accounts (cash in, move to savings, gcash to bank, paid credit card from BPI). Not income or expense.",
            object(&[
                ("amount", string("Amount moved.")),
                ("fromAccount", optional_string("Source account, e.g. BPI.")),
                (
                    "toAccount",
                    optional_string("Destination account, e.g. savings."),
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
        tool(
            "getMonthOverview",
            "Read income, expense, and net for a month. Use for \"am I okay this month?\" or net questions.",
            object(&[(
                "month",
                optional_string("YYYY-MM; omit for the current month."),
            )]),
        ),
        tool(
            "getCategorySpend",
            "Read total spent in one category for a month. Use for \"how much on food this month?\".",
            object(&[
                ("category", string("Expense category.")),
                (
                    "month",
                    optional_string("YYYY-MM; omit for the current month."),
                ),
            ]),
        ),
        tool(
            "searchTransactions",
            "Search saved transactions. Use for \"show recent grab\", \"biggest expense\", or date/amount filters.",
            object(&[
                ("text", optional_string("Note text to match.")),
                ("category", optional_string("Category filter.")),
                ("kind", optional_string("expense or income.")),
                ("startDate", optional_string("YYYY-MM-DD inclusive.")),
                ("endDate", optional_string("YYYY-MM-DD inclusive.")),
                ("minAmount", optional_string("Minimum amount.")),
                ("maxAmount", optional_string("Maximum amount.")),
                (
                    "byAmount",
                    optional_string("true to sort by amount (largest first) instead of recency."),
                ),
                ("limit", optional_i64("Max rows, capped server-side.")),
            ]),
        ),
        tool(
            "listBudgets",
            "Read this month's budgets and how much is spent against each. Use for \"what are my budgets?\".",
            object(&[]),
        ),
        tool(
            "listGoals",
            "Read current savings goals and their saved/target balances.",
            object(&[]),
        ),
        tool(
            "listRecurring",
            "Read current recurring reminders.",
            object(&[]),
        ),
        tool(
            "searchTransfers",
            "Read recent account-to-account transfers, optionally for one account. Use for \"show transfers\" or \"what moved out of BPI\".",
            object(&[
                (
                    "account",
                    optional_string("Filter to this account (either side)."),
                ),
                ("limit", optional_i64("Max rows, capped server-side.")),
            ]),
        ),
    ]
}

pub async fn execute_finance_tool(
    call: &ToolCall,
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
) -> ToolExecution {
    let Some(tool) = Tool::from_name(call.function.name.as_str()) else {
        let name = &call.function.name;
        return ToolExecution {
            content: json!({ "ok": false, "error": format!("unsupported tool {name}") })
                .to_string(),
        };
    };

    // Read tools are async and never touch `writes`; write tools are pure
    // buffering and stay synchronous. Keeping the split explicit makes it
    // impossible for a read tool to mutate the ledger.
    if tool.is_read() {
        return ToolExecution {
            content: execute_read_tool(tool, call, ctx).await.to_string(),
        };
    }
    let result = match tool {
        Tool::LogExpense => parse_and(call, |args| log_expense(ctx, writes, args)),
        Tool::LogIncome => parse_and(call, |args| log_income(ctx, writes, args)),
        Tool::LogTransfer => parse_and(call, |args| log_transfer(ctx, writes, args)),
        Tool::EditLast => parse_and(call, |args| edit_last(ctx, writes, args)),
        Tool::DeleteLast => parse_and(call, |_args: EmptyArgs| delete_last(ctx, writes)),
        Tool::SetBudget => parse_and(call, |args| set_budget(ctx, writes, args)),
        Tool::RemoveBudget => parse_and(call, |args| remove_budget(ctx, writes, args)),
        Tool::Remember => parse_and(call, |args| remember(ctx, writes, args)),
        Tool::ForgetMemory => parse_and(call, |args| forget_memory(ctx, writes, args)),
        Tool::ListMemory => Ok(json!({ "remembered": ctx.snapshot.memories })),
        Tool::CreateGoal => parse_and(call, |args| create_goal(ctx, writes, args)),
        Tool::ContributeToGoal => parse_and(call, |args| contribute_to_goal(ctx, writes, args)),
        Tool::EditGoal => parse_and(call, |args| edit_goal(ctx, writes, args)),
        Tool::DeleteGoal => parse_and(call, |args| delete_goal(ctx, writes, args)),
        Tool::AddRecurringBill => parse_and(call, |args| add_recurring(ctx, writes, args)),
        Tool::EditRecurringBill => parse_and(call, |args| edit_recurring(ctx, writes, args)),
        Tool::RemoveRecurringBill => parse_and(call, |args| remove_recurring(ctx, writes, args)),
        // Read tools are handled above via the async path and can never reach
        // this synchronous write dispatch.
        Tool::GetMonthOverview
        | Tool::GetCategorySpend
        | Tool::SearchTransactions
        | Tool::ListBudgets
        | Tool::ListGoals
        | Tool::ListRecurring
        | Tool::SearchTransfers => {
            unreachable!("read tool routed to write dispatch")
        }
    };
    ToolExecution {
        content: result
            .unwrap_or_else(|err| json!({ "ok": false, "error": err }))
            .to_string(),
    }
}

async fn execute_read_tool(tool: Tool, call: &ToolCall, ctx: &FinanceToolContext<'_>) -> Value {
    let result = match tool {
        Tool::GetMonthOverview => match parse::<MonthArgs>(call) {
            Ok(args) => get_month_overview_tool(ctx, args).await,
            Err(err) => Err(err),
        },
        Tool::GetCategorySpend => {
            match serde_json::from_str::<CategorySpendArgs>(call.function.arguments.trim()) {
                Ok(args) => get_category_spend_tool(ctx, args).await,
                Err(err) => Err(format!("invalid arguments: {err}")),
            }
        }
        Tool::SearchTransactions => match parse::<SearchArgs>(call) {
            Ok(args) => search_transactions_tool(ctx, args).await,
            Err(err) => Err(err),
        },
        Tool::ListBudgets => list_budgets_tool(ctx).await,
        Tool::ListGoals => Ok(list_goals_tool(ctx)),
        Tool::ListRecurring => Ok(list_recurring_tool(ctx)),
        Tool::SearchTransfers => match parse::<TransfersQueryArgs>(call) {
            Ok(args) => search_transfers_tool(ctx, args).await,
            Err(err) => Err(err),
        },
        // Write tools never reach the read dispatch (routed by `is_read`).
        Tool::LogExpense
        | Tool::LogIncome
        | Tool::LogTransfer
        | Tool::EditLast
        | Tool::DeleteLast
        | Tool::SetBudget
        | Tool::RemoveBudget
        | Tool::Remember
        | Tool::ForgetMemory
        | Tool::ListMemory
        | Tool::CreateGoal
        | Tool::ContributeToGoal
        | Tool::EditGoal
        | Tool::DeleteGoal
        | Tool::AddRecurringBill
        | Tool::EditRecurringBill
        | Tool::RemoveRecurringBill => {
            unreachable!("write tool routed to read dispatch")
        }
    };
    result.unwrap_or_else(|err| json!({ "ok": false, "error": err }))
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
    let recent = if snapshot.recent_turns.is_empty() {
        "recent_conversation: none".to_string()
    } else {
        format!(
            "recent_conversation: {}",
            snapshot
                .recent_turns
                .iter()
                .map(|turn| {
                    let role = match turn.role {
                        MessageRole::Assistant => "andy",
                        MessageRole::User => "user",
                    };
                    format!("{role}: {}", clipped_one_line(&turn.content, 280))
                })
                .collect::<Vec<_>>()
                .join(" | ")
        )
    };
    [last, goals, recurring, memories, recent].join("\n")
}

fn clipped_one_line(value: &str, max_chars: usize) -> String {
    let one_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut clipped = one_line.chars().take(max_chars).collect::<String>();
    if one_line.chars().count() > max_chars {
        clipped.push_str("...");
    }
    clipped
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

#[derive(Debug, Deserialize)]
struct EmptyArgs {}

#[derive(Debug, Deserialize)]
struct LogExpenseArgs {
    amount: String,
    category: String,
    note: Option<String>,
    date: Option<String>,
    account: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LogIncomeArgs {
    amount: String,
    note: Option<String>,
    date: Option<String>,
    account: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TransferArgs {
    amount: String,
    #[serde(rename = "fromAccount")]
    from_account: Option<String>,
    #[serde(rename = "toAccount")]
    to_account: Option<String>,
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

#[derive(Debug, Default, Deserialize)]
struct MonthArgs {
    month: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CategorySpendArgs {
    category: String,
    month: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct SearchArgs {
    text: Option<String>,
    category: Option<String>,
    kind: Option<String>,
    #[serde(rename = "startDate")]
    start_date: Option<String>,
    #[serde(rename = "endDate")]
    end_date: Option<String>,
    #[serde(rename = "minAmount")]
    min_amount: Option<String>,
    #[serde(rename = "maxAmount")]
    max_amount: Option<String>,
    #[serde(rename = "byAmount")]
    by_amount: Option<Value>,
    limit: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct TransfersQueryArgs {
    account: Option<String>,
    limit: Option<i64>,
}

/// Resolve a `YYYY-MM` arg (or `None` = current month) to inclusive bounds.
fn resolve_month(month: Option<&str>, today: NaiveDate) -> Result<(NaiveDate, NaiveDate), String> {
    match month {
        None => Ok(month_bounds(today)),
        Some(raw) if raw.trim().is_empty() => Ok(month_bounds(today)),
        Some(raw) => month_bounds_from_str(raw.trim())
            .ok_or_else(|| format!("month must look like YYYY-MM; got \"{raw}\"")),
    }
}

fn reader<'a>(ctx: &'a FinanceToolContext<'_>) -> Result<&'a dyn FinanceRead, String> {
    ctx.reader
        .ok_or_else(|| "saved records aren't available right now".to_string())
}

async fn get_month_overview_tool(
    ctx: &FinanceToolContext<'_>,
    args: MonthArgs,
) -> Result<Value, String> {
    let (start, end) = resolve_month(args.month.as_deref(), ctx.today)?;
    let overview = reader(ctx)?
        .month_overview(ctx.user_id, start, end)
        .await
        .map_err(|err| err.to_string())?;
    Ok(json!({
        "ok": true,
        "start": start,
        "end": end,
        "income": format_php(overview.income),
        "expense": format_php(overview.expense),
        "net": format_php(overview.net),
    }))
}

async fn get_category_spend_tool(
    ctx: &FinanceToolContext<'_>,
    args: CategorySpendArgs,
) -> Result<Value, String> {
    let (start, end) = resolve_month(args.month.as_deref(), ctx.today)?;
    let category = coerce_category(&args.category);
    let (total, count) = reader(ctx)?
        .category_spend(ctx.user_id, category, start, end)
        .await
        .map_err(|err| err.to_string())?;
    Ok(json!({
        "ok": true,
        "category": category,
        "start": start,
        "end": end,
        "total": format_php(total),
        "count": count,
    }))
}

async fn search_transactions_tool(
    ctx: &FinanceToolContext<'_>,
    args: SearchArgs,
) -> Result<Value, String> {
    let opts = TransactionSearch {
        text: args.text.filter(|t| !t.trim().is_empty()),
        category: args.category.as_deref().map(coerce_category),
        start_date: optional_calendar(args.start_date.as_deref())?,
        end_date: optional_calendar(args.end_date.as_deref())?,
        min_centavos: args.min_amount.as_deref().map(amount).transpose()?,
        max_centavos: args.max_amount.as_deref().map(amount).transpose()?,
        kind: parse_kind(args.kind.as_deref()),
        by_amount: as_bool(args.by_amount.as_ref()),
        limit: args
            .limit
            .unwrap_or(READ_RESULT_CAP)
            .clamp(1, READ_RESULT_CAP),
    };
    let rows = reader(ctx)?
        .search(ctx.user_id, &opts)
        .await
        .map_err(|err| err.to_string())?;
    let items = rows
        .iter()
        .map(|row| {
            json!({
                "kind": row.kind.to_string(),
                "amount": format_php(row.amount_centavos),
                "category": row.category,
                "note": sanitize_note(row.note.as_deref()),
                "date": row.local_date,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "ok": true, "count": items.len(), "transactions": items }))
}

async fn list_budgets_tool(ctx: &FinanceToolContext<'_>) -> Result<Value, String> {
    let (start, end) = month_bounds(ctx.today);
    let statuses = reader(ctx)?
        .budget_statuses(ctx.user_id, start, end)
        .await
        .map_err(|err| err.to_string())?;
    let items = statuses
        .iter()
        .map(|status| {
            json!({
                "category": status.category,
                "limit": format_php(status.limit),
                "spent": format_php(status.spent),
                "remaining": format_php((status.limit - status.spent).max(0)),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "ok": true, "start": start, "end": end, "budgets": items }))
}

async fn search_transfers_tool(
    ctx: &FinanceToolContext<'_>,
    args: TransfersQueryArgs,
) -> Result<Value, String> {
    let limit = args
        .limit
        .unwrap_or(READ_RESULT_CAP)
        .clamp(1, READ_RESULT_CAP);
    let account = args
        .account
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty());
    let rows = reader(ctx)?
        .transfers(ctx.user_id, account, limit)
        .await
        .map_err(|err| err.to_string())?;
    let items = rows
        .iter()
        .map(|row| {
            json!({
                "amount": format_php(row.amount_centavos),
                "from": row.from_account,
                "to": row.to_account,
                "note": sanitize_note(row.note.as_deref()),
                "date": row.local_date,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "ok": true, "count": items.len(), "transfers": items }))
}

fn list_goals_tool(ctx: &FinanceToolContext<'_>) -> Value {
    let goals = ctx
        .snapshot
        .goals
        .iter()
        .map(|goal| {
            json!({
                "name": goal.name,
                "saved": format_php(goal.saved_centavos),
                "target": format_php(goal.target_centavos),
                "targetDate": goal.target_date,
            })
        })
        .collect::<Vec<_>>();
    json!({ "ok": true, "goals": goals })
}

fn list_recurring_tool(ctx: &FinanceToolContext<'_>) -> Value {
    let items = ctx
        .snapshot
        .recurring
        .iter()
        .map(|item| {
            json!({
                "label": item.label,
                "kind": item.kind.to_string(),
                "amount": format_php(item.amount_centavos),
                "category": item.category,
                "cadence": item.cadence.to_string(),
                "dayOfMonth": item.day_of_month,
                "dayOfWeek": item.day_of_week,
            })
        })
        .collect::<Vec<_>>();
    json!({ "ok": true, "recurring": items })
}

fn sanitize_note(note: Option<&str>) -> Option<String> {
    note.map(|n| n.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(READ_NOTE_CAP).collect())
}

fn parse_kind(raw: Option<&str>) -> Option<String> {
    match raw.map(|r| r.trim().to_ascii_lowercase()).as_deref() {
        Some("income") => Some("income".to_string()),
        Some("expense") => Some("expense".to_string()),
        _ => None,
    }
}

fn as_bool(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
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
        account: clean_account(args.account),
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
        account: clean_account(args.account),
    });
    Ok(json!({ "ok": true, "logged": format_php(amount), "date": date }))
}

fn log_transfer(
    ctx: &FinanceToolContext<'_>,
    writes: &mut Vec<WriteIntent>,
    args: TransferArgs,
) -> Result<Value, String> {
    let amount = amount(&args.amount)?;
    let date = log_date(args.date.as_deref(), ctx.today)?;
    let from_account = clean_account(args.from_account);
    let to_account = clean_account(args.to_account);
    if from_account.is_none() && to_account.is_none() {
        return Ok(json!({ "ok": false, "error": "a transfer needs a from or to account" }));
    }
    writes.push(WriteIntent::Transfer {
        user_id: ctx.user_id,
        amount_centavos: amount,
        from_account: from_account.clone(),
        to_account: to_account.clone(),
        note: args.note.filter(|note| !note.trim().is_empty()),
        local_date: date,
    });
    Ok(json!({
        "ok": true,
        "transferred": format_php(amount),
        "from": from_account,
        "to": to_account,
        "date": date,
    }))
}

fn clean_account(account: Option<String>) -> Option<String> {
    account
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
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
    let kind = memory_kind(args.kind.as_deref());
    if !should_save_memory(content, kind) {
        return Ok(json!({
            "ok": false,
            "error": "memory must be a durable fact or preference, not a one-off message"
        }));
    }
    writes.push(WriteIntent::SaveMemory {
        user_id: ctx.user_id,
        content: content.to_string(),
        kind,
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

/// Parse tool-call arguments, tolerating an empty/missing body for tools whose
/// args are all optional (`T: Default`).
fn parse<T: for<'de> Deserialize<'de> + Default>(call: &ToolCall) -> Result<T, String> {
    let raw = call.function.arguments.trim();
    if raw.is_empty() || raw == "{}" {
        return Ok(T::default());
    }
    serde_json::from_str::<T>(raw).map_err(|err| format!("invalid arguments: {err}"))
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

fn should_save_memory(content: &str, kind: MemoryKind) -> bool {
    let normalized = content
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.chars().count() < 6 {
        return false;
    }
    if matches!(
        normalized.as_str(),
        "ok" | "okay" | "thanks" | "thank you" | "yes" | "no" | "done"
    ) {
        return false;
    }

    let durable_cues = [
        "payday",
        "salary",
        "sweldo",
        "prefer",
        "preference",
        "usually",
        "usual",
        "default",
        "favorite",
        "favourite",
        "address",
        "home",
        "office",
        "work",
        "birthday",
        "anniversary",
        "remind me",
        "remember that",
        "my name",
        "i like",
        "i love",
        "i hate",
    ];
    if durable_cues.iter().any(|cue| normalized.contains(cue)) {
        return true;
    }

    let one_off_cues = [
        "spent", "bought", "paid", "ordered", "logged", "log ", "grab", "taxi", "lunch", "dinner",
        "coffee",
    ];
    if normalized.chars().any(|ch| ch.is_ascii_digit())
        && one_off_cues.iter().any(|cue| normalized.contains(cue))
    {
        return false;
    }

    matches!(
        kind,
        MemoryKind::Payday | MemoryKind::Preference | MemoryKind::Person | MemoryKind::Goal
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openrouter::FunctionCall;

    fn ctx(snapshot: &AgentSnapshot) -> FinanceToolContext<'_> {
        FinanceToolContext {
            user_id: Uuid::nil(),
            today: "2026-06-15".parse().unwrap(),
            snapshot,
            reader: None,
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
    fn every_advertised_spec_maps_to_a_tool_variant() {
        // A spec advertised to the model with no Tool variant would dispatch to
        // "unsupported tool" at runtime; the exhaustive dispatch match already
        // guarantees the reverse. Lock the forward direction here.
        for spec in finance_tool_specs() {
            assert!(
                Tool::from_name(spec.function.name).is_some(),
                "advertised tool {:?} has no Tool variant",
                spec.function.name
            );
        }
    }

    #[test]
    fn unknown_tool_name_is_not_a_variant() {
        assert!(Tool::from_name("logExpense").is_some());
        assert!(Tool::from_name("notARealTool").is_none());
    }

    #[tokio::test]
    async fn log_expense_tool_buffers_transaction() {
        let snapshot = AgentSnapshot::default();
        let mut writes = Vec::new();
        let result = execute_finance_tool(
            &call("logExpense", json!({ "amount": "180", "category": "grab" })),
            &ctx(&snapshot),
            &mut writes,
        )
        .await;

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

    #[tokio::test]
    async fn edit_last_targets_same_turn_write() {
        let snapshot = AgentSnapshot::default();
        let mut writes = vec![WriteIntent::Transaction {
            kind: TxKind::Expense,
            user_id: Uuid::nil(),
            amount_centavos: 18_000,
            category: Category::Transport,
            note: None,
            local_date: "2026-06-15".parse().unwrap(),
            account: None,
        }];
        execute_finance_tool(
            &call("editLast", json!({ "amount": "200" })),
            &ctx(&snapshot),
            &mut writes,
        )
        .await;

        assert!(matches!(
            writes[1],
            WriteIntent::EditLast {
                target_same_turn: true,
                amount_centavos: Some(20_000),
                ..
            }
        ));
    }

    #[test]
    fn snapshot_prompt_includes_recent_saved_turns() {
        let snapshot = AgentSnapshot {
            recent_turns: vec![
                ConversationTurn {
                    role: MessageRole::User,
                    content: "what do you remember?".into(),
                },
                ConversationTurn {
                    role: MessageRole::Assistant,
                    content: "you prefer short answers".into(),
                },
            ],
            ..AgentSnapshot::default()
        };

        let prompt = snapshot_prompt(&snapshot);

        assert!(prompt.contains("recent_conversation: user: what do you remember?"));
        assert!(prompt.contains("andy: you prefer short answers"));
    }

    #[tokio::test]
    async fn remember_rejects_one_off_transaction_text() {
        let snapshot = AgentSnapshot::default();
        let mut writes = Vec::new();
        let result = execute_finance_tool(
            &call(
                "remember",
                json!({ "fact": "I bought coffee for 180", "kind": "fact" }),
            ),
            &ctx(&snapshot),
            &mut writes,
        )
        .await;

        assert!(result.content.contains("\"ok\":false"));
        assert!(writes.is_empty());
    }

    #[tokio::test]
    async fn remember_accepts_durable_memory_text() {
        let snapshot = AgentSnapshot::default();
        let mut writes = Vec::new();
        let result = execute_finance_tool(
            &call(
                "remember",
                json!({ "fact": "payday is every Friday", "kind": "payday" }),
            ),
            &ctx(&snapshot),
            &mut writes,
        )
        .await;

        assert!(result.content.contains("\"ok\":true"));
        assert!(matches!(
            writes[0],
            WriteIntent::SaveMemory {
                kind: MemoryKind::Payday,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn read_tool_reports_unavailable_without_reader() {
        // With no reader wired in, a read tool must say so rather than invent
        // numbers, and must never push a write.
        let snapshot = AgentSnapshot::default();
        let mut writes = Vec::new();
        let result = execute_finance_tool(
            &call("getMonthOverview", json!({})),
            &ctx(&snapshot),
            &mut writes,
        )
        .await;
        assert!(result.content.contains("\"ok\":false"));
        assert!(writes.is_empty());
    }

    #[tokio::test]
    async fn log_transfer_buffers_transfer_not_transaction() {
        let snapshot = AgentSnapshot::default();
        let mut writes = Vec::new();
        let result = execute_finance_tool(
            &call(
                "logTransfer",
                json!({ "amount": "5000", "fromAccount": "BPI", "toAccount": "savings" }),
            ),
            &ctx(&snapshot),
            &mut writes,
        )
        .await;
        assert!(result.content.contains("\"ok\":true"));
        assert!(matches!(
            writes[0],
            WriteIntent::Transfer {
                amount_centavos: 500_000,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn log_transfer_requires_an_account() {
        let snapshot = AgentSnapshot::default();
        let mut writes = Vec::new();
        let result = execute_finance_tool(
            &call("logTransfer", json!({ "amount": "5000" })),
            &ctx(&snapshot),
            &mut writes,
        )
        .await;
        assert!(result.content.contains("\"ok\":false"));
        assert!(writes.is_empty());
    }

    #[tokio::test]
    async fn log_expense_carries_account() {
        let snapshot = AgentSnapshot::default();
        let mut writes = Vec::new();
        execute_finance_tool(
            &call(
                "logExpense",
                json!({ "amount": "180", "category": "food", "account": "GCash" }),
            ),
            &ctx(&snapshot),
            &mut writes,
        )
        .await;
        assert!(matches!(
            &writes[0],
            WriteIntent::Transaction { account: Some(a), .. } if a == "GCash"
        ));
    }

    #[test]
    fn month_arg_resolves_explicit_and_default() {
        let today: NaiveDate = "2026-06-15".parse().unwrap();
        assert_eq!(
            resolve_month(Some("2026-02"), today).unwrap(),
            ("2026-02-01".parse().unwrap(), "2026-02-28".parse().unwrap())
        );
        assert_eq!(
            resolve_month(None, today).unwrap(),
            ("2026-06-01".parse().unwrap(), "2026-06-30".parse().unwrap())
        );
        assert!(resolve_month(Some("nope"), today).is_err());
    }

    #[test]
    fn search_note_sanitizer_collapses_and_clips() {
        assert_eq!(
            sanitize_note(Some("  grab   to   work ")).as_deref(),
            Some("grab to work")
        );
        let long = "x".repeat(200);
        assert_eq!(
            sanitize_note(Some(&long)).unwrap().chars().count(),
            READ_NOTE_CAP
        );
        assert_eq!(sanitize_note(Some("   ")), None);
    }

    #[test]
    fn by_amount_flag_accepts_bool_and_string() {
        assert!(as_bool(Some(&json!(true))));
        assert!(as_bool(Some(&json!("true"))));
        assert!(!as_bool(Some(&json!("no"))));
        assert!(!as_bool(None));
    }
}
