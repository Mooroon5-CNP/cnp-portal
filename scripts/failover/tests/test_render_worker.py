"""Étape « worker » vue par le portail : l'alarme et l'enregistrement de configuration suivent la vie de l'application.

Les générateurs et leurs fixtures sont dans engine/ (moteur unique du failover, dans ce dépôt).
"""
import json
import os
from pathlib import Path
import sys
import unittest

ENGINE = Path(__file__).resolve().parents[1] / 'engine'
sys.path.insert(0, str(ENGINE))
sys.path.insert(0, str(ENGINE / 'tests'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render  # noqa: E402
import test_worker_phase1 as fixtures  # noqa: E402
from test_phase1_package import observations, secret_result, kustomization, urlmap, profile, outputs  # noqa: E402

APP = profile()['gcp']['app_name']
PREFIX = f'apps/{APP}/crossplane/prod/'
BUCKET = {'apiVersion': 'storage.gcp.upbound.io/v1beta1', 'kind': 'Bucket', 'metadata': {'name': 'historic'},
          'spec': {'forProvider': {'location': 'EU'}}}


def request(profile, credentials, **changes):
    value = {'profile': profile, 'credentials': credentials, 'secrets': secret_result(), 'observations': observations(),
             'stage': 'worker', 'baseline': {'kustomization': kustomization(), 'urlmap': urlmap(),
                                             'files': {PREFIX + 'gcs-bucket.yaml': json.dumps(BUCKET)}}}
    value.update(changes)
    return value


class WorkerStageTests(unittest.TestCase):
    def test_alarm_and_configuration_follow_the_application_while_the_rest_stays_protected(self):
        files = {name: json.loads(text) for name, text in render.render(
            request(fixtures.platform_profile(), fixtures.platform_outputs())).items()}
        for name in ('failover-alarm.yaml', 'failover-config.yaml'):
            self.assertNotIn('deletionPolicy', files[PREFIX + name]['spec'])      # retirer l'application les retire
        self.assertEqual(files[PREFIX + 'gcs-bucket.yaml']['spec']['deletionPolicy'], 'Orphan')
        self.assertIn('failover-config.yaml', files[PREFIX + 'kustomization.yaml']['resources'])

    def test_a_previous_candidate_is_not_made_orphan_when_a_later_stage_runs(self):
        first = render.render(request(fixtures.platform_profile(), fixtures.platform_outputs()))
        again = request(fixtures.platform_profile(), fixtures.platform_outputs(), stage='dns')
        again['baseline']['files'] = first
        for name, text in render.render(again).items():
            if name.endswith(('failover-alarm.yaml', 'failover-config.yaml')):
                self.assertNotIn('deletionPolicy', json.loads(text)['spec'], name)

    def test_a_profile_without_the_platform_regime_cannot_produce_it(self):
        # Le régime historique du pilote (sans « regime ») a été retiré le 07/11/2026.
        with self.assertRaises(ValueError):
            render.render(request(fixtures.legacy_profile(), outputs()))

    def test_a_refusal_shows_the_generator_reason_and_never_a_path(self):
        import io, subprocess
        result = subprocess.run([sys.executable, str(Path(render.__file__))], input=json.dumps(request(fixtures.legacy_profile(), outputs())),
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.strip(), "Rendu refusé : Profil hors du régime plateforme : le régime historique du pilote n'existe plus.")

    def test_an_application_without_database_cannot_produce_it(self):
        with self.assertRaises(ValueError):
            render.render(request({'mode': 'stateless', 'gcp': {'app_name': APP}}, {}))


if __name__ == '__main__':
    unittest.main()
