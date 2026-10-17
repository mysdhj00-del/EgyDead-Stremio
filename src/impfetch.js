'use strict';
/**
 * Chrome-impersonating fetch (impit) — shared singleton.
 *
 * Since 2026-10-17, egydead.live sits behind a Cloudflare fingerprint
 * check: plain clients (undici fetch, okhttp, curl) receive the "Just a
 * moment..." 403 page, while a client presenting a genuine Chrome
 * TLS/HTTP2 fingerprint passes with 200 and full content (verified live
 * from the sandbox with both curl-impersonate and impit). Every fetch
 * that targets the EgyDead site (and, harmlessly, its MegaMax mirrors)
 * goes through this wrapper; other relays keep the plain fetcher.
 */
let client = null;

function impFetch(url, opts = {}) {
  if (!client) {
    const { Impit } = require('impit');
    client = new Impit({ browser: 'chrome' });
  }
  return client.fetch(url, opts);
}

module.exports = { impFetch };
