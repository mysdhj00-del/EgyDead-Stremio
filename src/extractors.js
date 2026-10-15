'use strict';
/**
 * Minimal direct-link extractors for the mirror hosts EgyDead's MegaMax
 * player lists. Verified live from the sandbox on 2026-10-15 against a real
 * movie (Street Fighter 2026): a plain scan + a Dean-Edwards unpack pass
 * yields playable .m3u8/.mp4 URLs for VidMoly, VidHide/StreamWish family,
 * StreamRuby, Byse, Vidara and Uqload mirrors. Doodstream and MixDrop do
 * not expose a direct file this way, so they fall back to externalUrl.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchText(url, referer, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
    });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function unescapeText(t) {
  return t
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

const FILE_RE = /https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;

function findFiles(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  for (const raw of [text, unescapeText(text)]) {
    for (const m of raw.matchAll(FILE_RE)) {
      const u = m[0].replace(/["',]+$/, '');
      // Skip sample/preview/thumbnail files some hosts embed in the page.
      if (/sample|preview|trailer|\/thumb|sprite/i.test(u)) continue;
      if (!seen.has(u)) { seen.add(u); out.push(u); }
    }
    // MixDrop-style: wurl = "//host/path.mp4"
    for (const m of raw.matchAll(/wurl\s*=\s*["']([^"']+)["']/g)) {
      let u = m[1];
      if (u.startsWith('//')) u = 'https:' + u;
      if (/^https?:\/\//.test(u) && !seen.has(u)) { seen.add(u); out.push(u); }
    }
  }
  return out;
}

/** Dean Edwards p.a.c.k.e.r unpacker (eval(function(p,a,c,k,e,d){...}))). */
function unpackPacked(text) {
  const m = /eval\(function\(p,a,c,k,e,[rd]\)[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/.exec(text);
  if (!m) return null;
  const payload = m[1].replace(/\\'/g, "'");
  const radix = parseInt(m[2], 10);
  const keywords = m[4].split('|');
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function decodeWord(word) {
    let n = 0;
    for (const ch of word) {
      const idx = chars.indexOf(ch);
      if (idx < 0) return null;
      n = n * radix + idx;
    }
    return n;
  }
  return payload.replace(/\b[0-9a-zA-Z]+\b/g, (word) => {
    const n = decodeWord(word);
    if (n !== null && n < keywords.length && keywords[n]) return keywords[n];
    return word;
  });
}

function hostName(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    const known = [
      [/voe\./, 'Voe'], [/vidmoly|vidmoli/, 'VidMoly'], [/mixdrop/, 'MixDrop'],
      [/dood|ds2play|d0o0d/, 'Doodstream'], [/streamwish|streamhg|wishonly|vidhide|filemoon|earnvids/, 'VidHide'],
      [/uqload/, 'Uqload'], [/vidara|vidar/, 'Vidara'], [/byse/, 'Byse'],
      [/streamruby|stmruby|ruby/, 'StreamRuby'], [/vidspeed|vidaraa/, 'Vidara'],
    ];
    for (const [re, name] of known) if (re.test(h)) return name;
    return h;
  } catch {
    return 'Server';
  }
}

/**
 * Try to resolve one embed URL to direct playable files.
 * Returns [{ url, kind: 'm3u8'|'mp4' }] (possibly empty).
 */
async function extractDirect(embed, referer) {
  let text;
  try {
    text = await fetchText(embed, referer);
  } catch {
    return [];
  }
  let files = findFiles(text);
  if (files.length === 0) {
    const unpacked = unpackPacked(text);
    if (unpacked) files = findFiles(unpacked);
  }
  // Prefer HLS masters, then any mp4.
  files.sort((a, b) => score(b) - score(a));
  return files.slice(0, 3).map((u) => ({
    url: u,
    kind: u.includes('.m3u8') ? 'm3u8' : 'mp4',
  }));

  function score(u) {
    let s = 0;
    if (u.includes('.m3u8')) s += 4;
    if (/master|playlist|index/.test(u)) s += 2;
    if (u.includes('.mp4')) s += 1;
    return s;
  }
}

module.exports = { extractDirect, hostName, findFiles, unpackPacked, fetchText };
