#[must_use]
pub fn failure_reply(message: &str) -> &'static str {
    let msg = message.to_ascii_lowercase();
    if msg.contains("not configured") || msg.contains("scripted backup") {
        return "i can't answer from memory yet because the model is not configured.";
    }
    if msg.contains("402")
        || msg.contains("payment required")
        || msg.contains("insufficient")
        || msg.contains("upgrade to")
        || msg.contains("out of credit")
        || msg.contains("balance")
    {
        return "i'm out of credits for now 😬 nothing's broken — ping the owner to top up and i'll be back.";
    }
    if msg.contains("rate limit")
        || msg.contains("ratelimit")
        || msg.contains("429")
        || msg.contains("too many requests")
        || msg.contains("quota")
    {
        return "too many at once 😅 give me a few seconds and resend that last one.";
    }
    "sorry, something went wrong — try again in a sec."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_failures_to_user_copy() {
        assert!(failure_reply("402 payment required").contains("out of credits"));
        assert!(failure_reply("429 rate limit").contains("too many"));
        assert!(failure_reply("model not configured").contains("not configured"));
        assert!(failure_reply("boom").contains("something went wrong"));
    }
}
