variable "project_id" {
  description = "Existing GCP project ID, or the ID to create when create_project is true."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use a GCP project ID of 6–30 lowercase letters, digits, or hyphens, beginning with a letter and ending with a letter or digit."
  }
}

variable "create_project" {
  description = "Explicit opt-in to creating a project. The default manages resources in an existing project."
  type        = bool
  default     = false
}

variable "project_name" {
  description = "Display name used only for a newly created project."
  type        = string
  default     = "Dazza code model development"
}

variable "folder_id" {
  description = "Optional parent folder ID for a newly created project. Leave null to use the account's default parent."
  type        = string
  default     = null
}

variable "billing_account" {
  description = "Billing account ID (XXXXXX-XXXXXX-XXXXXX). Required only for project creation or a billing budget. Existing project billing is not changed."
  type        = string
  default     = null
  validation {
    condition     = var.billing_account == null ? true : can(regex("^[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}$", var.billing_account))
    error_message = "Use a billing account ID such as 012345-6789AB-CDEF01, without the billingAccounts/ prefix."
  }
}

variable "region" {
  description = "Regional resource location. Verify tuning availability and quota for the selected base model before use."
  type        = string
  default     = "us-central1"
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "Use a GCP region such as us-central1, not a multi-region or zone."
  }
}

variable "bucket_name" {
  description = "Globally unique private bucket name for datasets and model artifacts."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "Use 3–63 lowercase letters, digits, or hyphens, beginning and ending with a letter or digit."
  }
}

variable "noncurrent_version_retention_days" {
  description = "Delete archived object generations after this many days and only when at least five newer versions exist. Null disables automatic object deletion. This is not a locked retention policy."
  type        = number
  default     = null
  validation {
    condition     = var.noncurrent_version_retention_days == null ? true : (var.noncurrent_version_retention_days >= 1 && floor(var.noncurrent_version_retention_days) == var.noncurrent_version_retention_days)
    error_message = "Use null or a positive integer number of days."
  }
}

variable "artifact_repository_id" {
  description = "Regional Docker repository for evaluation and deployment images."
  type        = string
  default     = "dazza-code-models"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,61}[a-z0-9]$", var.artifact_repository_id))
    error_message = "Use 2–63 lowercase letters, digits, or hyphens, beginning with a letter and ending with a letter or digit."
  }
}

variable "enable_vertex_mcp_access" {
  description = "Grant runtime roles/mcp.toolUser for Google's remote MCP tools. Does not enable or connect any MCP server."
  type        = bool
  default     = false
}

variable "enable_budget" {
  description = "Explicit opt-in to a monthly project-filtered billing alert. Budgets are alerts, not a spending cap."
  type        = bool
  default     = false
}

variable "budget_amount" {
  description = "Monthly budget in whole currency units. Supply an amount before enabling the budget."
  type        = number
  default     = null
  validation {
    condition     = var.budget_amount == null ? true : (var.budget_amount > 0 && floor(var.budget_amount) == var.budget_amount)
    error_message = "Use null or a positive whole number of currency units."
  }
}

variable "budget_currency" {
  description = "ISO 4217 currency matching the billing account."
  type        = string
  default     = "USD"
  validation {
    condition     = can(regex("^[A-Z]{3}$", var.budget_currency))
    error_message = "Use a three-letter uppercase currency code."
  }
}

variable "budget_thresholds" {
  description = "Actual monthly spend thresholds; default billing account recipients receive email alerts."
  type        = set(number)
  default     = [0.5, 0.9, 1.0]
  validation {
    condition     = length(var.budget_thresholds) > 0 && alltrue([for threshold in var.budget_thresholds : threshold > 0 && threshold <= 10])
    error_message = "Supply at least one threshold greater than zero and no greater than 10 (1000%)."
  }
}

variable "labels" {
  description = "Labels applied to supported resources. Keep values free of personal or confidential data."
  type        = map(string)
  default = {
    app         = "dazza-forge"
    environment = "development"
    managed_by  = "terraform"
  }
}
