use serde::Serialize;

#[derive(Debug, Clone, Copy)]
pub enum Level {
    Info,
    Warn,
    Error,
}

pub fn emit<T: Serialize>(level: Level, event: &str, fields: T) {
    let level = match level {
        Level::Info => "info",
        Level::Warn => "warn",
        Level::Error => "error",
    };
    let mut value = serde_json::to_value(fields).unwrap_or_else(|err| {
        serde_json::json!({
            "serialization_error": err.to_string()
        })
    });
    if let serde_json::Value::Object(ref mut map) = value {
        map.insert("level".into(), serde_json::json!(level));
        map.insert("event".into(), serde_json::json!(event));
        map.insert(
            "t".into(),
            serde_json::json!(chrono::Utc::now().to_rfc3339()),
        );
    }
    let line = serde_json::to_string(&value)
        .unwrap_or_else(|_| format!(r#"{{"level":"{level}","event":"{event}"}}"#));
    match level {
        "error" => eprintln!("{line}"),
        _ => println!("{line}"),
    }
}
