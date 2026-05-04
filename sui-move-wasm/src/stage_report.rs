use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StageReport {
    stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    package_id: Option<String>,
    environment: String,
    modes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    edge_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_edge_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    linked_node_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
}

impl StageReport {
    pub(crate) fn new(stage: impl Into<String>, environment: &str, modes: &[String]) -> Self {
        Self {
            stage: stage.into(),
            package_id: None,
            environment: environment.to_string(),
            modes: modes.to_vec(),
            node_count: None,
            edge_count: None,
            active_edge_count: None,
            linked_node_count: None,
            code: None,
        }
    }

    pub(crate) fn package_id(mut self, package_id: impl Into<String>) -> Self {
        self.package_id = Some(package_id.into());
        self
    }

    pub(crate) fn node_count(mut self, count: usize) -> Self {
        self.node_count = Some(count);
        self
    }

    pub(crate) fn edge_count(mut self, count: usize) -> Self {
        self.edge_count = Some(count);
        self
    }

    pub(crate) fn active_edge_count(mut self, count: usize) -> Self {
        self.active_edge_count = Some(count);
        self
    }

    pub(crate) fn linked_node_count(mut self, count: usize) -> Self {
        self.linked_node_count = Some(count);
        self
    }
}
