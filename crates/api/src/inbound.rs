use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundMessage {
    pub phone: String,
    pub text: String,
    pub message_id: Option<String>,
}

/// Outcome of parsing a Sendblue webhook body. Distinguishes a well-formed but
/// non-actionable event (a status callback like SENT/DELIVERED, an outbound
/// echo, or a blank message) from genuinely unparseable JSON, so the route can
/// ack-and-ignore the former (200) and reject only the latter (400) — never
/// returning 401 for a legitimate event after the token already validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundOutcome {
    /// A real inbound user message to process.
    Actionable(InboundMessage),
    /// Well-formed event that is not an actionable user message; acknowledge it.
    Ignore,
    /// Body was not valid JSON in the expected shape.
    Malformed,
}

#[derive(Debug, Deserialize)]
struct RawInbound {
    status: Option<String>,
    number: Option<String>,
    content: Option<String>,
    message_handle: Option<String>,
    is_outbound: Option<bool>,
}

pub fn parse_inbound(body: &[u8]) -> InboundOutcome {
    let Ok(raw) = serde_json::from_slice::<RawInbound>(body) else {
        return InboundOutcome::Malformed;
    };
    // Money-relevant event filter (unchanged): only inbound RECEIVED messages
    // are actionable; everything else is a benign event to acknowledge.
    if raw.is_outbound == Some(true) || raw.status.as_deref() != Some("RECEIVED") {
        return InboundOutcome::Ignore;
    }
    let (Some(phone), Some(content)) = (raw.number, raw.content) else {
        return InboundOutcome::Ignore;
    };
    let text = content.trim().to_string();
    if phone.is_empty() || text.is_empty() {
        return InboundOutcome::Ignore;
    }
    InboundOutcome::Actionable(InboundMessage {
        phone,
        text,
        message_id: raw.message_handle,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actionable(body: &[u8]) -> InboundMessage {
        match parse_inbound(body) {
            InboundOutcome::Actionable(msg) => msg,
            other => panic!("expected actionable, got {other:?}"),
        }
    }

    #[test]
    fn parses_received_sendblue_message() {
        let msg = actionable(
            br#"{"status":"RECEIVED","number":"+639171234567","content":" hi ","message_handle":"m1"}"#,
        );
        assert_eq!(msg.phone, "+639171234567");
        assert_eq!(msg.text, "hi");
        assert_eq!(msg.message_id.as_deref(), Some("m1"));
    }

    #[test]
    fn ignores_non_received_or_blank_messages() {
        // Well-formed but non-actionable events are Ignore (ack), not Malformed.
        assert_eq!(
            parse_inbound(br#"{"status":"SENT"}"#),
            InboundOutcome::Ignore
        );
        assert_eq!(
            parse_inbound(br#"{"status":"DELIVERED","number":"+1","content":"hi"}"#),
            InboundOutcome::Ignore
        );
        assert_eq!(
            parse_inbound(
                br#"{"status":"RECEIVED","is_outbound":true,"number":"+1","content":"hi"}"#
            ),
            InboundOutcome::Ignore
        );
        assert_eq!(
            parse_inbound(br#"{"status":"RECEIVED","number":"+1","content":"   "}"#),
            InboundOutcome::Ignore
        );
    }

    #[test]
    fn unparseable_body_is_malformed() {
        assert_eq!(parse_inbound(b"not json"), InboundOutcome::Malformed);
    }
}
