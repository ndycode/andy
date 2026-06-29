use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundMessage {
    pub phone: String,
    pub text: String,
    pub message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawInbound {
    status: Option<String>,
    number: Option<String>,
    content: Option<String>,
    message_handle: Option<String>,
    is_outbound: Option<bool>,
}

pub fn parse_inbound(body: &[u8]) -> Option<InboundMessage> {
    let raw: RawInbound = serde_json::from_slice(body).ok()?;
    if raw.is_outbound == Some(true) || raw.status.as_deref() != Some("RECEIVED") {
        return None;
    }
    let phone = raw.number?;
    let text = raw.content?.trim().to_string();
    if phone.is_empty() || text.is_empty() {
        return None;
    }
    Some(InboundMessage {
        phone,
        text,
        message_id: raw.message_handle,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_received_sendblue_message() {
        let msg = parse_inbound(
            br#"{"status":"RECEIVED","number":"+639171234567","content":" hi ","message_handle":"m1"}"#,
        )
        .unwrap();
        assert_eq!(msg.phone, "+639171234567");
        assert_eq!(msg.text, "hi");
        assert_eq!(msg.message_id.as_deref(), Some("m1"));
    }

    #[test]
    fn ignores_non_received_or_blank_messages() {
        assert!(parse_inbound(br#"{"status":"SENT"}"#).is_none());
        assert!(parse_inbound(br#"{"status":"RECEIVED","number":"+1","content":"   "}"#).is_none());
    }
}
