# Vertex AI development infrastructure

This Terraform module is a reviewable starting point. Nothing is provisioned by
copying it, running `init`, or validating its configuration. It does not start a
training job, reserve GPUs, deploy an endpoint, or connect an MCP server.

The default uses an **existing, billing-enabled GCP project**. Optional project
creation and monthly billing alerts require explicit inputs. Region defaults to
`us-central1`; verify your selected model supports tuning there and that the
project has quota before submitting a job. The bucket and Docker repository use
that same region. Pass this location to the tuning client. Serving locations can
differ: some tuned Gemini models serve in `us` or `eu` multi-regions. Follow the
chosen model's documentation for the inference client rather than assuming a
tuning job region is also a supported serving location.

## Resources and access

| Resource / identity | Access and behavior |
| --- | --- |
| Required APIs | Vertex AI, Storage, Artifact Registry, IAM, Service Usage; Billing Budgets only when requested. Destroying this module does not disable APIs. |
| Runtime service account | `roles/aiplatform.user` on the project; optional `roles/mcp.toolUser`. No storage or image write access. |
| Tuning pipeline service account | `roles/aiplatform.user` on the project, `roles/storage.objectUser` on this bucket, `roles/artifactregistry.writer` on this repository. |
| Standard Vertex AI service agent | Google-managed identity with explicit `roles/storage.objectViewer` on this bucket. Specialized tuning agents retain their Google-managed project roles. |
| Artifact bucket | Uniform access, enforced public access prevention, versioning, no forced deletion of objects. No retention lock is created. Automatic archived-version deletion is opt-in. |
| Docker repository | Regional private Artifact Registry repository. |
| Monthly budget | Optional, filtered to this project, emails default billing account recipients at the configured thresholds. **Alerts do not cap spending or shut resources down.** |

IAM bindings are additive (`*_iam_member`). The module does not overwrite the
project IAM policy, grant project-wide Storage Admin, create service account
keys, grant service account impersonation, or configure an organization.
Google-managed service-agent roles established when the Vertex API is enabled
remain under Google's management. `aiplatform.user` is a practical development
role; production workloads can replace it with narrower custom roles after
observing which operations they need.

For Gemini supervised tuning, the pipeline account submits the job; Google can
create specialized managed tuning identities, including
`service-PROJECT_NUMBER@gcp-sa-vertex-tune.iam.gserviceaccount.com`, whose default
`roles/aiplatform.tuningServiceAgent` provides same-project dataset access. This
module does not guess or pre-bind those identities before Google creates them,
and does not assign service-agent roles to user-created accounts. Cross-project
dataset access needs explicit grants to the actual identities used by the chosen
tuning flow. A custom training job executing as a chosen service account also
needs `iam.serviceAccounts.actAs` for its authorized submitting principal. This
module does not configure custom training.

## Prepare and review

Use Terraform 1.6 or later and an identity authorized to manage these resources.
For an existing project, the operator needs API enablement, service account
creation, resource IAM, bucket, and Artifact Registry permissions. Project
creation additionally needs project creator access in the parent and billing
association access. Budget creation needs access to manage budgets on the
billing account. The runtime and pipeline accounts are deliberately not granted
these infrastructure-administration permissions.

Use an attached workload identity or workload identity federation in automation.
For local interactive development, authenticate with Application Default
Credentials using your approved Google Cloud identity. Do not put a credential
JSON file or access token in this directory, Terraform variables, or the web UI.

```sh
gcloud auth application-default login
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your project, bucket, and optional budget inputs.
terraform init
terraform fmt -check
terraform validate
terraform plan -out=development.tfplan
```

`plan` contacts Google Cloud and requires valid credentials; review its proposed
changes and costs before using a saved plan to apply. For collaboration, first
configure an approved encrypted remote state backend with access controls and
locking; the default local state is excluded from version control. State and
saved plans can contain operational details and must be protected.

The included mocked plan tests need Terraform 1.7 or later. They check private
defaults and required billing inputs without contacting Google or provisioning
anything:

```sh
terraform test
```

Provider version ranges are declared in `main.tf`; the included generated lock
file records the versions and verified checksums used for validation. The
`google-beta` provider is used only to generate the standard Vertex service-agent
identity explicitly. Commit lock-file changes produced by `init` after review;
do not fabricate its hashes. If changing the provider range, review the upstream
upgrade guide and a plan.

## Connect the development tools

Use the output values for `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_REGION`,
`GOOGLE_GENAI_USE_VERTEXAI`, and `VERTEX_AI_STAGING_BUCKET`. These are identifiers,
not credentials. They can be copied to the devkit's local environment settings.
`GOOGLE_CLOUD_REGION` is the devkit's regional setting; Google GenAI's automatic
client configuration instead uses `GOOGLE_CLOUD_LOCATION`. Set that location
explicitly for the tuning or inference flow and selected model.
Attach the runtime identity to the eventual inference service; attach the tuning
identity to the orchestration workload. Creating an account does not make an
already running app use it.

The optional `enable_vertex_mcp_access` switch grants the runtime permission to
invoke Google remote MCP tools. Follow Google's enablement steps for each
specific MCP server separately; this does not grant access to other MCP servers
or configure Dazza Forge's server URLs. Local Docker evaluation remains separate
from any cloud model job and must run with the devkit's isolation requirements.

## Operational limits

- Existing project billing and model quotas must already be configured. This
  module does not purchase quota or silently create a billing account.
- If resources with these names already exist, import the intended resources
  into state before planning; do not recreate or replace active resources.
- New projects have `deletion_policy = "PREVENT"`; remove or change that setting
  only when intentionally retiring a project. Existing projects are data sources
  and are not owned by this module.
- The bucket refuses forced object deletion on destroy. Delete retained objects
  deliberately if retiring it. No irreversible retention lock is set.
- Removing infrastructure can still remove IAM bindings and empty repositories;
  review a destroy plan before taking action. Artifact Registry images and bucket
  storage have ongoing charges independently of training.
- A 50-agent UI roster does not imply 50 paid model calls at once. Keep explicit
  concurrency and token budgets in the orchestration layer.

References: [Gemini tuning setup](https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini-use-supervised-tuning),
[Google Terraform provider](https://registry.terraform.io/providers/hashicorp/google/latest/docs),
[Billing budgets](https://cloud.google.com/billing/docs/how-to/budgets),
[ADC](https://cloud.google.com/docs/authentication/application-default-credentials),
[remote MCP access control](https://cloud.google.com/mcp/supported-products),
[Google-managed service agents](https://docs.cloud.google.com/iam/docs/service-agents).
