output "project_id" {
  description = "Project selected for model development."
  value       = local.project_id
}

output "region" {
  description = "Regional tuning/storage location; the selected model's serving location may differ."
  value       = var.region
}

output "staging_bucket" {
  description = "Private dataset and model artifact bucket."
  value       = "gs://${google_storage_bucket.artifacts.name}"
}

output "runtime_service_account" {
  description = "Attach to inference workloads or impersonate through approved IAM bindings."
  value       = google_service_account.runtime.email
}

output "tuning_service_account" {
  description = "Attach to tuning orchestration or impersonate through approved IAM bindings."
  value       = google_service_account.tuning.email
}

output "vertex_service_agent" {
  description = "Standard Google-managed Vertex AI service agent. Managed tuning may create additional specialized identities."
  value       = google_project_service_identity.vertex.email
}

output "artifact_repository" {
  description = "Regional Docker image prefix."
  value       = "${var.region}-docker.pkg.dev/${local.project_id}/${google_artifact_registry_repository.code_models.repository_id}"
}

output "environment" {
  description = "Non-secret environment values for the model-development tools."
  value = {
    GOOGLE_CLOUD_PROJECT      = local.project_id
    GOOGLE_CLOUD_REGION       = var.region
    GOOGLE_GENAI_USE_VERTEXAI = "true"
    VERTEX_AI_STAGING_BUCKET  = "gs://${google_storage_bucket.artifacts.name}"
  }
}
