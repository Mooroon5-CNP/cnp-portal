'use strict';

// Browser CSRF defense across form/API writes; MCP also requires its session token.
// Non-browser clients without browser headers still need route authentication.
function browserWriteGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).send('Cross-site write refused.');
  const source = req.get('origin') || req.get('referer');
  if (source) {
    try {
      if (new URL(source).origin !== `${req.protocol}://${req.get('host')}`) {
        return res.status(403).send('Cross-origin write refused.');
      }
    } catch (_) { return res.status(403).send('Invalid request origin.'); }
  }
  next();
}
module.exports = { browserWriteGuard };
