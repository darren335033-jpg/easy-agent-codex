# Vertex model development kit

This kit extends Dazza Forge with native Google Cloud infrastructure configuration, text-only Gemini dataset validation, a managed supervised-tuning request builder, and a local gVisor evaluation controller. Infrastructure and training remain unprovisioned until you supply your Google project, billing settings, ADC/workload identity and datasets. The online Model lab validates dataset structure; it does not execute generated code or start tuning jobs.

## 1. Prepare the environment

Use Python 3.10+ and Node 22.13+. In the repository root:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r devkit/requirements.txt
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
export GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
export GOOGLE_CLOUD_REGION=us-central1
export VERTEX_AI_STAGING_BUCKET=gs://YOUR_PRIVATE_BUCKET
```

The tuning script passes project and location explicitly; `GOOGLE_CLOUD_REGION` is a kit setting. Google SDK auto-configuration elsewhere normally uses `GOOGLE_CLOUD_LOCATION`. Keep the inference app's location separate: Gemini 3.5 Flash preview tuning uses `us-central1` or `europe-west4`, while its tuned serving uses `us` or `eu` multi-region endpoints. The app's default inference model is not automatically a supported tuning model.

The GenAI SDK supports managed Gemini SFT directly. `google-cloud-aiplatform` is not needed by this script; custom training jobs and pipeline APIs are a separate workflow. Gemini managed tuning does not give you downloadable Gemini weights or require you to choose a GPU or build a training image. Fine-tuning is distinct from the workspace's 50 role configurations.

## 2. Review infrastructure

See [infra/README.md](infra/README.md). Terraform defaults to an existing project, creates separate runtime and tuning identities, enables the required APIs, and provisions a private regional storage bucket and Artifact Registry repository. Bucket access uses object roles rather than project-wide Storage Admin. No service-account keys are generated. Prefer ADC locally and workload identity for automation.

Project creation and alerts-only billing budgets are opt-in. Ordinary budget alerts do not stop charges. Google separately supports service-specific spend cap budgets for eligible Vertex usage; in-flight requests and persistent resources can still incur costs, so those are not an absolute invoice ceiling. This Terraform kit implements alerts, not spend caps. Review `terraform plan` before any `apply`.

## 3. Validate training and held-out data

```sh
node devkit/datasets/validate.mjs \
  devkit/datasets/example-training.jsonl \
  devkit/datasets/example-validation.jsonl
```

The checked-in examples illustrate the format and are too small for meaningful training. Use licensed or owned high-quality examples. Keep training prompts separate from validation and final evaluation benchmarks. This validator detects exact normalized conversation overlap, duplicates, malformed JSON and unsupported text record structure; it cannot detect semantic duplicates or establish data provenance.

Each nonblank JSONL line is one object with optional `systemInstruction.parts[].text` and alternating `contents` messages using explicit `user` / `model` roles. The last turn supplies the gold model answer. This is the kit's supported text-only subset, not every multimodal or tool-calling dataset Google accepts. JSON string newlines in code must be escaped within a single line. Do not use `assistant` as the target role.

For the verified Gemini 3.5 Flash SFT preview profile, Google documents a 1 GB training JSONL maximum, 131,072 input-plus-output tokens per example, and up to 10 million text examples. Validation allows up to 5,000 examples; when over 1,000, it must not exceed 30% of training count. Starting with at least 100 examples is a recommendation, not a hard minimum. Token counts must be checked with the target model's provider tokenizer; character counts are not token verification.

The online validator accepts 400,000 combined bytes and up to 2,000 examples per split. The local CLI accepts 16 MiB combined and up to 100,000 rows per split. Larger datasets need a streaming data pipeline and provider-side validation. Private datasets are excluded from source downloads; the kit includes only its named illustrative fixtures.

Upload validated files to your private bucket using authenticated Google tooling:

```sh
gcloud storage cp /path/to/train.jsonl gs://YOUR_PRIVATE_BUCKET/datasets/train.jsonl
gcloud storage cp /path/to/validation.jsonl gs://YOUR_PRIVATE_BUCKET/datasets/validation.jsonl
```

## 4. Review a managed tuning request

```sh
python devkit/tuning/submit.py \
  --project YOUR_PROJECT_ID \
  --region us-central1 \
  --train gs://YOUR_PRIVATE_BUCKET/datasets/train.jsonl \
  --validation gs://YOUR_PRIVATE_BUCKET/datasets/validation.jsonl \
  --display-name dazza-code-model
```

This prints a local request plan and makes no cloud call. `gemini-3.5-flash` is the current verified **Public Preview** profile; availability and quotas must be verified in your own project. Epochs, learning-rate multiplier and adapter size remain unset on the first run, following Google's recommendation. Explicit overrides are available; the script does not claim that generic ranges guarantee good training. Batch size and absolute learning rate belong to a separate open-model training workflow.

Only add `--submit` when you intend to create a billable tuning job. It uses ADC, the current GenAI SDK's `TuningDataset` / `TuningValidationDataset` types, one transport attempt and a 60-second HTTP timeout. If submission is interrupted, inspect existing jobs before retrying; a lost response does not mean Google failed to create the job. Track the full returned job resource:

```sh
python devkit/tuning/submit.py --status projects/YOUR_PROJECT_ID/locations/us-central1/tuningJobs/JOB_ID
```

The script does not fetch or validate remote GCS contents, certify token limits, estimate final cost or automatically deploy a tuned endpoint. Save the actual tuned model and endpoint returned by Google; do not substitute a regional tuning endpoint for its model-specific serving location.

## 5. Evaluate generated code locally

Use the [evaluation controller](evaluation/README.md) on a dedicated worker with Docker and gVisor installed. Build its trusted image, then run the checked-in smoke fixtures:

```sh
docker --host=unix:///var/run/docker.sock build -t dazza-forge-eval:local devkit/evaluation
python -m devkit.evaluation.evaluate --smoke
```

The complete documented build command clears Docker selectors; use it when your shell has remote Docker contexts. Pin the base image digest for reproducible builds. The evaluator never downloads images during a test and defaults to `runsc`; it fails closed when that runtime is unavailable. There is no cloud browser execution endpoint.

Candidate code executes in disposable containers with no network or host mounts, read-only root, non-root UID, no capabilities, no new privileges, CPU/memory/process limits, bounded output and timeouts. Cleanup is checked. Missing infrastructure produces an incomplete result with `pass_at_1: null`; candidate timeouts count as failures. This is one completion per task, not a claimed official HumanEval or MBPP result. The in-process test oracle is not tamper-resistant against adversarial candidates, and containerization is not an absolute isolation guarantee. Use dedicated workers and patched runtimes.

## 6. Verify in CI without executing model code on the host

```sh
npm test
python -m unittest discover -s devkit/tests -p 'test_*.py'
```

The Python unit tests mock the Docker boundary; generated code is never imported or executed by the host test runner. `bash devkit/ci/check.sh` runs both check suites. On a dedicated evaluation worker, set `FORGE_EVALUATION_CASES` to an existing candidate JSONL path and optionally `FORGE_EVALUATION_IMAGE` to an immutable image digest; the same script then invokes the default gVisor evaluator. It never downloads models or images. Connect your tuned-checkpoint event to this CI entry point after producing completions in a separate authenticated generation stage. That event integration is not provisioned by this kit. Do not mix cloud credentials into the evaluation container or embed private datasets, Terraform state or keys in source archives.

## Current verification

The kit's Node and Python checks pass. Terraform was formatted and validated against the pinned provider schema with four offline mocked-plan tests. The trusted smoke evaluation passed under the actual default gVisor runtime in this workspace. No GCP resources, tuning jobs or tuned model deployments were created, and no training benchmark score is claimed.

## References

- [Managed SFT support, limits and regions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tuning/supervised-tuning)
- [Tuning workflow and defaults](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tuning/supervised-tuning/use)
- [Text dataset examples](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tuning/text)
- [Python GenAI SDK](https://googleapis.github.io/python-genai/genai.html)
- [Alerts-only budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets)
- [Spend caps and their limits](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)
