terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.0, < 8.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 7.0, < 8.0"
    }
  }
}

# Use ADC or workload identity federation. No service account key is created.
provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

resource "google_project" "development" {
  count = var.create_project ? 1 : 0

  project_id          = var.project_id
  name                = var.project_name
  folder_id           = var.folder_id
  billing_account     = var.billing_account
  auto_create_network = false
  deletion_policy     = "PREVENT"
  labels              = var.labels

  lifecycle {
    precondition {
      condition     = var.billing_account != null
      error_message = "Set billing_account when create_project is true."
    }
  }
}

locals {
  project_id = var.create_project ? google_project.development[0].project_id : var.project_id
  services = toset(concat([
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
  ], var.enable_budget ? ["billingbudgets.googleapis.com"] : []))
}

data "google_project" "development" {
  project_id = local.project_id
}

resource "google_project_service" "required" {
  for_each = local.services

  project                    = local.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

# Creating this identity explicitly avoids relying on the first Vertex API call
# to create the standard Vertex AI service agent. The explicit identity resource
# is exposed by google-beta rather than the stable provider.
resource "google_project_service_identity" "vertex" {
  provider = google-beta
  project  = local.project_id
  service  = "aiplatform.googleapis.com"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "runtime" {
  project      = local.project_id
  account_id   = "dazza-vertex-runtime"
  display_name = "Dazza Vertex inference runtime"
  description  = "Inference and optional remote MCP access. No dataset write permission."

  depends_on = [google_project_service.required]
}

resource "google_service_account" "tuning" {
  project      = local.project_id
  account_id   = "dazza-vertex-tuning"
  display_name = "Dazza model tuning pipeline"
  description  = "Tuning orchestration and dataset/artifact object management."

  depends_on = [google_project_service.required]
}

resource "google_project_iam_member" "runtime_vertex" {
  project = local.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "tuning_vertex" {
  project = local.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.tuning.email}"
}

resource "google_project_iam_member" "runtime_mcp" {
  count = var.enable_vertex_mcp_access ? 1 : 0

  project = local.project_id
  role    = "roles/mcp.toolUser"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket" "artifacts" {
  project                     = local.project_id
  name                        = var.bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = var.labels

  versioning {
    enabled = true
  }

  dynamic "lifecycle_rule" {
    for_each = var.noncurrent_version_retention_days == null ? [] : [var.noncurrent_version_retention_days]
    content {
      action {
        type = "Delete"
      }
      condition {
        days_since_noncurrent_time = lifecycle_rule.value
        num_newer_versions         = 5
        with_state                 = "ARCHIVED"
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "tuning_objects" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.tuning.email}"
}

# Keep this explicit standard Vertex AI service-agent grant bucket-scoped.
# Google-managed tuning can provision specialized service agents separately;
# their default service-agent roles must remain under Google's management.
resource "google_storage_bucket_iam_member" "vertex_dataset_reader" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_project_service_identity.vertex.email}"
}

resource "google_artifact_registry_repository" "code_models" {
  project       = local.project_id
  location      = var.region
  repository_id = var.artifact_repository_id
  description   = "Evaluation sandbox and model deployment images"
  format        = "DOCKER"
  labels        = var.labels

  depends_on = [google_project_service.required]
}

resource "google_artifact_registry_repository_iam_member" "tuning_images" {
  project    = local.project_id
  location   = google_artifact_registry_repository.code_models.location
  repository = google_artifact_registry_repository.code_models.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.tuning.email}"
}

resource "google_billing_budget" "development" {
  count = var.enable_budget ? 1 : 0

  billing_account = var.billing_account
  display_name    = "${var.project_id} monthly development alerts"

  budget_filter {
    projects               = ["projects/${data.google_project.development.number}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = var.budget_amount == null ? "0" : tostring(var.budget_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.budget_thresholds
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  lifecycle {
    precondition {
      condition     = var.billing_account != null && var.budget_amount != null
      error_message = "Set both billing_account and budget_amount before enabling a billing budget."
    }
  }

  depends_on = [google_project_service.required]
}
