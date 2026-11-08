"""Runtimes et DNS sans base ni worker SQL ; aucune opération cloud."""
import re
import render_failover_phase1 as gcp
import render_aws_prod_example as aws


def validate(profile):
    if not isinstance(profile, dict) or set(profile) != {'mode', 'gcp', 'aws', 'automation'} or profile['mode'] != 'stateless' or profile['automation'] != {}:
        raise ValueError('Profil sans état invalide.')
    gc, aw = profile['gcp'], profile['aws']
    app = gcp.validate(gc)
    if set(gc) - {'app_name', 'application_profile', 'environment', 'container_port', 'liveness_path', 'readiness_path', 'gcp_lb_ip', 'gcp_runtime'} or set(aw) - {'app_name', 'application_profile', 'environment', 'container_port', 'liveness_path', 'readiness_path', 'image', 'listener_priority', 'log_group_name'}:
        raise ValueError('Aucune configuration SQL ni secret dans un profil sans état.')
    if gc.get('application_profile') != 'stateless' or aw.get('application_profile') != 'stateless' or aw.get('app_name') != app or aw.get('environment') != 'prod' or gc.get('container_port', 8080) != aw.get('container_port', 8080):
        raise ValueError('Les deux clouds doivent déployer la même application de production.')
    for side in (gc, aw):
        for key in ('liveness_path', 'readiness_path'):
            if not re.fullmatch(r'/[a-zA-Z0-9/_-]*', side.get(key, '/health')):
                raise ValueError('Chemin de santé invalide.')
    return app


def runtime(profile):
    app = validate(profile)
    gc, aw = profile['gcp'], profile['aws']
    p = gc['gcp_runtime']
    if set(p) != {'image', 'service_account', 'subnetwork'} or not re.fullmatch(rf'europe-west9-docker\.pkg\.dev/{gcp.PROJECT}/cnp-registry/[a-z0-9-]+@sha256:[a-f0-9]{{64}}', p.get('image', '')) or not re.fullmatch(rf'[a-z0-9-]+@{gcp.PROJECT}\.iam\.gserviceaccount\.com', p.get('service_account', '')) or not re.fullmatch(rf'projects/{gcp.PROJECT}/regions/europe-west9/subnetworks/[a-z0-9-]+', p.get('subnetwork', '')):
        raise ValueError('Image par digest et runtime GCP explicites requis.')
    if not re.fullmatch(rf'{aws.ACCOUNT}\.dkr\.ecr\.{aws.REGION}\.amazonaws\.com/[a-z0-9][a-z0-9/_-]*@sha256:[a-f0-9]{{64}}', aw.get('image', '')) or type(aw.get('listener_priority')) is not int or not 1 <= aw['listener_priority'] <= 50000:
        raise ValueError('Image ECR par digest et priorité ALB explicites requises.')
    if aw.get('log_group_name') is not None and not re.fullmatch(r'/ecs/[a-zA-Z0-9/_-]+', aw['log_group_name']):
        raise ValueError('Groupe de logs invalide.')
    port = gc.get('container_port', 8080)
    service = aws.resource('cloudrun.gcp.upbound.io/v1beta2', 'V2Service', app + '-prod', {
        'project': gcp.PROJECT, 'location': 'europe-west9', 'ingress': 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
        'template': {'serviceAccount': p['service_account'], 'vpcAccess': {'egress': 'PRIVATE_RANGES_ONLY', 'networkInterfaces': [{
            'network': f'projects/{gcp.PROJECT}/global/networks/gcp-hybrid-vpc', 'subnetwork': p['subnetwork']}]},
            'containers': [{'image': p['image'], 'ports': {'containerPort': port}}]}}, app, 2)
    iam = aws.resource('cloudrun.gcp.upbound.io/v1beta2', 'ServiceIAMMember', app + '-prod-public', {
        'project': gcp.PROJECT, 'location': 'europe-west9', 'service': app + '-prod', 'role': 'roles/run.invoker', 'member': 'allUsers'}, app, 3)
    container = {'name': 'app', 'image': aw['image'], 'essential': True, 'portMappings': [{'containerPort': port, 'protocol': 'tcp'}]}
    if aw.get('log_group_name'):
        container['logConfiguration'] = {'logDriver': 'awslogs', 'options': {'awslogs-group': aw['log_group_name'], 'awslogs-region': aws.REGION, 'awslogs-stream-prefix': app + '-prod'}}
    return {'cloudrun-claim.yaml': service, 'cloudrun-iam.yaml': iam, **aws.runtime_resources(aw, container)}
