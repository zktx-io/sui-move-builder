#[derive(Debug)]
pub(crate) struct HelperError {
    message: String,
    code: Option<&'static str>,
}

impl HelperError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    pub(crate) fn with_code(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
        }
    }
}

impl std::fmt::Display for HelperError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<String> for HelperError {
    fn from(message: String) -> Self {
        if message.contains("unsupported source form") {
            return Self::with_code("unsupported_dependency_source", message);
        }
        Self::new(message)
    }
}

pub(crate) fn error_response(error: String, code: Option<&'static str>) -> String {
    let mut response = serde_json::json!({
        "status": "error",
        "error": error,
    });
    if let Some(code) = code {
        response["code"] = serde_json::json!(code);
    }
    response.to_string()
}

pub(crate) fn error(error: impl Into<String>) -> String {
    error_response(error.into(), None)
}

pub(crate) fn error_with_code(code: &'static str, error: impl Into<String>) -> String {
    error_response(error.into(), Some(code))
}

pub(crate) fn error_from_helper(error: HelperError) -> String {
    error_response(error.message, error.code)
}
