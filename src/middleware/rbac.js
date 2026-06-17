'use strict';

const PERMISSIONS = {
  'users:list':              ['manager', 'devops'],
  'users:approve':           ['manager', 'devops'],
  'users:create':            ['manager'],
  'users:modify-role':       ['manager'],
  'users:invite':            ['manager'],
  'users:view-self':         ['manager', 'devops', 'dev'],
  'users:modify-permissions':['manager'],

  'cicd:connect-gitlab':     ['manager', 'devops', 'dev'],
  'cicd:trigger-pipeline':   ['manager', 'devops', 'dev'],
  'cicd:view-pipeline':      ['manager', 'devops', 'dev'],
  'cicd:modify-config':      ['manager'],
  'cicd:view-logs':          ['manager', 'devops', 'dev'],

  'deployments:deploy':      ['manager', 'devops', 'dev'],
  'deployments:choose-cloud':['manager', 'devops'],
  'deployments:choose-replicas': ['manager', 'devops'],
  'deployments:delete':      ['manager', 'devops', 'dev'],

  'k8s:pods:view-all':       ['manager', 'devops'],
  'k8s:pods:view-own':       ['manager', 'devops', 'dev'],
  'k8s:pods:scale':          ['manager', 'devops'],
  'k8s:pods:delete':         ['manager', 'devops'],
  'k8s:quotas:view':         ['manager', 'devops', 'dev'],
  'k8s:quotas:modify':       ['manager', 'devops'],
  'k8s:events:view':         ['manager', 'devops'],

  'observability:logs:own':  ['manager', 'devops', 'dev'],
  'observability:logs:all':  ['manager', 'devops'],
  'observability:metrics:view': ['manager', 'devops', 'dev'],
  'observability:alerts:silence': ['manager', 'devops'],
  'observability:alerts:create':  ['manager', 'devops'],
  'observability:access:request': ['manager', 'devops', 'dev'],
  'observability:access:approve': ['manager'],

  'argocd:access:request':   ['manager', 'devops', 'dev'],
  'argocd:access:approve':   ['manager'],
  'argocd:apps:view-own':    ['manager', 'devops', 'dev'],
  'argocd:apps:view-all':    ['manager', 'devops'],
  'argocd:sync':             ['manager', 'devops'],
  'argocd:modify':           ['manager'],

  'teams:view':              ['manager', 'devops'],
  'teams:create':            ['manager'],

  'docs:read':               ['manager', 'devops', 'dev'],

  'secrets:view-names':      ['manager', 'devops'],
  'secrets:create':          ['manager'],
  'secrets:delete':          ['manager'],

  'platform:view-clouds':    ['manager', 'devops'],
  'platform:configure':      ['manager'],
  'platform:settings':       ['manager'],
};

function can(user, permission) {
  if (!user || !user.role) return false;
  const allowed = PERMISSIONS[permission];
  return allowed ? allowed.includes(user.role) : false;
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/auth/login');
    if (!can(req.user, permission)) {
      return res.status(403).render('error', {
        title: 'Accès refusé',
        message: 'Vous n\'avez pas les droits nécessaires pour accéder à cette page.',
        code: 403,
        user: req.user,
      });
    }
    next();
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/auth/login');
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', {
        title: 'Accès refusé',
        message: 'Vous n\'avez pas les droits nécessaires pour accéder à cette page.',
        code: 403,
        user: req.user,
      });
    }
    next();
  };
}

module.exports = { can, requirePermission, requireRole, PERMISSIONS };
