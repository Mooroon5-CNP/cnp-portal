'use strict';

const { config } = require('../config/env');

// The public hostname is independent of the cloud runtime resource name.
// DNS, HTTPS certificates and failover remain owned by infrastructure.
function baseDomain() {
    const domain = (config.applications?.baseDomain || 'apps.mooroon5.fr').trim().toLowerCase().replace(/\.$/, '');
    if (domain.length > 200 || !domain.includes('.') || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        throw new Error('Domaine applicatif invalide.');
    }
    return domain;
}

function hostname(dep) {
    if (!['dev', 'prod'].includes(dep.environment)) return null;
    if (!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(dep.appName)) throw new Error('Nom applicatif invalide.');
    return `${dep.appName}${dep.environment === 'dev' ? '.dev' : ''}.${baseDomain()}`;
}

function url(dep) {
    const host = hostname(dep);
    return host ? `https://${host}` : null;
}

module.exports = { baseDomain, hostname, url };
