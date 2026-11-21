'use strict';

const yaml = require('js-yaml');
const { _templates: tpl } = require('../src/services/onboarding');

// CNP-037: every onboarded app gets the Datadog defaults automatically.
describe('Onboarding templates — observability defaults', () => {
  const deployment = yaml.load(tpl.tplBaseDeployment('demo-app', 8080));
  const podLabels = deployment.spec.template.metadata.labels;
  const container = deployment.spec.template.spec.containers[0];

  test('pod carries the Datadog service tag', () => {
    expect(podLabels['tags.datadoghq.com/service']).toBe('demo-app');
  });

  test.each(['env', 'service', 'version'])('DD_%s is read from the unified service tag', (tag) => {
    const envVar = container.env.find(e => e.name === `DD_${tag.toUpperCase()}`);
    expect(envVar.valueFrom.fieldRef.fieldPath).toBe(`metadata.labels['tags.datadoghq.com/${tag}']`);
  });

  test('keeps the /healthz and /ready probe conventions', () => {
    expect(container.livenessProbe.httpGet.path).toBe('/healthz');
    expect(container.readinessProbe.httpGet.path).toBe('/ready');
  });

  test.each(['dev', 'prod'])('%s overlay sets the env tag and derives the version from the image tag', (env) => {
    const kustomization = yaml.load(tpl.tplOverlayKustomization('demo-app', env, 'platform', 8080));
    const envLabels = kustomization.labels.find(l => l.pairs['tags.datadoghq.com/env']);
    expect(envLabels.pairs['tags.datadoghq.com/env']).toBe(env);
    expect(envLabels.includeTemplates).toBe(true);

    const replacement = kustomization.replacements[0];
    expect(replacement.source.fieldPath).toBe('spec.template.spec.containers.0.image');
    expect(replacement.targets[0].fieldPaths).toContain('spec.template.metadata.labels.[tags.datadoghq.com/version]');
  });

  test.each([false, true])('Cloud Run claim carries the observability env (persistentStorage=%s)', (persistent) => {
    const claim = yaml.load(tpl.tplCrossplaneV2Service('demo-app', 8080, persistent));
    const env = Object.fromEntries(claim.spec.forProvider.template.containers[0].env.map(e => [e.name, e.value]));
    expect(env).toMatchObject({ LOG_LEVEL: 'INFO', DD_ENV: 'dev', DD_SERVICE: 'demo-app', DD_VERSION: 'placeholder' });
    expect(env.DATA_DIR).toBe(persistent ? '/data' : '/tmp');
  });

  test('configmap provides LOG_LEVEL and no hard-coded DD_VERSION', () => {
    const cm = yaml.load(tpl.tplOverlayConfigMap('demo-app', 'dev'));
    expect(cm.data.LOG_LEVEL).toBe('INFO');
    expect(cm.data.DD_VERSION).toBeUndefined();
  });
});
