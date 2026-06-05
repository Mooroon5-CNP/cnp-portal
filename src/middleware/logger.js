'use strict';

const winston = require('winston');

function createLogger() {
  return winston.createLogger({
    level: (process.env.LOG_LEVEL || 'INFO').toLowerCase(),
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    defaultMeta: {
      service: process.env.DD_SERVICE || 'cnp-portal',
      version: process.env.DD_VERSION || '1.0.0',
      env: process.env.DD_ENV || 'dev',
    },
    transports: [new winston.transports.Console()],
  });
}

function requestMiddleware(logger) {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info({
        message: 'http request',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - start,
        user: req.session && req.session.gitlabUsername,
      });
    });
    next();
  };
}

module.exports = { createLogger, requestMiddleware };
