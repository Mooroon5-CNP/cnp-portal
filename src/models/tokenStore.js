'use strict';

// Server-side token store keyed by userId.
// Tokens are NEVER sent to the browser.
// Post-MVP: store in Redis or encrypted DB column.
const store = new Map();

function set(userId, tokens) {
  store.set(userId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt || null,
  });
}

function get(userId) {
  return store.get(userId) || null;
}

function remove(userId) {
  store.delete(userId);
}

module.exports = { set, get, remove };
