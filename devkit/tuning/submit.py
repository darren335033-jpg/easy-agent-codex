#!/usr/bin/env python3
"""Review a managed Gemini SFT request; network submission requires --submit.

No credentials are read by this module. google-genai obtains ADC only after an
explicit submit/status action. No automatic retry of job creation is issued.
"""
import argparse
import json
import math
import os
import re
import sys


def request_plan(args):
    project = args.project or os.environ.get('GOOGLE_CLOUD_PROJECT', '')
    region = args.region or os.environ.get('GOOGLE_CLOUD_REGION', 'us-central1')
    model = args.base_model or os.environ.get('VERTEX_TUNING_BASE_MODEL', 'gemini-3.5-flash')
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20}', project):
        raise ValueError('Provide your Google Cloud project ID or number with --project or GOOGLE_CLOUD_PROJECT.')
    if region not in ('us-central1', 'europe-west4'):
        raise ValueError('This Gemini 3.5 Flash preview profile supports us-central1 or europe-west4.')
    if model != 'gemini-3.5-flash':
        raise ValueError('This verified managed SFT profile supports gemini-3.5-flash. Check provider support before adding another model.')
    def gcs(value, label):
        if not value or not re.fullmatch(r'gs://[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]/[^\s?#]+\.jsonl', value):
            raise ValueError(f'{label} must be a gs://bucket/path.jsonl URI without query strings.')
        return value
    train = gcs(args.train, 'Training dataset')
    validation = gcs(args.validation, 'Validation dataset') if args.validation else None
    if train == validation:
        raise ValueError('Training and validation must use different GCS objects.')
    if not args.display_name.strip() or len(args.display_name) > 128:
        raise ValueError('Display name must contain 1–128 characters.')
    config = {'tuned_model_display_name': args.display_name.strip()}
    if validation:
        config['validation_dataset'] = {'gcs_uri': validation}
    if args.epochs is not None:
        if not 1 <= args.epochs <= 100:
            raise ValueError('This kit accepts an explicit epoch count from 1 to 100; model restrictions still apply.')
        config['epoch_count'] = args.epochs
    if args.learning_rate_multiplier is not None:
        if not math.isfinite(args.learning_rate_multiplier) or not 0 < args.learning_rate_multiplier <= 10:
            raise ValueError('This kit accepts a finite learning-rate multiplier above zero and at most 10.')
        config['learning_rate_multiplier'] = args.learning_rate_multiplier
    if args.adapter_size is not None:
        if args.adapter_size not in (1, 2, 4, 8, 16):
            raise ValueError('Supported adapter sizes are 1, 2, 4, 8, 16.')
        config['adapter_size'] = args.adapter_size
    return {'project': project, 'location': region, 'base_model': model, 'training_dataset': {'gcs_uri': train}, 'config': config, 'profile': 'Gemini 3.5 Flash managed SFT · Public Preview', 'token_limits_verified': False, 'cloud_resources_created': False}


def sdk_config(plan, types):
    raw = plan['config']
    config = {'tuned_model_display_name': raw['tuned_model_display_name']}
    if 'validation_dataset' in raw:
        config['validation_dataset'] = types.TuningValidationDataset(**raw['validation_dataset'])
    for key in ('epoch_count', 'learning_rate_multiplier'):
        if key in raw:
            config[key] = raw[key]
    if 'adapter_size' in raw:
        names = {1: 'ONE', 2: 'TWO', 4: 'FOUR', 8: 'EIGHT', 16: 'SIXTEEN'}
        config['adapter_size'] = getattr(types.AdapterSize, 'ADAPTER_SIZE_' + names[raw['adapter_size']])
    return types.CreateTuningJobConfig(**config)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project')
    parser.add_argument('--region')
    parser.add_argument('--base-model')
    parser.add_argument('--train', help='Training JSONL GCS URI')
    parser.add_argument('--validation', help='Optional validation JSONL GCS URI')
    parser.add_argument('--display-name', default='dazza-code-model')
    parser.add_argument('--epochs', type=int, help='Leave unset for the provider-selected first-run default')
    parser.add_argument('--learning-rate-multiplier', type=float)
    parser.add_argument('--adapter-size', type=int, choices=(1, 2, 4, 8, 16))
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--submit', action='store_true', help='Create a billable tuning job using ADC; otherwise only print a local plan')
    action.add_argument('--status', metavar='JOB_NAME', help='Read an existing tuning job; does not create another job')
    args = parser.parse_args(argv)
    try:
        if args.status:
            if not re.fullmatch(r'projects/[a-zA-Z0-9-]+/locations/(us-central1|europe-west4)/tuningJobs/[a-zA-Z0-9_-]+', args.status):
                raise ValueError('Use the full projects/.../locations/.../tuningJobs/... name returned by Google.')
            pieces = args.status.split('/')
            plan = {'project': pieces[1], 'location': pieces[3]}
        else:
            plan = request_plan(args)
            if not args.submit:
                print(json.dumps(plan, indent=2))
                return 0
    except ValueError as error:
        parser.error(str(error))
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        print('Install the development SDK with pip install -r devkit/requirements.txt inside a virtual environment.', file=sys.stderr)
        return 2
    try:
        # One transport attempt avoids an ambiguous job-creation retry.
        client = genai.Client(vertexai=True, project=plan['project'], location=plan['location'], http_options=types.HttpOptions(api_version='v1beta1', timeout=60000, retry_options=types.HttpRetryOptions(attempts=1)))
        try:
            if args.status:
                job = client.tunings.get(name=args.status)
            else:
                job = client.tunings.tune(base_model=plan['base_model'], training_dataset=types.TuningDataset(**plan['training_dataset']), config=sdk_config(plan, types))
            tuned = getattr(job, 'tuned_model', None)
            result = {'name': job.name, 'state': str(job.state), 'tuned_model': getattr(tuned, 'model', None), 'endpoint': getattr(tuned, 'endpoint', None)}
            print(json.dumps(result, indent=2, default=str))
        finally:
            client.close()
        return 0
    except Exception as error:
        print(f'Google request failed ({type(error).__name__}). Check ADC, project, IAM, API enablement and model access. Job creation was not automatically retried. If submission may have reached Google, inspect tuning jobs before submitting again.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
