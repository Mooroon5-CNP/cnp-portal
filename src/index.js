'use strict';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const { createLogger, requestMiddleware } = require('./middleware/logger');
const { populateUser } = require('./middleware/auth');
const { can } = require('./middleware/rbac');

const app = express();
const logger = createLogger();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

app.use(flash());
app.use(requestMiddleware(logger));
app.use(populateUser);

app.use((req, res, next) => {
  res.locals.user = req.user || null;
  res.locals.flash = req.flash();
  res.locals.can = req.user ? (p) => can(req.user, p) : () => false;
  next();
});

// Health checks — no auth required
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/ready',   (req, res) => res.status(200).json({ status: 'ready' }));

app.use('/auth',         require('./routes/auth'));
app.use('/',             require('./routes/dashboard'));
app.use('/deployments',  require('./routes/deployments'));
app.use('/k8s',          require('./routes/k8s'));
app.use('/observability',require('./routes/observability'));
app.use('/argocd',       require('./routes/argocd'));
app.use('/docs',         require('./routes/documentation'));
app.use('/admin',        require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page introuvable', message: 'Cette page n\'existe pas.', code: 404, user: req.user || null });
});

app.use((err, req, res, next) => {
  logger.error({ message: err.message, stack: err.stack, path: req.path });
  res.status(err.status || 500).render('error', {
    title: 'Erreur',
    message: process.env.NODE_ENV === 'production' ? 'Erreur interne du serveur.' : err.message,
    code: err.status || 500,
    user: req.user || null,
  });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info({ message: `CNP Portal started on port ${PORT}`, env: process.env.NODE_ENV || 'development' });
  });
}

module.exports = app;
