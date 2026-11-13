from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prepare_failover_phase1 as prepare
import render_failover_phase1 as gcp
from test_aws_prod_example import profile as aws_profile, observation as rds_observation
import test_failover_phase1


def profile():
    gc = test_failover_phase1.Phase1Tests().cloudrun_profile()
    aw = aws_profile(); app = aw['app_name']
    gc['app_name'] = app
    gc['credentials_secret_name'] = f'cnp-{app}-sql'
    gc['gcp_runtime']['password_secret'] = f'projects/{gcp.PROJECT}/secrets/{app}-prod-runtime'
    aw['runtime_secret_arn'] = f'arn:aws:secretsmanager:eu-west-3:626278345026:secret:cnp/failover/{app}/runtime-AbCd12'
    aw['database_ca_pem'] = gc['gcp_runtime']['database_ca_pem']
    return {'gcp': gc, 'aws': aw, 'automation': {
        'worker_image': '626278345026.dkr.ecr.eu-west-3.amazonaws.com/cnp-failover-apps@sha256:'+'a'*64,
        'ecs_cluster_arn': 'arn:aws:ecs:eu-west-3:626278345026:cluster/fixture',
        'ecs_security_group_id': 'sg-0123456789abcdef0', 'public_subnet_ids': ['subnet-0123456789abcdef0', 'subnet-1123456789abcdef0'],
        'subscription_ca_path_on_rds': '/server/fixture-ca.pem',
        'kube_context': f'gke_{gcp.PROJECT}_europe-west9-b_main-production-cluster', 'regime': 'platform', **prepare.PLATFORM_TASKS}}


def observations():
    app = profile()['gcp']['app_name']
    sql = test_failover_phase1.Phase1Tests().observation()
    sql['metadata']['name'] = app+'-prod-gcp-db'
    sql['status']['atProvider']['connectionName'] = f'{gcp.PROJECT}:europe-west9:{app}-prod-gcp-db'
    health = {'kind': 'HealthCheck', 'metadata': {'name': app+'-failover'}, 'status': {
        'conditions': [{'type':'Ready','status':'True'}, {'type':'Synced','status':'True'}],
        'atProvider': {'id':'12345678-1234-1234-1234-123456789abc', 'type':'HTTPS','port':443,
            'ipAddress':profile()['gcp']['gcp_lb_ip'], 'fqdn':app+'.apps.mooroon5.fr', 'resourcePath':'/health','enableSni':True}}}
    latch = deepcopy(health)
    latch['metadata']['name'] = app+'-failover-latch-http'
    latch['status']['atProvider'].update(id='12345678-1234-1234-1234-123456789abd',disabled=True)
    parent = deepcopy(latch)
    parent['metadata']['name'] = app+'-failover-primary-health'
    parent['status']['atProvider'].update(id='12345678-1234-1234-1234-123456789abe', type='CALCULATED', disabled=False, childHealthThreshold=2,
        childHealthchecks=[health['status']['atProvider']['id'],latch['status']['atProvider']['id']])
    return {'cloudsql':sql,'rds':rds_observation(),'healthcheck':health,'routing_latch':latch,'primary_healthcheck':parent}


def outputs():
    app=profile()['gcp']['app_name']
    return {'aws_secret_arns':{'value':{role:f'arn:aws:secretsmanager:eu-west-3:626278345026:secret:cnp/failover/{app}/{role}-AbCd12'
            for role in ['bootstrap','source-admin','runtime','target-admin']}},
        'gcp_runtime_secret':{'value':f'projects/{gcp.PROJECT}/secrets/{app}-prod-runtime'}}


def secret_result():
    return {'app':profile()['gcp']['app_name'],'initialized':True,'gcp_password_version':'1'}


def urlmap():
    return {'apiVersion':'compute.gcp.upbound.io/v1beta1','kind':'URLMap',
        'metadata':{'name':'cnp-application-routing','annotations':{'crossplane.io/external-name':'cnp-apps-urlmap'}},
        'spec':{'deletionPolicy':'Orphan','managementPolicies':['Observe','Update'],'providerConfigRef':{'name':'default'},
            'forProvider':{'project':gcp.PROJECT,'defaultService':'keep-this-default',
                'hostRule':[{'hosts':['other.apps.mooroon5.fr'],'pathMatcher':'cnp-other-prod'}],
                'pathMatcher':[{'name':'cnp-other-prod','defaultService':'keep-this-backend'}]}}}


def kustomization():
    return {'apiVersion':'kustomize.config.k8s.io/v1beta1','kind':'Kustomization',
        'resources':['gcs-bucket.yaml','cloudrun-claim.yaml','cloudrun-iam.yaml','application-network.yaml']}


class PackageTests(unittest.TestCase):
    def test_observed_production_cluster_name_can_prepare_secret_references(self):
        p=profile();p['automation']['kube_context']=f'gke_{gcp.PROJECT}_europe-west9-b_cnp-cluster-terraform'
        self.assertEqual(prepare.credentials_profile(p,outputs())['kube_context'],p['automation']['kube_context'])

    def test_database_stage_creates_only_database_candidates_and_preserves_bucket_reference(self):
        files=prepare.build(profile(),'databases',kustomization())
        prefix='apps/fixture-example/crossplane/prod/'
        self.assertIn('gcs-bucket.yaml',files[prefix+'kustomization.yaml']['resources'])
        self.assertNotIn(prefix+'gcs-bucket.yaml',files)
        self.assertNotIn(prefix+'cloudrun-claim.yaml',files)
        self.assertNotIn(prefix+'healthcheck.yaml',files)

    def test_runtime_uses_same_objects_as_portal_and_updates_no_other_routes(self):
        original=urlmap(); before=deepcopy(original)
        files=prepare.build(profile(),'runtime',kustomization(),observations(),original)
        self.assertEqual(original,before)
        prefix='apps/fixture-example/crossplane/prod/'
        items=files[prefix+'application-network.yaml']['items']
        self.assertEqual([o['metadata']['name'] for o in items],['cnp-fixture-example-prod-neg','cnp-fixture-example-prod-backend'])
        route=files['platform/application-routing/urlmap.yaml']['spec']['forProvider']
        self.assertIn(before['spec']['forProvider']['hostRule'][0],route['hostRule'])
        self.assertIn(before['spec']['forProvider']['pathMatcher'][0],route['pathMatcher'])
        self.assertEqual(route['defaultService'],'keep-this-default')
        resources=files[prefix+'kustomization.yaml']['resources']
        self.assertEqual(resources.count('application-network.yaml'),1)
        self.assertNotIn('application-neg.yaml',resources)

    def test_owned_route_update_is_idempotent(self):
        once=gcp.routing(profile()['gcp'],urlmap())
        self.assertEqual(once,gcp.routing(profile()['gcp'],once))

    def test_owned_route_keeps_existing_custom_paths(self):
        once=gcp.routing(profile()['gcp'],urlmap())
        matcher=next(m for m in once['spec']['forProvider']['pathMatcher'] if m['name']=='cnp-fixture-example-prod')
        matcher['pathRule']=[{'paths':['/special/*'],'service':'keep-custom-service'}]
        result=gcp.routing(profile()['gcp'],once)
        kept=next(m for m in result['spec']['forProvider']['pathMatcher'] if m['name']=='cnp-fixture-example-prod')
        self.assertEqual(kept['pathRule'],matcher['pathRule'])

    def test_unowned_host_or_shared_matcher_is_rejected(self):
        app=profile()['gcp']['app_name']; host=app+'.apps.mooroon5.fr'
        map_=urlmap(); map_['spec']['forProvider']['hostRule'].append({'hosts':[host],'pathMatcher':'other-owner'})
        with self.assertRaises(ValueError): gcp.routing(profile()['gcp'],map_)
        map_=urlmap(); map_['spec']['forProvider']['hostRule'].append({'hosts':['another-host'],'pathMatcher':'cnp-'+app+'-prod'})
        with self.assertRaises(ValueError): gcp.routing(profile()['gcp'],map_)

    def test_wrong_shared_map_or_project_is_rejected(self):
        for mutate in [lambda m:m['metadata'].update(name='other-map'),
                lambda m:m['spec']['forProvider'].update(project='other-project'),lambda m:m['spec'].update(deletionPolicy='Delete')]:
            map_=urlmap(); mutate(map_)
            with self.assertRaises(ValueError):gcp.routing(profile()['gcp'],map_)

    def test_cross_cloud_database_or_profile_mismatch_fails(self):
        for field,value in [('app_name','another-app'),('database_name','wrongdb'),('environment','dev')]:
            p=profile();p['aws'][field]=value
            with self.assertRaises(ValueError):prepare.validate(p)

    def test_initialization_profile_comes_from_managed_secret_outputs(self):
        config=prepare.credentials_profile(profile(),outputs())
        self.assertEqual(config['app'],'fixture-example')
        self.assertEqual(config['kubernetes_secret'],profile()['gcp']['credentials_secret_name'])
        self.assertNotIn('password',json.dumps(config))

    def test_bootstrap_uses_our_target_admin_secret_and_runtime_keeps_its_own(self):
        cfg=prepare.runtime_profiles(profile(),observations(),outputs(),secret_result())
        self.assertIn('/target-admin-',cfg['target']['secret_arn'])
        self.assertIn('/runtime-',cfg['runtime_secret_arn'])
        self.assertEqual(cfg['source']['host'],'10.189.0.3')

    def test_a_profile_reduced_to_the_database_name_reaches_the_bootstrap_package(self):
        # Le worker et la tâche d'initialisation reçoivent le même profil SQL : « postgres:{"database":…} », sans tables.
        p = profile()
        for side in ('gcp', 'aws'):
            p[side].update(application_profile='postgres', database_name='appdb', sql_contract={'database': 'appdb'})
        cfg = prepare.runtime_profiles(p, observations(), outputs(), secret_result())
        self.assertEqual(cfg['profile'], 'postgres:{"database":"appdb"}')
        worker = prepare.automation_profile(p, observations(), outputs(), secret_result())['worker-config.json']
        self.assertEqual(worker['applications'][0]['profile'], 'postgres:{"database":"appdb"}')
        self.assertNotIn('tables', json.dumps(cfg))

    def test_secret_version_or_application_mismatch_is_refused(self):
        for key,value in [('app','other-app'),('gcp_password_version','2'),('initialized',False)]:
            result=secret_result();result[key]=value
            with self.assertRaises(ValueError):prepare.runtime_profiles(profile(),observations(),outputs(),result)

    def test_missing_references_are_derived_without_overwriting_another_secret(self):
        p=profile();p['aws']['runtime_secret_arn']=None;p['gcp']['gcp_runtime']['password_version']=None
        resolved=prepare.resolve_credentials(p,outputs(),secret_result())
        self.assertEqual(resolved['gcp']['gcp_runtime']['password_version'],'1')
        self.assertEqual(resolved['aws']['runtime_secret_arn'],outputs()['aws_secret_arns']['value']['runtime'])
        self.assertIsNone(p['aws']['runtime_secret_arn'])
        p['aws']['runtime_secret_arn']='another-secret'
        with self.assertRaises(ValueError):prepare.resolve_credentials(p,outputs(),secret_result())

    def test_cli_writes_review_package_without_changing_source_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'repo';root.mkdir()
            base=root/'apps/fixture-example/crossplane/prod/kustomization.yaml';base.parent.mkdir(parents=True)
            original=json.dumps(kustomization());base.write_text(original)
            recipe=Path(temp)/'profile.json';recipe.write_text(json.dumps(profile()))
            out=Path(temp)/'review'
            with patch.object(prepare.subprocess,'run',side_effect=[Mock(stdout='a'*40+'\n'),Mock(stdout='')]),patch('sys.stdout'):
                self.assertEqual(prepare.main(['databases','--profile',str(recipe),'--repo-root',str(root),'--output',str(out)]),0)
            self.assertEqual(base.read_text(),original)
            review=json.loads((out/'review.json').read_text())
            self.assertFalse(review['published']);self.assertFalse(review['cloud_called'])
            self.assertTrue(review['requires_explicit_approval'])

    def test_automation_is_bound_to_observed_healthcheck_without_any_terraform_file(self):
        configs=prepare.automation_profile(profile(),observations(),outputs(),secret_result())
        self.assertEqual(set(configs),{'worker-config.json','bootstrap-config.json'})
        self.assertEqual(configs['worker-config.json']['applications'][0]['health_check_id'],observations()['healthcheck']['status']['atProvider']['id'])

    def test_automation_refuses_unready_or_unrelated_return_gates(self):
        for key,field,value in [('routing_latch','disabled',False),
                ('primary_healthcheck','childHealthchecks',['another-app'])]:
            obs=observations();obs[key]['status']['atProvider'][field]=value
            with self.assertRaises(ValueError):prepare.automation_profile(profile(),obs,outputs(),secret_result())
        obs=observations();obs['routing_latch']['status']['conditions'][0]['status']='False'
        with self.assertRaises(ValueError):prepare.automation_profile(profile(),obs,outputs(),secret_result())

    def test_explicit_subscriber_trust_choice_is_preserved_without_changing_admin_tls(self):
        p=profile();p['automation'].update(subscription_tls_mode='wireguard-tls',
            acknowledge_wireguard_subscriber_trust=True,subscription_ca_path_on_rds=None)
        result=prepare.runtime_profiles(p,observations(),outputs(),secret_result())
        self.assertEqual(result['subscription_tls_mode'],'wireguard-tls')
        self.assertTrue(result['acknowledge_wireguard_subscriber_trust'])
        self.assertEqual(result['source']['ca_pem'],p['gcp']['gcp_runtime']['database_ca_pem'])

    def test_healthcheck_following_dns_or_from_other_app_is_refused(self):
        for field,value in [('ipAddress','8.8.8.8'),('fqdn','other.apps.mooroon5.fr'),('resourcePath','/'),('type','TCP')]:
            obs=observations();obs['healthcheck']['status']['atProvider'][field]=value
            with self.assertRaises(ValueError):prepare.automation_profile(profile(),obs,outputs(),secret_result())

    def test_unready_observation_cannot_prepare_runtime(self):
        obs=observations();obs['rds']['status']['conditions'][0]['status']='False'
        with self.assertRaises(ValueError):prepare.build(profile(),'runtime',kustomization(),obs,urlmap())

    def test_output_can_never_be_an_active_gitops_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);p=root/'profile.json';p.write_text(json.dumps(profile()))
            for watched in ['apps','platform','argocd','infra','.git']:
                with patch('sys.stderr'),patch.object(prepare.subprocess,'run') as git:
                    self.assertEqual(prepare.main(['databases','--profile',str(p),'--repo-root',str(root),'--output',str(root/watched/'generated')]),1)
                    git.assert_not_called()

    def test_kustomization_cannot_escape_app_directory(self):
        base=kustomization();base['resources'].append('../../other-app/secret.yaml')
        with self.assertRaises(ValueError):prepare.merge_kustomization(base,['rds-instance.yaml'])


if __name__=='__main__': unittest.main()
