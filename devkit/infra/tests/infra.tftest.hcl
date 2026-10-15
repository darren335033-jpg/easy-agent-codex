mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}
mock_provider "google-beta" {
  mock_resource "google_project_service_identity" {
    defaults = { email = "service-123456789012@gcp-sa-aiplatform.iam.gserviceaccount.com" }
  }
}
variables {
  project_id  = "dazza-model-dev-test"
  bucket_name = "dazza-model-dev-test-artifacts"
}
run "existing_project_private_defaults" {
  command = plan
  assert {
    condition     = length(google_project.development) == 0 && length(google_billing_budget.development) == 0
    error_message = "Existing-project mode must not create a project or a budget."
  }
  assert {
    condition     = google_storage_bucket.artifacts.uniform_bucket_level_access && google_storage_bucket.artifacts.public_access_prevention == "enforced" && !google_storage_bucket.artifacts.force_destroy
    error_message = "Dataset bucket must be private and resist destructive cleanup."
  }
  assert {
    condition     = length(google_project_iam_member.runtime_mcp) == 0
    error_message = "Remote MCP permissions require explicit opt-in."
  }
}
run "new_project_needs_billing_account" {
  command = plan
  variables { create_project = true }
  expect_failures = [google_project.development]
}
run "budget_needs_amount_and_account" {
  command = plan
  variables { enable_budget = true }
  expect_failures = [google_billing_budget.development]
}
run "explicit_budget_and_project" {
  command = plan
  variables {
    create_project  = true
    billing_account = "012345-6789AB-CDEF01"
    enable_budget   = true
    budget_amount   = 100
  }
  assert {
    condition     = google_project.development[0].deletion_policy == "PREVENT" && length(google_billing_budget.development) == 1
    error_message = "Opt-in project creation must preserve deletion prevention and create the requested alert."
  }
}
