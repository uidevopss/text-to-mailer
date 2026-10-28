'use strict';

const express = require('express');
const dns = require('node:dns').promises;
const net = require('node:net');

const router = express.Router();
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;
const MAX_HTML_BYTES = 1_400_000;
const MAX_CSS_BYTES = 1_000_000;
const MAX_STYLESHEETS = 8;

function isPrivateOrReservedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const a = ip.split('.').map(Number);
    const [x, y, z] = a;
    return x === 0 || x === 10 || x === 127 ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 192 && y === 0) ||
      (x === 192 && y === 0 && z === 2) ||
      (x === 198 && (y === 18 || y === 19 || y === 51)) ||
      (x === 203 && y === 0 && z === 113) ||
      x >= 224;
  }

  if (version === 6) {
    const value = ip.toLowerCase();
    if (value === '::' || value === '::1' || value.startsWith('fc') ||
        value.startsWith('fd') || value.startsWith('fe8') ||
        value.startsWith('fe9') || value.startsWith('fea') ||
        value.startsWith('feb') || value.startsWith('ff') ||
        value.startsWith('2001:db8')) return true;

    const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPrivateOrReservedIp(mapped[1]);

    const first = parseInt(value.split(':')[0] || '0', 16);
    // Accept only global-unicast IPv6 addresses.
    return !(first >= 0x2000 && first <= 0x3fff);
  }

  return true;
}

async function assertPublicRemoteUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Please provide a valid website URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP/HTTPS website URLs are supported.');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Local/private website URLs are not allowed.');
  }

  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) throw new Error('Local/private IP addresses are not allowed.');
    return url;
  }

  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => isPrivateOrReservedIp(record.address))) {
    throw new Error('This website does not resolve exclusively to public IP addresses.');
  }

  return url;
}

async function readTextLimited(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error('Website stylesheet/page is too large to analyse safely.');
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function fetchPublicText(rawUrl, kind, maxBytes) {
  let current = new URL(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Validate every hop and reject redirects to private/local destinations.
    await assertPublicRemoteUrl(current.href);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(current.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'TextToMailerBrandPalette/1.0',
          Accept: kind === 'css'
            ? 'text/css, text/plain;q=0.8, */*;q=0.2'
            : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2'
        }
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Website request timed out.');
      throw new Error('Could not fetch the requested website.');
    } finally {
      clearTimeout(timer);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Website returned an incomplete redirect.');
      if (hop === MAX_REDIRECTS) throw new Error('Website redirected too many times.');
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) throw new Error(`Website returned HTTP ${response.status}.`);

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (kind === 'css' && contentType &&
        !contentType.includes('css') && !contentType.includes('text/plain')) {
      throw new Error('A linked stylesheet did not return CSS.');
    }
    if (kind === 'html' && contentType &&
        !contentType.includes('text/html') && !contentType.includes('xhtml')) {
      throw new Error('That URL did not return an HTML page.');
    }

    return { text: await readTextLimited(response, maxBytes), url: current.href };
  }

  throw new Error('Website redirected too many times.');
}

function normalizePaletteHex(hex) {
  let value = String(hex || '').replace(/^#/, '').toLowerCase();
  if (value.length === 3 || value.length === 4) value = value.slice(0, 3).split('').map(char => char + char).join('');
  else if (value.length === 8) value = value.slice(0, 6);
  if (!/^[0-9a-f]{6}$/.test(value)) return null;
  return `#${value.toUpperCase()}`;
}

function rgbToPaletteHex(r, g, b) {
  return '#' + [r, g, b]
    .map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
    .join('').toUpperCase();
}

function getSiteColors(source) {
  const counts = new Map();
  const add = hex => {
    const color = normalizePaletteHex(hex);
    if (color) counts.set(color, (counts.get(color) || 0) + 1);
  };

  for (const match of source.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/ig)) add(match[1]);
  for (const match of source.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/ig)) {
    add(rgbToPaletteHex(+match[1], +match[2], +match[3]));
  }
  for (const match of source.matchAll(/rgba?\(\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%/ig)) {
    add(rgbToPaletteHex(+match[1] * 2.55, +match[2] * 2.55, +match[3] * 2.55));
  }

  const scored = [...counts.entries()].map(([hex, count]) => {
    const number = parseInt(hex.slice(1), 16);
    const r = number >> 16;
    const g = (number >> 8) & 255;
    const b = number & 255;
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const saturation = max === 0 ? 0 : (max - min) / max;
    const luminosity = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    let score = count * (0.55 + saturation * 1.15);
    if (luminosity < 0.08 || luminosity > 0.96) score *= 0.35;
    if (saturation < 0.12) score *= 0.6;
    return { hex, count, score, saturation, luminosity };
  });

  let ranked = scored
    .filter(color => color.saturation >= 0.12 && color.luminosity > 0.08 && color.luminosity < 0.96)
    .sort((a, b) => b.score - a.score);
  if (ranked.length < 3) ranked = scored.sort((a, b) => b.score - a.score);

  const output = [];
  for (const color of ranked) {
    const number = parseInt(color.hex.slice(1), 16);
    const r = number >> 16;
    const g = (number >> 8) & 255;
    const b = number & 255;
    const tooSimilar = output.some(existing => {
      const other = parseInt(existing.hex.slice(1), 16);
      const rr = other >> 16;
      const gg = (other >> 8) & 255;
      const bb = other & 255;
      return Math.sqrt((r - rr) ** 2 + (g - gg) ** 2 + (b - bb) ** 2) < 34;
    });

    if (!tooSimilar) output.push({ hex: color.hex, count: color.count });
    if (output.length >= 5) break;
  }
  return output;
}

function decodeHtmlAttribute(value) {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
}

router.post('/site-palette', async (req, res) => {
  try {
    const raw = String(req.body?.url || '').trim();
    if (!raw) return res.status(400).json({ ok: false, message: 'Missing brand website URL.' });

    const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const page = await fetchPublicText(normalized, 'html', MAX_HTML_BYTES);
    const html = page.text;
    const chunks = [html];

    for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/ig)) chunks.push(match[1]);
    for (const match of html.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/ig)) chunks.push(match[2]);

    const stylesheetUrls = [];
    for (const match of html.matchAll(/<link\b[^>]*>/ig)) {
      const tag = match[0];
      const rel = (tag.match(/\brel\s*=\s*(["'])(.*?)\1/i) || [])[2] || '';
      const href = (tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i) || [])[2];
      if (/stylesheet/i.test(rel) && href && !/^data:/i.test(href)) {
        try {
          const cssUrl = new URL(decodeHtmlAttribute(href), page.url);
          if (['http:', 'https:'].includes(cssUrl.protocol)) stylesheetUrls.push(cssUrl.href);
        } catch {}
      }
    }

    const uniqueStylesheets = [...new Set(stylesheetUrls)].slice(0, MAX_STYLESHEETS);
    for (const cssUrl of uniqueStylesheets) {
      try {
        const css = await fetchPublicText(cssUrl, 'css', MAX_CSS_BYTES);
        chunks.push(css.text);
      } catch (error) {
        console.warn('Skipping stylesheet:', error.message);
      }
    }

    for (const match of html.matchAll(/<meta\b[^>]*(?:name|property)\s*=\s*(["'])(?:theme-color|msapplication-TileColor)\1[^>]*>/ig)) {
      const content = (match[0].match(/\bcontent\s*=\s*(["'])(.*?)\1/i) || [])[2];
      if (content) chunks.push(content);
    }

    const colors = getSiteColors(chunks.join('\n'));
    if (!colors.length) {
      return res.status(422).json({ ok: false, message: 'No usable CSS colours were found on this website.' });
    }

    const domain = new URL(page.url).hostname.replace(/^www\./i, '');
    return res.json({
      ok: true,
      url: page.url,
      domain,
      colors,
      palette: colors.map(color => color.hex).join(', '),
      stylesheetsRead: uniqueStylesheets.length
    });
  } catch (error) {
    console.warn('Site palette extraction error:', error.message);
    const clientError = /valid website URL|Only public|Local\/private|does not resolve|redirected too many|timed out|too large|HTTP \d+|did not return|No usable/i.test(error.message);
    return res.status(clientError ? 400 : 502).json({
      ok: false,
      message: `Could not extract website colours: ${error.message}`
    });
  }
});

module.exports = router;
