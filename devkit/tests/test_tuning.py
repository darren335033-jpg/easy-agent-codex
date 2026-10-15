import argparse
import unittest
from unittest.mock import patch
from devkit.tuning.submit import request_plan, sdk_config

def args(**kw):
    values=dict(project='dazza-model-dev',region='us-central1',base_model='gemini-3.5-flash',train='gs://dazza-training-bucket/train.jsonl',validation='gs://dazza-training-bucket/validation.jsonl',display_name='dazza-test',epochs=None,learning_rate_multiplier=None,adapter_size=None)
    values.update(kw)
    return argparse.Namespace(**values)

class TuningPlanTests(unittest.TestCase):
    def test_first_run_leaves_hyperparameters_unset_and_never_claims_token_verification(self):
        plan=request_plan(args())
        self.assertFalse(plan['token_limits_verified'])
        self.assertEqual(set(plan['config']),{'tuned_model_display_name','validation_dataset'})
        self.assertFalse(plan['cloud_resources_created'])

    def test_rejects_unsupported_profile_same_split_invalid_uri_and_numeric_values(self):
        for change in [dict(base_model='gemini-3.8-flash'),dict(region='global'),dict(validation='gs://dazza-training-bucket/train.jsonl'),dict(train='https://example.com/train.jsonl'),dict(project=''),dict(learning_rate_multiplier=float('nan')),dict(epochs=0),dict(adapter_size=32)]:
            with self.subTest(change=change),patch.dict('os.environ',{},clear=True),self.assertRaises(ValueError):request_plan(args(**change))

    def test_sdk_conversion_uses_validation_type_and_adapter_enum(self):
        class Types:
            class AdapterSize:ADAPTER_SIZE_EIGHT='enum-eight'
            @staticmethod
            def TuningValidationDataset(**kw):return ('validation',kw)
            @staticmethod
            def CreateTuningJobConfig(**kw):return kw
        config=sdk_config(request_plan(args(adapter_size=8,epochs=2,learning_rate_multiplier=.5)),Types)
        self.assertEqual(config['validation_dataset'][0],'validation')
        self.assertEqual(config['adapter_size'],'enum-eight')
        self.assertEqual(config['epoch_count'],2)

if __name__=='__main__':unittest.main()
