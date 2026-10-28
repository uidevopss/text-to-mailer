const express = require('express');
const fs = require('fs');
const path = require('path');
const dns = require('node:dns').promises;
const net = require('node:net');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const HOST = '127.0.0.1';
const PORT = 3210;
const CDP_PORT = 9223;
const ROOT = __dirname;
const BANNERS_DIR = path.join(ROOT, 'generated_banners');
const PROFILE_DIR = path.join(ROOT, '.edge-chatgpt-profile');
fs.mkdirSync(BANNERS_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/generated_banners', express.static(BANNERS_DIR, { maxAge: 0 }));

app.post('/api/save-optimized-banner', async (req, res) => {
  try {
    const dataUri = String(req.body?.dataUri || '');
    const originalFilename = String(req.body?.originalFilename || '');
    const m = dataUri.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ ok:false, message:'AI-1 returned an invalid optimized image payload.' });
    const body = Buffer.from(m[1], 'base64');
    const MAX_BYTES = 900 * 1024;
    if (body.length > MAX_BYTES) {
      return res.status(413).json({ ok:false, message:'AI-1 image is still above the 1 MB limit after optimization.' });
    }

    const filename = `banner-${Date.now()}-650w.jpg`;
    const filePath = path.join(BANNERS_DIR, filename);
    fs.writeFileSync(filePath, body);

    if (originalFilename) {
      const rawPath = path.join(BANNERS_DIR, path.basename(originalFilename));
      if (rawPath !== filePath && fs.existsSync(rawPath)) {
        try { fs.unlinkSync(rawPath); } catch (_) {}
      }
    }

    res.json({ ok:true, filename, size:body.length, imageUrl:`/generated_banners/${encodeURIComponent(filename)}` });
  } catch (err) {
    res.status(500).json({ ok:false, message:`AI-1 local image save failed: ${err.message}` });
  }
});

// Fetch a public brand website's own CSS and sample its visible colour palette.
// The endpoint deliberately rejects private/local IPs and re-validates redirects to prevent SSRF.
function isPrivateOrReservedIp(ip){
  const ver = net.isIP(ip);
  if(ver === 4){
    const a = ip.split('.').map(Number); const [x,y] = a;
    return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) ||
      (x === 100 && y >= 64 && y <= 127) || (x === 192 && y === 0) ||
      (x === 192 && y === 0 && a[2] === 2) || (x === 198 && (y === 18 || y === 19 || y === 51)) ||
      (x === 203 && y === 0 && a[2] === 113) || x >= 224;
  }
  if(ver === 6){
    const s = ip.toLowerCase();
    if(s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff') || s.startsWith('2001:db8')) return true;
    const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if(mapped) return isPrivateOrReservedIp(mapped[1]);
    const first = parseInt(s.split(':')[0] || '0', 16);
    return !(first >= 0x2000 && first <= 0x3fff); // only global-unicast IPv6 is accepted
  }
  return true;
}
async function assertPublicRemoteUrl(input){
  let u;
  try { u = new URL(input); } catch (_) { throw new Error('Please provide a valid website URL.'); }
  if(!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new Error('Only public HTTP/HTTPS website URLs are supported.');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if(!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Local/private website URLs are not allowed.');
  const ipType = net.isIP(host);
  if(ipType){ if(isPrivateOrReservedIp(host)) throw new Error('Local/private IP addresses are not allowed.'); }
  else {
    const records = await dns.lookup(host, { all:true, verbatim:true });
    if(!records.length || records.some(r => isPrivateOrReservedIp(r.address))) throw new Error('This website does not resolve to a public IP address.');
  }
  return u;
}
async function readTextLimited(response, maxBytes){
  if(!response.body) return '';
  const reader = response.body.getReader(); const chunks=[]; let total=0;
  while(true){
    const {done,value} = await reader.read(); if(done) break;
    total += value.byteLength;
    if(total > maxBytes){ try{ await reader.cancel(); }catch(_){} throw new Error('Website stylesheet/page is too large to analyse safely.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function fetchPublicText(rawUrl, kind, maxBytes=1200000){
  let current = new URL(rawUrl);
  for(let hop=0; hop<5; hop++){
    await assertPublicRemoteUrl(current.href);
    const controller = new AbortController(); const timer = setTimeout(()=>controller.abort(), 12000);
    let response;
    try{
      response = await fetch(current.href, {
        redirect:'manual', signal:controller.signal,
        headers:{'User-Agent':'TextToMailerBrandPalette/1.0 (+local user-requested brand colour sampling)','Accept':kind==='css'?'text/css,*/*;q=0.5':'text/html,application/xhtml+xml,*/*;q=0.5'}
      });
    } finally { clearTimeout(timer); }
    if([301,302,303,307,308].includes(response.status)){
      const loc = response.headers.get('location');
      if(!loc) throw new Error('Website returned an incomplete redirect.');
      current = new URL(loc, current); continue;
    }
    if(!response.ok) throw new Error(`Website returned HTTP ${response.status}.`);
    const ct = String(response.headers.get('content-type') || '').toLowerCase();
    if(kind==='css' && ct && !ct.includes('css') && !ct.includes('text/plain')) throw new Error('A linked stylesheet did not return CSS.');
    if(kind==='html' && ct && !(ct.includes('text/html') || ct.includes('xhtml'))) throw new Error('That URL did not return an HTML page.');
    return { text: await readTextLimited(response, maxBytes), url:current.href };
  }
  throw new Error('Website redirected too many times.');
}
function normalizePaletteHex(hex){
  let h=String(hex||'').replace(/^#/,'').toLowerCase();
  if(h.length===3 || h.length===4) h=h.slice(0,3).split('').map(c=>c+c).join('');
  else if(h.length===8) h=h.slice(0,6);
  if(!/^[0-9a-f]{6}$/.test(h)) return null;
  return '#'+h.toUpperCase();
}
function rgbToPaletteHex(r,g,b){ return '#'+[r,g,b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('').toUpperCase(); }
function getSiteColors(source){
  const counts=new Map(); const add=h=>{ const c=normalizePaletteHex(h); if(c) counts.set(c,(counts.get(c)||0)+1); };
  for(const m of source.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/ig)) add(m[1]);
  for(const m of source.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/ig)) add(rgbToPaletteHex(+m[1],+m[2],+m[3]));
  for(const m of source.matchAll(/rgba?\(\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%/ig)) add(rgbToPaletteHex(+m[1]*2.55,+m[2]*2.55,+m[3]*2.55));
  const scored=[...counts.entries()].map(([hex,count])=>{
    const n=parseInt(hex.slice(1),16), r=n>>16, g=(n>>8)&255, b=n&255;
    const max=Math.max(r,g,b)/255, min=Math.min(r,g,b)/255, sat=max===0?0:(max-min)/max, lum=(.299*r+.587*g+.114*b)/255;
    let score=count*(0.55+sat*1.15);
    if(lum<0.08 || lum>0.96) score*=0.35;
    if(sat<0.12) score*=0.6;
    return {hex,count,score,saturation:sat,luminosity:lum};
  });
  let ranked=scored.filter(c=>c.saturation>=0.12 && c.luminosity>0.08 && c.luminosity<0.96).sort((a,b)=>b.score-a.score);
  if(ranked.length<3) ranked=scored.sort((a,b)=>b.score-a.score);
  const out=[];
  for(const c of ranked){
    const rgb=parseInt(c.hex.slice(1),16), r=rgb>>16,g=(rgb>>8)&255,b=rgb&255;
    const tooSimilar=out.some(o=>{
      const nn=parseInt(o.hex.slice(1),16), rr=nn>>16,gg=(nn>>8)&255,bb=nn&255;
      return Math.sqrt((r-rr)**2+(g-gg)**2+(b-bb)**2)<34;
    });
    if(!tooSimilar) out.push({hex:c.hex,count:c.count});
    if(out.length>=5) break;
  }
  return out;
}
app.post('/api/site-palette', async (req,res)=>{
  try{
    const raw = String(req.body?.url || '').trim();
    if(!raw) return res.status(400).json({ok:false,message:'Missing brand website URL.'});
    const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const page = await fetchPublicText(normalized, 'html', 1400000);
    const html = page.text;
    const chunks=[html];
    // Add inline CSS blocks and style attributes.
    for(const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/ig)) chunks.push(m[1]);
    for(const m of html.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/ig)) chunks.push(m[2]);
    // CSS variables and brand colours are commonly kept in linked stylesheets.
    const stylesheetUrls=[];
    for(const m of html.matchAll(/<link\b[^>]*>/ig)){
      const tag=m[0]; const rel=(tag.match(/\brel\s*=\s*(["'])(.*?)\1/i)||[])[2]||'';
      const href=(tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)||[])[2];
      if(/stylesheet/i.test(rel) && href && !href.startsWith('data:')){
        try{ const cssUrl=new URL(href.replace(/&amp;/g,'&'),page.url); if(['http:','https:'].includes(cssUrl.protocol)) stylesheetUrls.push(cssUrl.href); }catch(_){}
      }
    }
    for(const cssUrl of [...new Set(stylesheetUrls)].slice(0,8)){
      try{ const css=await fetchPublicText(cssUrl,'css',1000000); chunks.push(css.text); }
      catch(e){ log('Brand palette skipped stylesheet:', cssUrl, e.message); }
    }
    // Theme colour metadata can be a useful signal when CSS has few explicit colours.
    for(const m of html.matchAll(/<meta\b[^>]*(?:name|property)\s*=\s*(["'])(?:theme-color|msapplication-TileColor|og:site_name)\1[^>]*>/ig)){
      const c=(m[0].match(/\bcontent\s*=\s*(["'])(.*?)\1/i)||[])[2]; if(c) chunks.push(c);
    }
    const colors=getSiteColors(chunks.join('\n'));
    if(!colors.length) return res.status(422).json({ok:false,message:'No usable CSS colours were found on this website.'});
    const domain=new URL(page.url).hostname.replace(/^www\./i,'');
    res.json({ok:true,url:page.url,domain,colors,palette:colors.map(c=>c.hex).join(', '),stylesheetsRead:Math.min([...new Set(stylesheetUrls)].length,8)});
  }catch(err){
    log('Site palette extraction error:', err.message);
    res.status(400).json({ok:false,message:`Could not extract website colours: ${err.message}`});
  }
});

app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'text-to-mailer.html')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(ROOT, 'logo.png')));

let browser = null;
let browserContext = null;
let page = null;
let browserProcess = null;
let busy = false;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function findEdgeExe() {
  const candidates = [
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function connectToEdge() {
  if (browser && browserContext && page && !page.isClosed()) return { browser, browserContext, page };

  const endpoint = `http://${HOST}:${CDP_PORT}`;
  try {
    const versionResp = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!versionResp.ok) throw new Error(`CDP /json/version returned HTTP ${versionResp.status}`);
  } catch (e) {
    log('CDP endpoint probe:', e.message);
  }
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
    browserContext = browser.contexts()[0];
    if (!browserContext) throw new Error('Connected to Microsoft Edge, but no browser context is available.');
    const pages = browserContext.pages();
    page = pages.find(p => !p.isClosed() && /^https:\/\/(www\.)?chatgpt\.com/i.test(p.url()))
      || pages.find(p => !p.isClosed() && !/^devtools:|^chrome-error:/i.test(p.url()))
      || pages[0]
      || await browserContext.newPage();
    wirePage(page);
    log('Connected to Microsoft Edge over CDP:', page.url());
    return { browser, browserContext, page };

  } catch (e) {
    log('CDP not ready:', e.message);
  }

  const edgeExe = findEdgeExe();
  if (!edgeExe) {
    throw new Error('Microsoft Edge executable was not found. Install Microsoft Edge, then run the bridge again.');
  }

  log('Starting a dedicated Microsoft Edge window for ChatGPT…');
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--start-maximized',
    'https://chatgpt.com/'
  ];

  browserProcess = spawn(edgeExe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  browserProcess.unref();

  let lastErr = null;
  for (let i = 0; i < 30; i++) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 2000 });
      browserContext = browser.contexts()[0];
      if (!browserContext) throw new Error('Microsoft Edge is reachable, but Playwright did not expose a browser context yet.');
      const pages = browserContext.pages();
      page = pages.find(p => !p.isClosed() && /^https:\/\/(www\.)?chatgpt\.com/i.test(p.url()))
        || pages.find(p => !p.isClosed() && !/^devtools:|^chrome-error:/i.test(p.url()))
        || pages[0]
        || await browserContext.newPage();
      wirePage(page);
      log('Connected to launched Microsoft Edge:', page.url());
      return { browser, browserContext, page };

    } catch (e) {
      lastErr = e;
      await sleep(1000);
    }
  }
  throw new Error(`Microsoft Edge started but the remote-debugging connection did not become ready on ${endpoint}. ${lastErr?.message || ''}`.trim());
}

function wirePage(p) {
  p.on('pageerror', err => log('pageerror:', err.message));
  p.on('console', msg => {
    if (msg.type() === 'error') log('browser console:', msg.text());
  });
}

async function ensureChatGPTPage() {
  const state = await connectToEdge();
  page = state.page;

  // Never silently swallow navigation errors. about:blank was the main failure mode in V4.
  const url = page.url();
  // Don't yank the tab away while the person is in the middle of signing in (auth.openai.com).
  if (!/^https:\/\/(www\.)?chatgpt\.com/i.test(url) && !/^https:\/\/auth\.openai\.com/i.test(url)) {
    log('Navigating current tab to ChatGPT from:', url);
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await sleep(2000);

  // Some Chromium builds open the tab as about:blank first. Explicitly retry if that happened.
  if (/^about:blank$/i.test(page.url())) {
    await page.goto('https://chatgpt.com/', { waitUntil: 'commit', timeout: 60000 });
    await sleep(2500);
  }

  const finalUrl = page.url();
  if (!/^https:\/\/(www\.)?chatgpt\.com/i.test(finalUrl) && !/^https:\/\/auth\.openai\.com/i.test(finalUrl)) {
    throw new Error(`Ai-1 browser did not open. Current browser URL: ${finalUrl || '(blank)'}`);
  }

  return state;
}

async function findComposer() {
  const selectors = [
    'textarea[placeholder*="Message"]',
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]'
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).filter({ visible: true }).last();
      if (await loc.count()) return loc;
    } catch (_) {}
  }
  return null;
}

async function sendPrompt(prompt) {
  const composer = await findComposer();
  if (!composer) {
    throw new Error('AI-1 browser is open, but the message composer is not available. Log in once in the opened Microsoft Edge window, wait until the home screen loads, then click AI-1 — Generate Image again.');
  }

  await composer.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await composer.fill(prompt);
  } catch (_) {
    await composer.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(prompt, { delay: 0 });
  }

  await sleep(300);
  await page.keyboard.press('Enter');
}

async function getLargeImageSignatures() {
  return page.evaluate(() => Array.from(document.images).map((img, idx) => ({
    idx,
    src: img.currentSrc || img.src || '',
    width: img.naturalWidth || img.width || 0,
    height: img.naturalHeight || img.height || 0,
    complete: !!img.complete,
    visible: !!(img.offsetWidth || img.offsetHeight || img.getClientRects().length)
  })).filter(x => x.visible && x.width >= 500 && x.height >= 300)).catch(() => []);
}

async function waitForNewLargeImage(before, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  const oldSrcs = new Set(before.map(x => x.src).filter(Boolean));
  let last = [];
  while (Date.now() < deadline) {
    await sleep(2000);
    const imgs = await getLargeImageSignatures();
    last = imgs;
    const fresh = imgs.filter(x => x.src && !oldSrcs.has(x.src));
    if (fresh.length) return fresh[fresh.length - 1];
    if (imgs.length > before.length) return imgs[imgs.length - 1];
  }
  throw new Error(`Timed out waiting for AI-1 to produce an image. Visible large images: ${last.length}.`);
}

async function saveImageFromPage(meta) {
  const filename = `banner-${Date.now()}.png`;
  const filePath = path.join(BANNERS_DIR, filename);
  const imgLoc = page.locator('img').nth(meta.idx);
  await imgLoc.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(300);

  // Prefer downloading the image URL through the connected browser context so we keep original bytes.
  if (meta.src && /^https?:/i.test(meta.src)) {
    try {
      const response = await browserContext.request.get(meta.src, { timeout: 30000 });
      if (response.ok()) {
        const contentType = String(response.headers()['content-type'] || '');
        const body = await response.body();
        if (contentType.startsWith('image/') && body.length > 1000) {
          fs.writeFileSync(filePath, body);
          return { filename, filePath, size: body.length, method: 'original-url' };
        }
      }
    } catch (e) {
      log('Original image download failed, falling back to screenshot:', e.message);
    }
  }

  await imgLoc.screenshot({ path: filePath });
  const stat = fs.statSync(filePath);
  if (stat.size < 1000) throw new Error('The captured banner image is unexpectedly small.');
  return { filename, filePath, size: stat.size, method: 'screenshot' };
}

async function getChatGPTSessionStatus(){
  // Never touch the tab while a banner is being generated.
  if (busy) return { loggedIn: true, hasLoginUi: false, url: page && !page.isClosed() ? page.url() : '', busy: true };
  const state = await ensureChatGPTPage();
  page = state.page;
  await sleep(900);
  const composer = await findComposer();
  // ChatGPT shows a composer even when logged out, so also look for visible Log in / Sign up controls.
  let hasLoginUi = false;
  try {
    const n = await page.locator('[data-testid="login-button"], [data-testid="signup-button"], a[href*="/auth/login"]').filter({ visible: true }).count();
    const m = await page.getByRole('button', { name: /^(log in|sign up)$/i }).filter({ visible: true }).count();
    hasLoginUi = n + m > 0;
  } catch (_) {}
  const loggedIn = !!composer && !hasLoginUi && !/^https:\/\/auth\.openai\.com/i.test(page.url());
  return { loggedIn, hasLoginUi, url: page.url() };
}

app.get('/api/startup-check', async (req, res) => {
  try {
    const session = await getChatGPTSessionStatus();
    res.json({ ok: true, loggedIn: session.loggedIn, url: session.url, hasLoginUi: session.hasLoginUi });
  } catch (err) {
    log('Startup check error:', err.message);
    res.status(500).json({ ok:false, loggedIn:false, message:err.message });
  }
});

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    busy,
    browserOpen: !!(page && !page.isClosed()),
    pageUrl: page && !page.isClosed() ? page.url() : null,
    bannerDir: BANNERS_DIR,
    edgeExecutable: findEdgeExe(),
    cdpPort: CDP_PORT,
    browserConnected: !!browser,
    browserContextReady: !!browserContext
  });
});

app.post('/api/open-chatgpt', async (req, res) => {
  try {
    await ensureChatGPTPage();
    res.json({ ok: true, url: page.url() });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/chatgpt-banner', async (req, res) => {
  if (busy) return res.status(409).json({ ok: false, message: 'An AI-1 image is already being generated. Wait for it to finish.' });
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ ok: false, message: 'Missing prompt.' });

  busy = true;
  try {
    await ensureChatGPTPage();
    const before = await getLargeImageSignatures();
    await sendPrompt(prompt);
    log('Prompt sent. Waiting for a new large image…');
    const imageMeta = await waitForNewLargeImage(before, 180000);
    const saved = await saveImageFromPage(imageMeta);

    res.json({
      ok: true,
      filename: saved.filename,
      size: saved.size,
      method: saved.method,
      imageUrl: `/generated_banners/${encodeURIComponent(saved.filename)}`
    });
  } catch (err) {
    log('Generation error:', err.message);
    res.status(500).json({
      ok: false,
      message: `${err.message} The Microsoft Edge window is left open so you can finish the Ai-1 session once, then try again.`
    });
  } finally {
    busy = false;
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Text-to-Mailer Ai Bridge V18 (Microsoft Edge) running at http://${HOST}:${PORT}`);
  console.log(`Generated banners are saved to: ${BANNERS_DIR}`);
  console.log(`A dedicated Microsoft Edge profile is used at: ${PROFILE_DIR}`);
  console.log('The dedicated Edge profile keeps the session cookies so the same session is reused on later runs.');
});
