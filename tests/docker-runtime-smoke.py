"""Run inside hap-inference-standard:1; no weights or GPU required."""
import importlib.util
import json
import os
import unittest
from fastapi import HTTPException

os.environ.update(MODEL_ID='openai/whisper-base', MODEL_REPO='openai/whisper-base', MODEL_ENGINE='whisper')
spec = importlib.util.spec_from_file_location('hap_runtime', '/app/server.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)

class RuntimeTests(unittest.TestCase):
    def tearDown(self):
        runtime.state.update(phase='loading', error='')

    def test_loading_is_not_healthy(self):
        self.assertEqual(runtime.health().status_code, 503)
        with self.assertRaises(HTTPException) as raised:
            runtime.models()
        self.assertEqual(raised.exception.status_code, 503)

    def test_model_identity_and_wrong_endpoint(self):
        runtime.state['phase'] = 'ready'
        self.assertEqual(runtime.health().status_code, 200)
        self.assertEqual(runtime.models()['data'][0]['id'], 'openai/whisper-base')
        with self.assertRaises(HTTPException) as raised:
            runtime.generate_image(runtime.GenerationInput(prompt='cat'))
        self.assertEqual(raised.exception.status_code, 400)

    def test_failed_load_is_not_healthy(self):
        runtime.state.update(phase='error', error='Authorization required')
        result = runtime.health()
        self.assertEqual(result.status_code, 503)
        self.assertIn('Authorization required', json.loads(result.body)['error'])

    def test_wrong_model_identifier_is_rejected(self):
        runtime.state['phase'] = 'ready'
        with self.assertRaises(HTTPException) as raised:
            runtime.ready({'whisper'}, 'missing-model')
        self.assertEqual(raised.exception.status_code, 404)

if __name__ == '__main__':
    unittest.main()
