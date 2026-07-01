use andy_ai::{OpenRouterClient, openrouter_from_env};
use andy_db::{RateDecision, check_and_increment, connect_pool};
use andy_shared::{
    env::Env,
    security::{constant_time_equal, sha256_hex, token_matches_hash},
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
use tracing::{error, warn};

use crate::{
    cron::{DailyCheckResult, run_daily_checks},
    inbound::{InboundOutcome, parse_inbound},
    outbound::SendblueClient,
};

const MAX_BODY_BYTES: usize = 16_384;

#[derive(Clone)]
pub struct AppState {
    pub env: Option<Env>,
    pub pool: Option<PgPool>,
    pub sendblue: Option<SendblueClient>,
    pub openrouter: Option<OpenRouterClient>,
}

impl AppState {
    #[must_use]
    pub fn test() -> Self {
        Self {
            env: None,
            pool: None,
            sendblue: None,
            openrouter: None,
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
        })
    }

    #[must_use]
    pub fn production_lazy() -> Self {
        Self::test()
    }

    /// Resolve the process [`Env`], preferring a state-carried one and falling
    /// back to `Env::from_process` (serverless lazy mode). Single place that
    /// defines the lazy-env contract.
    pub fn resolve_env(&self) -> Result<Env, anyhow::Error> {
        match self.env.clone() {
            Some(env) => Ok(env),
            None => Ok(Env::from_process()?),
        }
    }

    /// Resolve a DB pool, preferring a state-carried one and connecting lazily
    /// from `env` otherwise. Callers should resolve ONCE per request and reuse
    /// the returned pool so a single invocation holds at most one connection.
    pub async fn resolve_pool(&self, env: &Env) -> Result<PgPool, anyhow::Error> {
        match self.pool.clone() {
            Some(pool) => Ok(pool),
            None => Ok(connect_pool(&env.database_url).await?),
        }
    }

    /// Resolve a Sendblue client, preferring a state-carried one.
    #[must_use]
    pub fn resolve_sendblue(&self, env: &Env) -> SendblueClient {
        self.sendblue
            .clone()
            .unwrap_or_else(|| SendblueClient::from_env(env))
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/webhooks/sendblue", post(sendblue_webhook))
        .route("/api/cron/daily", get(daily_cron))
        .layer(tower_http::trace::TraceLayer::new_for_http())
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
    let env = match state.resolve_env() {
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

    let env = match state.resolve_env() {
        Ok(env) => env,
        Err(err) => {
            error!(event = "webhook.env.error", error = %err);
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

    let raw = to_bytes(body, MAX_BODY_BYTES + 1).await.map_err(|err| {
        warn!(event = "webhook.body.read_error", error = %err);
        StatusCode::BAD_REQUEST
    })?;
    if raw.len() > MAX_BODY_BYTES {
        return Ok(json_status(
            StatusCode::PAYLOAD_TOO_LARGE,
            OkResponse { ok: false },
        ));
    }

    let msg = match parse_inbound(&raw) {
        InboundOutcome::Actionable(msg) => msg,
        // Well-formed but non-actionable (status callback, outbound echo,
        // blank): acknowledge with 200 so the provider does not retry or
        // disable the endpoint. 401 is reserved strictly for auth failures.
        InboundOutcome::Ignore => {
            return Ok(json_status(StatusCode::OK, OkResponse { ok: true }));
        }
        // Genuinely unparseable body: this is a client error, not auth.
        InboundOutcome::Malformed => {
            warn!(event = "webhook.body.malformed");
            return Ok(json_status(
                StatusCode::BAD_REQUEST,
                OkResponse { ok: false },
            ));
        }
    };

    // Resolve the pool ONCE for this request; the rate-limit check and the
    // message service share it, so a single invocation holds one connection.
    let pool = match state.resolve_pool(&env).await {
        Ok(pool) => pool,
        Err(err) => {
            error!(event = "webhook.pool.error", error = %err);
            return Ok(json_status(
                StatusCode::SERVICE_UNAVAILABLE,
                OkResponse { ok: false },
            ));
        }
    };

    // Durable, cross-instance rate limit keyed on a hash of token+phone (no raw
    // secret/PII stored). Fail closed: if the check errors we return 503 rather
    // than let unknown traffic reach the model.
    match durable_rate_ok(&pool, &env, token.as_deref(), &msg.phone).await {
        Ok(true) => {}
        Ok(false) => {
            return Ok(json_status(
                StatusCode::TOO_MANY_REQUESTS,
                OkResponse { ok: false },
            ));
        }
        Err(err) => {
            error!(event = "webhook.ratelimit.error", error = %err);
            return Ok(json_status(
                StatusCode::SERVICE_UNAVAILABLE,
                OkResponse { ok: false },
            ));
        }
    }

    crate::service::InboundMessageService::new(&state, &env, pool)
        .handle(msg.phone, msg.text, msg.message_id)
        .await
        .map_err(|err| {
            error!(event = "webhook.handle.error", error = %err);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    Ok(json_status(StatusCode::OK, OkResponse { ok: true }))
}

const DEFAULT_INBOUND_RATE_LIMIT: i64 = 60;
const DEFAULT_INBOUND_RATE_WINDOW_SECONDS: i64 = 60;

/// Durable rate-limit gate. Increments the fixed-window counter for
/// `sha256(token|phone)` on the caller-provided pool and returns whether the
/// request is under the configured limit. Errors propagate so the caller can
/// fail closed.
async fn durable_rate_ok(
    pool: &PgPool,
    env: &Env,
    token: Option<&str>,
    phone: &str,
) -> Result<bool, anyhow::Error> {
    let limit = env.inbound_rate_limit.unwrap_or(DEFAULT_INBOUND_RATE_LIMIT);
    let window = env
        .inbound_rate_window_seconds
        .unwrap_or(DEFAULT_INBOUND_RATE_WINDOW_SECONDS);
    let key_hash = sha256_hex(&format!("{}|{}", token.unwrap_or_default(), phone));
    let decision = check_and_increment(pool, &key_hash, Utc::now(), window, limit).await?;
    Ok(decision == RateDecision::Allow)
}

async fn daily_cron(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let env = match state.resolve_env() {
        Ok(env) => env,
        Err(err) => {
            error!(event = "cron.env.error", error = %err);
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
    let pool = match state.resolve_pool(&env).await {
        Ok(pool) => pool,
        Err(err) => {
            error!(event = "cron.pool.error", error = %err);
            return Ok(json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                OkResponse { ok: false },
            ));
        }
    };
    let sendblue = state.resolve_sendblue(&env);
    let result = run_daily_checks(&pool, &sendblue, &env.allowed_phone, Utc::now())
        .await
        .map_err(|err| {
            error!(event = "cron.run.error", error = %err);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    Ok(json_status(
        StatusCode::OK,
        CronOkResponse { ok: true, result },
    ))
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

    #[test]
    fn resolve_env_prefers_state_carried_env() {
        // The single-resolution contract: when state carries an env, resolve_env
        // returns it without touching process env. The webhook path resolves env
        // and pool once and shares the pool with both the rate-limit check and
        // the message service, so one invocation holds one connection.
        let mut state = AppState::test();
        state.env = Some(env());
        let resolved = state.resolve_env().expect("state env");
        assert_eq!(resolved.allowed_phone, "+639171234567");
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
        // A correct hashed token passes the gate; a well-formed non-actionable
        // body ({}) is then acknowledged with 200 (ack-and-ignore), never 401.
        let mut state = AppState::test();
        let mut e = env();
        e.webhook_url_token = String::new();
        e.webhook_url_token_sha256 = Some(andy_shared::security::sha256_hex("token"));
        state.env = Some(e);
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/webhooks/sendblue?t=token")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn webhook_acks_status_callback_with_200() {
        // An authenticated SENT/DELIVERED status callback is a legitimate event,
        // not an auth failure: ack it with 200 so the provider keeps the
        // endpoint healthy.
        let mut state = AppState::test();
        state.env = Some(env());
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/webhooks/sendblue?t=token")
                    .body(Body::from(r#"{"status":"DELIVERED","number":"+1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn webhook_rejects_unparseable_body_with_400() {
        let mut state = AppState::test();
        state.env = Some(env());
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/webhooks/sendblue?t=token")
                    .body(Body::from("not json at all"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
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
