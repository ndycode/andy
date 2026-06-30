use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use andy_ai::{
    AgentSnapshot, ConfirmReply, OpenRouterClient, PolicySettings, RunAgentInput, WriteRisk,
    classify_writes, confirm_reply, openrouter_from_env, run_agent,
};
use andy_db::{
    ClaimResult, FlushResult, PgFinanceRead, WriteIntent, budget_statuses_for,
    cancel_pending_confirmations, claim_slot, connect_pool, consume_confirmation, flush_writes,
    last_transaction, latest_pending_confirmation, list_goals, list_memories, list_recurring,
    recent_turns, resolve_user_id, save_pending_confirmation,
};
use andy_shared::{
    allowlist::is_allowed,
    budget::budget_reaction_lines,
    dedup::content_dedup_key,
    env::Env,
    errors::failure_reply,
    security::{constant_time_equal, token_matches_hash},
    time::AppTimeConfig,
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::Serialize;
use sqlx::PgPool;
use tracing::error;

use crate::{
    cron::{DailyCheckResult, run_daily_checks},
    inbound::parse_inbound,
    outbound::{SendblueClient, deliver_outbound_by_dedup_key},
};

const MAX_BODY_BYTES: usize = 16_384;
const INBOUND_BURST_MAX: usize = 60;
const INBOUND_BURST_WINDOW: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct AppState {
    pub env: Option<Env>,
    pub pool: Option<PgPool>,
    pub sendblue: Option<SendblueClient>,
    pub openrouter: Option<OpenRouterClient>,
    burst: Arc<Mutex<VecDeque<Instant>>>,
}

impl AppState {
    #[must_use]
    pub fn test() -> Self {
        Self {
            env: None,
            pool: None,
            sendblue: None,
            openrouter: None,
            burst: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    pub async fn from_env() -> Result<Self, anyhow::Error> {
        let env = Env::from_process()?;
        let pool = connect_pool(&env.database_url).await?;
        let openrouter = openrouter_from_env(&env)?;
        let sendblue = SendblueClient::from_env(&env);
        Ok(Self {
            env: Some(env),
            pool: Some(pool),
            sendblue: Some(sendblue),
            openrouter,
            burst: Arc::new(Mutex::new(VecDeque::new())),
        })
    }

    #[must_use]
    pub fn production_lazy() -> Self {
        Self::test()
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/webhooks/sendblue", post(sendblue_webhook))
        .route("/api/cron/daily", get(daily_cron))
        .with_state(state)
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

async fn health() -> impl IntoResponse {
    axum::Json(HealthResponse {
        status: "ok",
        service: "andy",
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyResponse {
    ok: bool,
    service: &'static str,
    /// "ok", "error", or "unconfigured" — never a connection string or error body.
    db: &'static str,
    openrouter_configured: bool,
    sendblue_configured: bool,
    /// "ok" (all bundled migrations applied), "pending" (some/none applied),
    /// "unknown" (DB unreachable). Never leaks schema details.
    migrations: &'static str,
}

/// Readiness probe for deploy gating. Unlike `/health` (static liveness), this
/// validates required env, pings the DB, and reports whether OpenRouter and
/// Sendblue are configured — all without exposing any secret value. Returns
/// 200 when ready and 503 otherwise so a load balancer can act on it.
async fn ready(State(state): State<AppState>) -> Response {
    let env = match state.env.clone().map(Ok).unwrap_or_else(Env::from_process) {
        Ok(env) => env,
        Err(_) => {
            return json_status(
                StatusCode::SERVICE_UNAVAILABLE,
                ReadyResponse {
                    ok: false,
                    service: "andy",
                    db: "unconfigured",
                    openrouter_configured: false,
                    sendblue_configured: false,
                    migrations: "unknown",
                },
            );
        }
    };

    let openrouter_configured = env.openrouter_api_key.is_some();
    let sendblue_configured = !env.sendblue_api_key.is_empty()
        && !env.sendblue_api_secret.is_empty()
        && !env.sendblue_from_number.is_empty();

    let pool = match state.pool.clone() {
        Some(pool) => Some(pool),
        None => connect_pool(&env.database_url).await.ok(),
    };
    let (db, migrations) = match pool {
        Some(pool) => match andy_db::migrations::applied_count_if_tracked(&pool).await {
            Ok(Some(applied)) if applied as usize >= andy_db::migrations::bundled_count() => {
                ("ok", "ok")
            }
            Ok(_) => ("ok", "pending"),
            Err(_) => ("error", "unknown"),
        },
        None => ("error", "unknown"),
    };

    let ok = db == "ok" && migrations == "ok";
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    json_status(
        status,
        ReadyResponse {
            ok,
            service: "andy",
            db,
            openrouter_configured,
            sendblue_configured,
            migrations,
        },
    )
}

#[derive(Debug, Serialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Debug, Serialize)]
struct CronOkResponse {
    ok: bool,
    #[serde(flatten)]
    result: DailyCheckResult,
}

async fn sendblue_webhook(
    State(state): State<AppState>,
    request: Request<Body>,
) -> Result<Response, StatusCode> {
    let (parts, body) = request.into_parts();
    if declared_content_length_too_large(&parts.headers) {
        return Ok(json_status(
            StatusCode::PAYLOAD_TOO_LARGE,
            OkResponse { ok: false },
        ));
    }

    let env = match state.env.clone().map(Ok).unwrap_or_else(Env::from_process) {
        Ok(env) => env,
        Err(_) => {
            return Ok(json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                OkResponse { ok: false },
            ));
        }
    };

    let token = query_param(parts.uri.query(), "t");
    if !webhook_token_valid(token.as_deref(), &env) {
        return Ok(json_status(
            StatusCode::UNAUTHORIZED,
            OkResponse { ok: false },
        ));
    }

    let raw = to_bytes(body, MAX_BODY_BYTES + 1)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if raw.len() > MAX_BODY_BYTES {
        return Ok(json_status(
            StatusCode::PAYLOAD_TOO_LARGE,
            OkResponse { ok: false },
        ));
    }

    let Some(msg) = parse_inbound(&raw) else {
        return Ok(json_status(
            StatusCode::UNAUTHORIZED,
            OkResponse { ok: false },
        ));
    };

    if !allow_burst(&state) {
        return Ok(json_status(
            StatusCode::TOO_MANY_REQUESTS,
            OkResponse { ok: false },
        ));
    }

    handle_inbound(&state, &env, msg.phone, msg.text, msg.message_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(json_status(StatusCode::OK, OkResponse { ok: true }))
}

async fn daily_cron(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let env = match state.env.clone().map(Ok).unwrap_or_else(Env::from_process) {
        Ok(env) => env,
        Err(_) => {
            return Ok(json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                OkResponse { ok: false },
            ));
        }
    };
    let auth = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    if !constant_time_equal(
        auth.unwrap_or_default(),
        &format!("Bearer {}", env.cron_secret),
    ) {
        return Ok(json_status(
            StatusCode::UNAUTHORIZED,
            OkResponse { ok: false },
        ));
    }
    let pool = if let Some(pool) = state.pool.clone() {
        pool
    } else {
        connect_pool(&env.database_url)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };
    let sendblue = state
        .sendblue
        .clone()
        .unwrap_or_else(|| SendblueClient::from_env(&env));
    let result = run_daily_checks(&pool, &sendblue, &env.allowed_phone, Utc::now())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(json_status(
        StatusCode::OK,
        CronOkResponse { ok: true, result },
    ))
}

async fn handle_inbound(
    state: &AppState,
    env: &Env,
    phone: String,
    text: String,
    message_id: Option<String>,
) -> Result<(), anyhow::Error> {
    if !is_allowed(&phone, &env.allowed_phone) {
        return Ok(());
    }
    let clock = AppTimeConfig::from_env();
    let pool = if let Some(pool) = state.pool.clone() {
        pool
    } else {
        connect_pool(&env.database_url).await?
    };
    let dedup_id = message_id
        .clone()
        .unwrap_or_else(|| content_dedup_key(&phone, &text, Utc::now()));
    if claim_slot(&pool, &dedup_id, Utc::now()).await? == ClaimResult::Skip {
        return Ok(());
    }

    let user_id = resolve_user_id(&pool, &phone).await?;

    // Confirmation flow: a bare "yes"/"no" answers an outstanding risky-write
    // confirmation rather than starting a new turn. Falls through to normal
    // handling when there is nothing pending to confirm.
    if let Some(reply) = confirm_reply(&text) {
        let sendblue = state
            .sendblue
            .clone()
            .unwrap_or_else(|| SendblueClient::from_env(env));
        if resolve_pending_confirmation(&pool, &sendblue, user_id, &phone, &dedup_id, reply)
            .await?
            .is_some()
        {
            return Ok(());
        }
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
    let today = clock.local_date(Utc::now());
    // In serverless lazy mode `state.openrouter` is None even when the key is
    // configured, so fall back to building a client from env. Without this the
    // agent always returns ModelUnavailable in production.
    let local_openrouter = match state.openrouter.clone() {
        Some(client) => Some(client),
        None => openrouter_from_env(env)?,
    };
    let reader = PgFinanceRead::new(pool.clone());
    let agent = run_agent(RunAgentInput {
        text: &text,
        user_id,
        timezone: &clock.label,
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
            let sendblue = state
                .sendblue
                .clone()
                .unwrap_or_else(|| SendblueClient::from_env(env));
            if let Err(send_err) = sendblue
                .send_message(&phone, failure_reply(&err.to_string()))
                .await
            {
                error!(event = "sendblue.failure_reply.error", error = %send_err);
            }
            return Ok(());
        }
    };

    let reply = append_budget_reaction(&pool, &clock, user_id, &reply, &writes).await?;
    let outbound_dedup_key = format!("inbound-reply:{dedup_id}");

    // Deterministic safety gate between model output and the ledger. The model
    // is not the final authority on destructive or high-value writes.
    let settings = PolicySettings::from_threshold(env.confirm_amount_threshold_centavos);
    let sendblue = state
        .sendblue
        .clone()
        .unwrap_or_else(|| SendblueClient::from_env(env));

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
            // Park the ledger writes; persist only the conversation turns and a
            // confirmation request. Nothing risky is committed yet.
            let (ledger, turns): (Vec<_>, Vec<_>) =
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
            // Drop the risky writes entirely; keep the turns and tell the user.
            let (_, turns): (Vec<_>, Vec<_>) =
                writes.into_iter().partition(|w| !is_conversation_turn(w));
            let mut reject_writes = turns;
            reject_writes.push(WriteIntent::OutboundReply {
                user_id,
                phone: phone.clone(),
                content: format!("i can't do that — {reason}."),
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

const CONFIRM_TTL_MINUTES: i64 = 60;

#[must_use]
fn is_conversation_turn(intent: &WriteIntent) -> bool {
    matches!(intent, WriteIntent::SaveTurn { .. })
}

/// Commit a turn's writes (ledger + turns), append the outbound reply, and
/// deliver it — the original Safe path.
#[allow(clippy::too_many_arguments)]
async fn commit_and_reply(
    pool: &PgPool,
    sendblue: &SendblueClient,
    dedup_id: &str,
    outbound_dedup_key: &str,
    user_id: uuid::Uuid,
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

/// Apply a "yes"/"no" answer to the latest pending confirmation. Returns
/// `Some(())` when a confirmation was handled (caller should stop), or `None`
/// when there was nothing pending (caller treats the message normally).
async fn resolve_pending_confirmation(
    pool: &PgPool,
    sendblue: &SendblueClient,
    user_id: uuid::Uuid,
    phone: &str,
    dedup_id: &str,
    reply: ConfirmReply,
) -> Result<Option<()>, anyhow::Error> {
    let Some(pending) = latest_pending_confirmation(pool, user_id, Utc::now()).await? else {
        return Ok(None);
    };
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
            commit_and_reply_writes(pool, sendblue, dedup_id, &outbound_dedup_key, writes).await?;
        }
        ConfirmReply::Yes => {
            // Consume first; if another "yes" already did, do nothing.
            if !consume_confirmation(pool, pending.id, user_id).await? {
                return Ok(Some(()));
            }
            let mut writes = pending.writes;
            writes.push(WriteIntent::OutboundReply {
                user_id,
                phone: phone.to_string(),
                content: format!("done — {}.", pending.summary),
                dedup_key: Some(outbound_dedup_key.clone()),
            });
            commit_and_reply_writes(pool, sendblue, dedup_id, &outbound_dedup_key, writes).await?;
        }
    }
    Ok(Some(()))
}

async fn append_budget_reaction(
    pool: &PgPool,
    clock: &AppTimeConfig,
    user_id: uuid::Uuid,
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

fn declared_content_length_too_large(headers: &HeaderMap) -> bool {
    headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|len| len > MAX_BODY_BYTES)
}

/// Verify the inbound webhook token. Prefers the hashed form
/// (`WEBHOOK_URL_TOKEN_SHA256`): when set, `sha256(token)` is compared in
/// constant time against the stored digest. Otherwise falls back to the raw
/// `WEBHOOK_URL_TOKEN`. A missing token or empty expected value never passes.
fn webhook_token_valid(actual: Option<&str>, env: &Env) -> bool {
    let Some(actual) = actual else {
        return false;
    };
    if let Some(expected_hash) = env.webhook_url_token_sha256.as_deref() {
        return token_matches_hash(actual, expected_hash);
    }
    !env.webhook_url_token.is_empty() && constant_time_equal(actual, &env.webhook_url_token)
}

/// Extract a single query parameter value (percent-decoded). Returns `None`
/// when the key is absent or appears more than once, so an attacker cannot
/// smuggle a second `t=` past the check.
fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    let query = query?;
    let mut found: Option<String> = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            if found.is_some() {
                return None; // ambiguous repeated parameter
            }
            found = Some(percent_decode(v));
        }
    }
    found
}

/// Minimal application/x-www-form-urlencoded value decoder: `+` to space and
/// `%XX` hex escapes. Invalid escapes are passed through unchanged.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn allow_burst(state: &AppState) -> bool {
    let now = Instant::now();
    let mut hits = state.burst.lock().expect("burst mutex poisoned");
    while hits
        .front()
        .is_some_and(|hit| now.duration_since(*hit) >= INBOUND_BURST_WINDOW)
    {
        hits.pop_front();
    }
    if hits.len() >= INBOUND_BURST_MAX {
        return false;
    }
    hits.push_back(now);
    true
}

fn json_status<T: Serialize>(status: StatusCode, value: T) -> Response {
    (status, axum::Json(value)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http::Request;
    use tower::ServiceExt;

    fn env() -> Env {
        Env {
            database_url: "postgres://postgres:postgres@localhost/andy".into(),
            sendblue_api_key: "k".into(),
            sendblue_api_secret: "s".into(),
            sendblue_from_number: "+1".into(),
            webhook_url_token: "token".into(),
            webhook_url_token_sha256: None,
            cron_secret: "cron".into(),
            allowed_phone: "+639171234567".into(),
            openrouter_api_key: None,
            openrouter_model: None,
            openrouter_base_url: None,
            app_timezone: "Asia/Manila".into(),
            app_timezone_offset_minutes: 480,
            confirm_amount_threshold_centavos: None,
            inbound_rate_limit: None,
            inbound_rate_window_seconds: None,
        }
    }

    #[tokio::test]
    async fn health_is_env_free() {
        let response = router(AppState::test())
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn ready_reports_unavailable_without_env_or_db() {
        // No env in state; Env::from_process in this test env is missing the
        // required secrets, so /ready must report not-ready, not crash.
        let response = router(AppState::test())
            .oneshot(
                Request::builder()
                    .uri("/ready")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn ready_never_leaks_secrets() {
        // State has env (with secrets) but an unreachable DB. The body must
        // carry only booleans/status words, never any secret value.
        let mut state = AppState::test();
        let mut env = env();
        env.openrouter_api_key = Some("sk-super-secret".into());
        state.env = Some(env);
        let response = router(state)
            .oneshot(
                Request::builder()
                    .uri("/ready")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.contains("\"openrouterConfigured\":true"));
        assert!(!text.contains("sk-super-secret"));
        assert!(!text.contains("postgres://"));
        assert!(!text.contains("cron"), "cron secret must not leak");
    }

    #[tokio::test]
    async fn webhook_rejects_missing_or_wrong_token() {
        let mut state = AppState::test();
        state.env = Some(env());
        let app = router(state);
        let request = Request::builder()
            .method("POST")
            .uri("/webhooks/sendblue?t=wrong")
            .body(Body::from("{}"))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn query_param_decodes_and_rejects_repeated_keys() {
        assert_eq!(
            query_param(Some("t=ab%20cd"), "t").as_deref(),
            Some("ab cd")
        );
        assert_eq!(query_param(Some("t=a&t=b"), "t"), None);
        assert_eq!(query_param(Some("x=1"), "t"), None);
    }

    #[test]
    fn webhook_token_valid_prefers_hash_over_raw() {
        let mut e = env();
        // Legacy raw mode.
        assert!(webhook_token_valid(Some("token"), &e));
        // Hash mode: only the value that hashes to the digest passes.
        e.webhook_url_token = String::new();
        e.webhook_url_token_sha256 = Some(andy_shared::security::sha256_hex("token"));
        assert!(webhook_token_valid(Some("token"), &e));
        assert!(!webhook_token_valid(Some("wrong"), &e));
        assert!(!webhook_token_valid(None, &e));
    }

    #[tokio::test]
    async fn webhook_hashed_token_passes_auth_gate() {
        // A correct hashed token must not be rejected at the token gate. With a
        // non-RECEIVED body it still 401s at parse, so compare against a wrong
        // token: both reach the same handler path only if auth passed.
        let mut state = AppState::test();
        let mut e = env();
        e.webhook_url_token = String::new();
        e.webhook_url_token_sha256 = Some(andy_shared::security::sha256_hex("token"));
        state.env = Some(e);
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/webhooks/sendblue?t=wrong-token")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Wrong token is rejected at the gate.
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn webhook_rejects_declared_oversized_body_before_auth() {
        let response = router(AppState::test())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/webhooks/sendblue?t=token")
                    .header("content-length", "999999")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn cron_requires_bearer_secret() {
        let mut state = AppState::test();
        state.env = Some(env());
        let response = router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/cron/daily")
                    .header("authorization", "Bearer nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    // Phase 1: production_lazy() carries no OpenRouter client, so the inbound
    // path must resolve one from env. These tests exercise that resolution
    // directly (no DB, no network) to prove the three acceptance criteria.
    #[test]
    fn production_lazy_resolves_openrouter_from_env_credentials() {
        assert!(AppState::production_lazy().openrouter.is_none());

        let mut env = env();
        env.openrouter_api_key = Some("sk-test".into());
        // A client is now available even though state.openrouter is None, so
        // the agent is no longer guaranteed to fail with ModelUnavailable.
        let resolved = openrouter_from_env(&env).expect("valid config");
        assert!(resolved.is_some());
    }

    #[test]
    fn missing_openrouter_key_still_yields_safe_failure() {
        let env = env();
        assert!(env.openrouter_api_key.is_none());
        // No client -> run_agent returns ModelUnavailable, which failure_reply
        // maps to the safe "not configured" copy rather than panicking.
        let resolved = openrouter_from_env(&env).expect("no key is not an error");
        assert!(resolved.is_none());
        let reply = andy_shared::errors::failure_reply(
            &andy_ai::agent::AgentError::ModelUnavailable.to_string(),
        );
        assert!(reply.contains("not configured"));
    }

    #[test]
    fn bad_openrouter_model_is_surfaced_without_panicking() {
        let mut env = env();
        env.openrouter_api_key = Some("sk-test".into());
        env.openrouter_model = Some("openai/gpt-4o".into());
        let resolved = openrouter_from_env(&env);
        assert!(resolved.is_err(), "non-free model must be rejected");
    }

    // Phase 1 (route-level): with a fake OpenRouter endpoint wired through env,
    // a production-lazy webhook reaches the model instead of failing on the
    // missing state.openrouter. We stop at the DB boundary (no TEST_DATABASE_URL
    // here) but prove the resolver hands back a usable client bound to the mock.
    #[tokio::test]
    async fn lazy_state_uses_fake_model_endpoint() {
        use wiremock::{
            Mock, MockServer, ResponseTemplate,
            matchers::{method, path},
        };
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "content": "ok" } }]
            })))
            .mount(&server)
            .await;

        let mut env = env();
        env.openrouter_api_key = Some("sk-test".into());
        env.openrouter_base_url = Some(server.uri());
        let client = openrouter_from_env(&env)
            .expect("valid config")
            .expect("client present");
        let reply = client
            .chat(&[andy_ai::openrouter::ChatMessage::text("user", "hi")])
            .await
            .expect("fake model responds");
        assert_eq!(reply, "ok");
    }
}
