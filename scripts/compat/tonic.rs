pub enum Code { Internal, Ok, Unknown, InvalidArgument, NotFound, AlreadyExists, PermissionDenied, ResourceExhausted, FailedPrecondition, Aborted, OutOfRange, Unimplemented, Unavailable, DataLoss, Unauthenticated }
impl Code {
    pub fn description(&self) -> &str { "stub_description" }
}
pub struct Status;
impl Status {
     pub fn new(code: Code, msg: impl Into<String>) -> Self { Self }
     pub fn with_details(code: Code, msg: impl Into<String>, details: Vec<u8>) -> Self { Self }
     pub fn message(&self) -> &str { "stub_message" }
     pub fn details(&self) -> &[u8] { &[] }
     pub fn code(&self) -> Code { Code::Unknown }
}
                    