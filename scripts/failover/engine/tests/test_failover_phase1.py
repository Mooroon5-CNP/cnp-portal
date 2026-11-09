import importlib.util
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render_failover_phase1 as renderer
import render_aws_prod_example as aws


def config():
    # Profil PostgreSQL de la plateforme : seul le nom de la base se déclare, le schéma se lit dans la base.
    return {"app_name": "cnp-failover-recette", "environment": "prod", "database_name": "appdb",
            "credentials_secret_name": "cnp-recette-sql", "gcp_lb_ip": "34.54.71.90",
            "application_profile": "postgres", "sql_contract": {"database": "appdb"}}


class Phase1Tests(unittest.TestCase):
    def cloudrun_profile(self):
        p=config()
        p['gcp_runtime']={
            'image':f'europe-west9-docker.pkg.dev/{renderer.PROJECT}/cnp-registry/fixture@sha256:'+64*'a',
            'service_account':f'cloud-run-sa@{renderer.PROJECT}.iam.gserviceaccount.com',
            'subnetwork':f'projects/{renderer.PROJECT}/regions/europe-west9/subnetworks/fixture',
            'password_secret':f'projects/{renderer.PROJECT}/secrets/fixture',
            'password_version':'1','database_ca_pem':(Path(__file__).parent/'fixtures/public-test-ca.pem').read_text()}
        return p

    def observation(self):
        return {'kind':'DatabaseInstance','metadata':{'name':'cnp-failover-recette-prod-gcp-db'},
            'status':{'conditions':[{'type':'Ready','status':'True'},{'type':'Synced','status':'True'}],
                'atProvider':{'connectionName':f'{renderer.PROJECT}:europe-west9:cnp-failover-recette-prod-gcp-db',
                    'privateIpAddress':'10.189.0.3'}}}

    def test_cloudrun_uses_private_observation_vpc_tls_and_versioned_secret(self):
        files=renderer.cloudrun(self.cloudrun_profile(),self.observation())
        p=files['cloudrun-claim.yaml']['spec']['forProvider']['template']
        self.assertEqual(p['vpcAccess']['egress'],'PRIVATE_RANGES_ONLY')
        env={x['name']:x for x in p['containers'][0]['env']}
        self.assertEqual(env['DB_HOST']['value'],'10.189.0.3')
        self.assertEqual(env['DB_SSLMODE']['value'],'verify-ca')
        self.assertEqual(env['DB_PASSWORD']['valueSource']['secretKeyRef']['version'],'1')
        self.assertNotIn('volumes',p)

    def test_cloudrun_rejects_incomplete_profile_unready_or_wrong_database(self):
        with self.assertRaises(ValueError): renderer.cloudrun(config(),self.observation())
        for field,value in [('privateIpAddress','34.1.1.1'),('connectionName','another:project:db')]:
            observation=self.observation(); observation['status']['atProvider'][field]=value
            with self.assertRaises(ValueError): renderer.cloudrun(self.cloudrun_profile(),observation)
        observation=self.observation(); observation['status']['conditions'][0]['status']='False'
        with self.assertRaises(ValueError): renderer.cloudrun(self.cloudrun_profile(),observation)

    def test_invalid_ca_is_rejected_for_aws_and_gcp(self):
        p=self.cloudrun_profile(); p['gcp_runtime']['database_ca_pem']='not a certificate'
        with self.assertRaises(ValueError): renderer.cloudrun(p,self.observation())
        # Utiliser le fixture existant de phase 0, sans aucun secret réel.
        import test_aws_prod_example
        p=test_aws_prod_example.profile(); p['database_ca_pem']='not a certificate'
        with self.assertRaises(ValueError): aws.runtime(p,test_aws_prod_example.observation())

    def test_aws_ca_is_included_in_the_immutable_task_configuration(self):
        import test_aws_prod_example
        p=test_aws_prod_example.profile(); observed=test_aws_prod_example.observation()
        old=aws.runtime(p,observed)['ecs-task-definition.yaml']['metadata']['name']
        p['database_ca_pem']=p['database_ca_pem']*2          # une autre CA (même certificat deux fois) : autre définition
        self.assertNotEqual(old,aws.runtime(p,observed)['ecs-task-definition.yaml']['metadata']['name'])

    def test_cloudsql_is_private_and_logical_decoding_prepared(self):
        files = renderer.cloudsql(config())
        spec = files["cloudsql-instance.yaml"]["spec"]
        self.assertEqual(spec["deletionPolicy"], "Orphan")
        self.assertFalse(spec["forProvider"]["settings"]["ipConfiguration"]["ipv4Enabled"])
        self.assertIn({"name": "cloudsql.logical_decoding", "value": "on"}, spec["forProvider"]["settings"]["databaseFlags"])
        self.assertEqual(spec["forProvider"]["rootPasswordSecretRef"]["key"], "admin-password")

    def test_users_reference_secret_without_password(self):
        for f in ["cnp_runtime.yaml", "cnp_replication.yaml"]:
            obj = renderer.cloudsql(config())[f]
            self.assertEqual(obj["spec"]["forProvider"]["passwordSecretRef"]["namespace"], "crossplane-system")
            self.assertNotIn("password", obj["spec"]["forProvider"])

    def test_dns_does_not_follow_name_that_switches(self):
        files = renderer.dns(config())
        check = files["healthcheck.yaml"]["spec"]["forProvider"]
        self.assertEqual(check["ipAddress"], "34.54.71.90")
        self.assertEqual(check["fqdn"], "cnp-failover-recette.apps.mooroon5.fr")
        self.assertTrue(check["enableSni"])
        self.assertEqual(check["resourcePath"], "/health")
        self.assertEqual(files["record-primary.yaml"]["spec"]["forProvider"]["healthCheckIdSelector"]["matchLabels"],
            files["healthcheck-primary.yaml"]["metadata"]["labels"])

    def test_primary_requires_both_gcp_health_and_persistent_return_gate(self):
        files = renderer.dns(config())
        parent = files['healthcheck-primary.yaml']['spec']['forProvider']
        self.assertEqual(parent['childHealthThreshold'], 2)
        self.assertEqual({r['name'] for r in parent['childHealthchecksRefs']},
            {'cnp-failover-recette-failover','cnp-failover-recette-failover-latch-http'})
        self.assertTrue(all(r['policy']['resolve']=='Always' for r in parent['childHealthchecksRefs']))
        latch = files['healthcheck-latch-http.yaml']['spec']
        self.assertEqual(latch['forProvider']['type'], 'HTTPS')
        self.assertTrue(latch['forProvider']['disabled'])
        self.assertNotIn('invertHealthcheck', latch['forProvider'])
        self.assertFalse(latch['initProvider']['invertHealthcheck'])
        self.assertNotIn('LateInitialize', latch['managementPolicies'])
        self.assertNotIn('*', latch['managementPolicies'])

    def test_secondary_does_not_depend_on_the_health_of_unrelated_alb_targets(self):
        secondary = renderer.dns(config())['record-secondary.yaml']['spec']['forProvider']
        self.assertFalse(secondary['alias']['evaluateTargetHealth'])

    def test_each_application_has_its_own_healthcheck(self):
        a = renderer.dns(config())["healthcheck.yaml"]["metadata"]["labels"]
        p = config(); p["app_name"] = "other-app"
        self.assertNotEqual(a, renderer.dns(p)["healthcheck.yaml"]["metadata"]["labels"])

    def test_dev_and_unknown_secret_values_rejected(self):
        for field,value in [("environment", "dev"), ("password", "fixture-not-secret"), ("credentials_secret_name", None)]:
            p = config(); p[field] = value
            with self.assertRaises(ValueError): renderer.cloudsql(p)

    def test_private_ip_cannot_be_health_target(self):
        p = config(); p["gcp_lb_ip"] = "10.189.0.3"
        with self.assertRaises(ValueError): renderer.dns(p)


if __name__ == "__main__":
    unittest.main()


class BillingModeTests(unittest.TestCase):
    """Facturation choisie au déploiement : à l'instance, le Cloud Run de GCP garde une instance active."""

    def render(self, mode=None):
        p = Phase1Tests().cloudrun_profile()
        if mode:
            p["billing_mode"] = mode
        return renderer.cloudrun(p, Phase1Tests().observation())["cloudrun-claim.yaml"]["spec"]["forProvider"]["template"]

    def test_usage_by_default_and_one_active_instance_when_chosen(self):
        self.assertNotIn("scaling", self.render())
        template = self.render("instance")
        self.assertEqual(template["scaling"], {"minInstanceCount": 1})
        self.assertEqual(template["containers"][0]["resources"], {"cpuIdle": False})
        with self.assertRaises(ValueError):
            self.render("always")
