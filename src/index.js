'use strict';

require('dotenv').config();
const { sessionSecret } = require('./config/session');
require('./models/db'); // initialize SQLite and bootstrap admin
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const { createLogger, requestMiddleware } = require('./middleware/logger');
const { populateUser, requireAuth, requirePending } = require('./middleware/auth');
const { can } = require('./middleware/rbac');
const { browserWriteGuard } = require('./middleware/browser-write-guard');
const { buildOrchestratorRouter } = require('../apps/orchestrator/src');

const app = express();
const logger = createLogger();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust the first proxy (Cloud Run / load balancer) so req.secure reflects
// the original HTTPS connection, which is required for secure session cookies.
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

app.use(browserWriteGuard);
app.use(flash());
app.use(requestMiddleware(logger));
app.use(populateUser);

const manifestMrModel = require('./models/manifest_mr');

app.use((req, res, next) => {
  res.locals.user = req.user || null;
  res.locals.flash = req.flash();
  res.locals.can = req.user ? (p) => can(req.user, p) : () => false;
  res.locals.pendingMrCount   = 0;
  res.locals.rejectedMrCount  = 0;
  if (req.user) {
    try {
      if (req.user.role === 'manager') {
        res.locals.pendingMrCount = manifestMrModel.countAllPending();
      } else if (req.user.role === 'devops') {
        res.locals.rejectedMrCount = manifestMrModel.countRejectedForUser(req.user.id);
      }
    } catch (_) { /* non-critical — badge counts default to 0 */ }
  }
  next();
});

// Health checks — no auth required
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/ready',   (req, res) => res.status(200).json({ status: 'ready' }));
app.use('/api',     require('./routes/health'));

app.use('/auth',         require('./routes/auth'));
app.get('/pending', requirePending, (req, res) => {
  res.render('pending', { title: 'Demande en cours — CNP Portal', user: req.user || null });
});
app.use('/profile',      require('./routes/profile'));
app.use('/',             require('./routes/dashboard'));
app.use('/deployments',  require('./routes/deployments'));
app.use('/failover',     require('./routes/failover'));
app.use('/k8s',          require('./routes/k8s'));
app.use('/observability',require('./routes/observability'));
app.use('/argocd',       require('./routes/argocd'));
app.use('/docs',         require('./routes/documentation'));
app.use('/admin',        require('./routes/admin'));
app.use('/admin/teams',  require('./routes/teams'));
app.use(buildOrchestratorRouter({ requireAuth }));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page introuvable', message: 'Cette page n\'existe pas.', code: 404, user: req.user || null });
});

app.use((err, req, res, _next) => {
  logger.error({ message: err.message, stack: err.stack, path: req.path });
  res.status(err.status || 500).render('error', {
    title: 'Erreur',
    message: process.env.NODE_ENV === 'production' ? 'Erreur interne du serveur.' : err.message,
    code: err.status || 500,
    user: req.user || null,
  });
});

if (require.main === module) {
  require('./services/environment-deployment').startReconciler();
  require('./services/failover-provisioning').startReconciler();
  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  app.listen(PORT, HOST, () => {
    logger.info({ message: `CNP Portal started on port ${PORT}`, env: process.env.NODE_ENV || 'development' });
  });
}

module.exports = app;
