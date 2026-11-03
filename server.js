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
const SITE_SCREENSHOTS_DIR = path.join(ROOT, 'brand_site_screenshots');
const PROFILE_DIR = path.join(ROOT, '.edge-chatgpt-profile');
fs.mkdirSync(BANNERS_DIR, { recursive: true });
fs.mkdirSync(SITE_SCREENSHOTS_DIR, { recursive: true });
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
app.use('/site-screenshots', express.static(SITE_SCREENSHOTS_DIR, { maxAge: 0 }));

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
// Sample dominant brand colours from an actual screenshot, using canvas pixel data.
// Sampling favours saturated colours and gives the top/header region extra weight.
async function sampleScreenshotPalette(pngBuffer, context){
  const sampler = await context.newPage();
  try{
    await sampler.goto('about:blank');
    const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
    return await sampler.evaluate(async (src)=>{
      const img = new Image(); img.src = src; await img.decode();
      const maxW=420, maxH=340, scale=Math.min(1,maxW/img.naturalWidth,maxH/img.naturalHeight);
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));
      canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      const counts=new Map();
      for(let y=0;y<canvas.height;y+=2){
        for(let x=0;x<canvas.width;x+=2){
          const i=(y*canvas.width+x)*4, a=pixels[i+3]; if(a<220) continue;
          const r=pixels[i],g=pixels[i+1],b=pixels[i+2];
          const mx=Math.max(r,g,b)/255, mn=Math.min(r,g,b)/255;
          const sat=mx===0?0:(mx-mn)/mx, lum=(.299*r+.587*g+.114*b)/255;
          // Pure white and near-black are generally layout neutrals, not brand accents.
          if(lum>.965 || lum<.045 || sat<.13) continue;
          const qr=Math.min(255,Math.round(r/16)*16), qg=Math.min(255,Math.round(g/16)*16), qb=Math.min(255,Math.round(b/16)*16);
          const hex='#'+[qr,qg,qb].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
          const headerBoost=y<canvas.height*.23?2.0:1.0;
          const score=headerBoost*(.55+sat*1.35)*(lum>.88?.55:1);
          const old=counts.get(hex)||{hex,count:0,score:0}; old.count+=1; old.score+=score; counts.set(hex,old);
        }
      }
      let ranked=[...counts.values()].sort((a,b)=>b.score-a.score);
      if(ranked.length<3){
        for(let y=0;y<canvas.height;y+=3){for(let x=0;x<canvas.width;x+=3){
          const i=(y*canvas.width+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
          const hex='#'+[r,g,b].map(v=>Math.round(v/16)*16).map(v=>Math.min(255,v).toString(16).padStart(2,'0')).join('').toUpperCase();
          const old=counts.get(hex)||{hex,count:0,score:0}; old.count+=.25; old.score+=.25; counts.set(hex,old);
        }}
        ranked=[...counts.values()].sort((a,b)=>b.score-a.score);
      }
      const out=[];
      for(const c of ranked){
        const rgb=parseInt(c.hex.slice(1),16),r=rgb>>16,g=(rgb>>8)&255,b=rgb&255;
        const tooSimilar=out.some(o=>{const n=parseInt(o.hex.slice(1),16),rr=n>>16,gg=(n>>8)&255,bb=n&255;return Math.sqrt((r-rr)**2+(g-gg)**2+(b-bb)**2)<38;});
        if(!tooSimilar) out.push({hex:c.hex,count:Math.round(c.count)});
        if(out.length>=5) break;
      }
      return out;
    }, dataUrl);
  } finally { await sampler.close().catch(()=>{}); }
}

function isObviouslyPrivateHost(hostname){
  const h=String(hostname||'').toLowerCase().replace(/^\[|\]$/g,'');
  if(h==='localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if(net.isIP(h)) return isPrivateOrReservedIp(h);
  return false;
}

async function capturePublicWebsiteScreenshot(rawUrl){
  const initial=await assertPublicRemoteUrl(rawUrl);
  const edgeExe=findEdgeExe();
  if(!edgeExe) throw new Error('Microsoft Edge was not found; screenshot palette sampling is unavailable.');
  // Use a disposable, isolated headless Edge instance for public-site screenshots. This keeps
  // the user's persistent ChatGPT login/profile untouched and avoids changing their visible tabs.
  const screenshotBrowser=await chromium.launch({
    executablePath:edgeExe, headless:true,
    args:['--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions']
  });
  const screenshotContext=await screenshotBrowser.newContext({viewport:{width:1365,height:1000},deviceScaleFactor:1});
  const sitePage=await screenshotContext.newPage();
  const host=initial.hostname.replace(/^www\./i,'').replace(/[^a-z0-9.-]/gi,'-');
  const filename=`brand-site-${host}-${Date.now()}.png`;
  const screenshotPath=path.join(SITE_SCREENSHOTS_DIR,filename);
  try{
    sitePage.setDefaultNavigationTimeout(35000);
    sitePage.setDefaultTimeout(10000);
    // Validate every network request to prevent the supplied site or its resources from reaching private services.
    await sitePage.route('**/*', async route=>{
      const req=route.request(), reqUrl=req.url();
      try{
        const u=new URL(reqUrl);
        if(['data:','blob:','about:'].includes(u.protocol)) return await route.continue();
        if(!['http:','https:'].includes(u.protocol)) return await route.abort();
        if(isObviouslyPrivateHost(u.hostname)) return await route.abort();
        await assertPublicRemoteUrl(reqUrl);
        return await route.continue();
      }catch(_){ return await route.abort().catch(()=>{}); }
    });
    await sitePage.goto(initial.href,{waitUntil:'domcontentloaded',timeout:35000});
    await sitePage.waitForTimeout(1800);
    // Wait briefly for visible fonts and hero assets, but do not stall on analytics/network-idle loops.
    await sitePage.evaluate(async()=>{try{if(document.fonts?.ready) await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1200))]);}catch(_){}});
    const finalUrl=sitePage.url(); await assertPublicRemoteUrl(finalUrl);
    await sitePage.evaluate(()=>window.scrollTo(0,0)).catch(()=>{});
    const png=await sitePage.screenshot({type:'png',fullPage:false,animations:'disabled',timeout:20000});
    fs.writeFileSync(screenshotPath,png);
    const colors=await sampleScreenshotPalette(png,screenshotContext);
    if(!colors || !colors.length) throw new Error('Screenshot captured, but no usable accent colours could be sampled.');
    return {colors,filename,screenshotUrl:`/site-screenshots/${encodeURIComponent(filename)}`,url:finalUrl,domain:new URL(finalUrl).hostname.replace(/^www\./i,''),screenshotBytes:png.length};
  }catch(err){
    try{if(fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);}catch(_){}
    throw err;
  }finally{
    await sitePage.close().catch(()=>{});
    await screenshotBrowser.close().catch(()=>{});
  }
}

async function extractCssPalette(rawUrl){
  const pageInfo=await fetchPublicText(rawUrl,'html',1400000);
  const html=pageInfo.text, chunks=[html];
  for(const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/ig)) chunks.push(m[1]);
  for(const m of html.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/ig)) chunks.push(m[2]);
  const stylesheetUrls=[];
  for(const m of html.matchAll(/<link\b[^>]*>/ig)){
    const tag=m[0],rel=(tag.match(/\brel\s*=\s*(["'])(.*?)\1/i)||[])[2]||'';
    const href=(tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)||[])[2];
    if(/stylesheet/i.test(rel)&&href&&!href.startsWith('data:')){
      try{const cssUrl=new URL(href.replace(/&amp;/g,'&'),pageInfo.url);if(['http:','https:'].includes(cssUrl.protocol))stylesheetUrls.push(cssUrl.href);}catch(_){}
    }
  }
  for(const cssUrl of [...new Set(stylesheetUrls)].slice(0,8)){
    try{const css=await fetchPublicText(cssUrl,'css',1000000);chunks.push(css.text);}catch(e){log('Brand palette skipped stylesheet:',cssUrl,e.message);}
  }
  for(const m of html.matchAll(/<meta\b[^>]*(?:name|property)\s*=\s*(["'])(?:theme-color|msapplication-TileColor|og:site_name)\1[^>]*>/ig)){
    const c=(m[0].match(/\bcontent\s*=\s*(["'])(.*?)\1/i)||[])[2];if(c)chunks.push(c);
  }
  const colors=getSiteColors(chunks.join('\n'));
  if(!colors.length) throw new Error('No usable CSS colours were found on this website.');
  const finalUrl=pageInfo.url;
  return {colors,url:finalUrl,domain:new URL(finalUrl).hostname.replace(/^www\./i,''),stylesheetsRead:Math.min([...new Set(stylesheetUrls)].length,8)};
}

app.post('/api/site-palette', async (req,res)=>{
  try{
    const raw=String(req.body?.url||'').trim();
    if(!raw) return res.status(400).json({ok:false,message:'Missing brand website URL.'});
    const normalized=/^https?:\/\//i.test(raw)?raw:`https://${raw}`;
    // Primary path: render the website in Edge, take a screenshot, and sample the actual visible pixels.
    try{
      const shot=await capturePublicWebsiteScreenshot(normalized);
      const result={ok:true,method:'screenshot',...shot,palette:shot.colors.map(c=>c.hex).join(', ')};
      log('Brand palette sampled from website screenshot:', result.domain, result.palette);
      return res.json(result);
    }catch(screenshotError){
      log('Screenshot-based brand palette failed; trying CSS fallback:', screenshotError.message);
      try{
        const css=await extractCssPalette(normalized);
        return res.json({ok:true,method:'css-fallback',...css,palette:css.colors.map(c=>c.hex).join(', '),screenshotWarning:screenshotError.message});
      }catch(cssError){
        return res.status(422).json({ok:false,message:`Screenshot sampling failed (${screenshotError.message}); CSS fallback failed (${cssError.message}).`});
      }
    }
  }catch(err){
    log('Site palette extraction error:',err.message);
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
  await dismissChatGPTPromotionalAd();

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

// ChatGPT may insert a promotional card above the composer/output. Dismiss that
// specific card so it cannot obscure an image or appear in a screenshot fallback.
async function dismissChatGPTPromotionalAd() {
  if (!page || page.isClosed()) return false;
  try {
    const dismissed = await page.evaluate(() => {
      const promoRe = /create your first chatgpt ad in minutes|start advertising on chatgpt/i;
      const leaves = Array.from(document.querySelectorAll('body *')).filter(el =>
        el.children.length === 0 && promoRe.test((el.textContent || '').trim())
      );
      for (const leaf of leaves) {
        let node = leaf;
        for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
          const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ');
          if (!/create your first chatgpt ad in minutes/i.test(text) || !/start advertising on chatgpt/i.test(text)) continue;
          const rootRect = node.getBoundingClientRect();
          if (rootRect.width < 350 || rootRect.height > 500) continue;
          const buttons = Array.from(node.querySelectorAll('button,[role="button"]')).filter(btn => {
            const r = btn.getBoundingClientRect();
            const style = window.getComputedStyle(btn);
            return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          });
          const closeButton = buttons.find(btn => {
            const label = [btn.getAttribute('aria-label'), btn.getAttribute('title'), btn.getAttribute('data-testid'), btn.innerText, btn.textContent]
              .filter(Boolean).join(' ').trim();
            return /close|dismiss|hide/i.test(label) || /^(x|×|✕|✖)$/i.test(label);
          }) || buttons
            .filter(btn => {
              const r = btn.getBoundingClientRect();
              const label = [btn.getAttribute('aria-label'), btn.getAttribute('title'), btn.innerText, btn.textContent].filter(Boolean).join(' ').trim();
              return r.width <= 64 && r.height <= 64 && r.right >= rootRect.right - 72 && !/start advertising/i.test(label);
            })
            .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
          if (closeButton) {
            closeButton.click();
            return true;
          }
        }
      }
      return false;
    });
    if (dismissed) {
      log('Dismissed the ChatGPT advertising promo card to protect image capture.');
      await sleep(350);
    }
    return dismissed;
  } catch (err) {
    log('Could not dismiss ChatGPT promo card (continuing safely):', err.message);
    return false;
  }
}

async function getLargeImageSignatures() {
  return page.evaluate(() => Array.from(document.images).map((img, idx) => ({
    idx,
    src: img.currentSrc || img.src || '',
    width: img.naturalWidth || img.width || 0,
    height: img.naturalHeight || img.height || 0,
    complete: !!img.complete,
    assistantOutput: !!img.closest('[data-message-author-role="assistant"]'),
    visible: !!(img.offsetWidth || img.offsetHeight || img.getClientRects().length)
  })).filter(x => x.visible && x.width >= 500 && x.height >= 300)).catch(() => []);
}

async function waitForNewLargeImage(before, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  const oldSrcs = new Set(before.map(x => x.src).filter(Boolean));
  let last = [];
  while (Date.now() < deadline) {
    await sleep(1200);
    await dismissChatGPTPromotionalAd();
    const imgs = await getLargeImageSignatures();
    last = imgs;
    const fresh = imgs.filter(x => x.src && !oldSrcs.has(x.src));
    const assistantFresh = fresh.filter(x => x.assistantOutput);
    if (assistantFresh.length) return assistantFresh[assistantFresh.length - 1];
    if (fresh.length) return fresh[fresh.length - 1];
    const assistantImgs = imgs.filter(x => x.assistantOutput && !oldSrcs.has(x.src));
    if (assistantImgs.length) return assistantImgs[assistantImgs.length - 1];
    if (imgs.length > before.length) return imgs[imgs.length - 1];
  }
  throw new Error(`Timed out waiting for a new AI-1 image in the conversation. Visible large images: ${last.length}.`);
}

async function saveImageFromPage(meta) {
  const filename = `banner-${Date.now()}.png`;
  const filePath = path.join(BANNERS_DIR, filename);
  // Close the promo before touching the image; otherwise a screenshot fallback may include it.
  await dismissChatGPTPromotionalAd();
  const imgLoc = page.locator('img').nth(meta.idx);
  await imgLoc.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(500);

  // Prefer the actual generated image resource, never a screenshot of the whole ChatGPT page.
  if (meta.src && /^https?:/i.test(meta.src)) {
    try {
      const response = await browserContext.request.get(meta.src, { timeout: 30000 });
      if (!response.ok()) log('Original image URL returned HTTP', response.status());
      if (response.ok()) {
        const contentType = String(response.headers()['content-type'] || '');
        const body = await response.body();
        if (contentType.startsWith('image/') && body.length > 1000) {
          fs.writeFileSync(filePath, body);
          return { filename, filePath, size: body.length, method: 'original-url' };
        }
      }
    } catch (e) {
      log('Original image download failed, will capture only the image element:', e.message);
    }
  }

  // Fallback 1: read the image bytes from inside the ChatGPT page (uses the logged-in session),
  // so no UI overlay (composer bar, download button) can ever be part of the saved image.
  try {
    const dataUrl = await imgLoc.evaluate(async (img) => {
      const src = img.currentSrc || img.src;
      try {
        const r = await fetch(src, { credentials: 'include' });
        if (r.ok) {
          const blob = await r.blob();
          if (blob.type.startsWith('image/') && blob.size > 1000) {
            return await new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = rej;
              fr.readAsDataURL(blob);
            });
          }
        }
      } catch (_) {}
      // Canvas redraw of the decoded image (works if the image is not cross-origin tainted)
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    });
    const m = String(dataUrl || '').match(/^data:image\/[a-z+.-]+;base64,(.+)$/i);
    if (m) {
      const body = Buffer.from(m[1], 'base64');
      if (body.length > 1000) {
        fs.writeFileSync(filePath, body);
        return { filename, filePath, size: body.length, method: 'in-page-fetch' };
      }
    }
  } catch (e) {
    log('In-page image read failed, will use a cleaned element screenshot:', e.message);
  }

  // Fallback 2: element screenshot. First hide EVERY element that is painted on top of the image
  // (Edit / download / share buttons, composer bar, tooltips...). We find them by asking the browser
  // what is actually stacked above the image at a grid of points, so no class names are guessed.
  log('Image bytes could not be read directly; using cleaned element screenshot.');
  const HIDE_ATTR = 'data-ttm-hidden-overlay';
  await page.mouse.move(2, 2).catch(() => {});
  const hiddenCount = await imgLoc.evaluate(async (img, attr) => {
    let total = 0;
    const hide = el => {
      if (el.hasAttribute(attr)) return;
      el.setAttribute(attr, el.style.getPropertyValue('visibility') || ' ');
      el.style.setProperty('visibility', 'hidden', 'important');
      total++;
    };
    for (let pass = 0; pass < 4; pass++) {
      img.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise(r => setTimeout(r, 150));
      const r = img.getBoundingClientRect();
      const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, innerWidth);
      const y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, innerHeight);
      let found = 0;
      for (let i = 0; i <= 24; i++) {
        for (let j = 0; j <= 12; j++) {
          const x = Math.min(x1 - 1, x0 + (x1 - x0) * i / 24);
          const y = Math.min(y1 - 1, y0 + (y1 - y0) * j / 12);
          const stack = document.elementsFromPoint(x, y);
          const idx = stack.indexOf(img);
          if (idx <= 0) continue;                       // nothing above the image here
          for (const el of stack.slice(0, idx)) {
            if (el === document.documentElement || el === document.body) continue;
            if (el.contains(img)) continue;
            hide(el); found++;
          }
        }
      }
      if (!found) break;
    }
    return total;
  }, HIDE_ATTR).catch(e => { log('Overlay scan failed:', e.message); return 0; });
  log(`Hid ${hiddenCount} overlay element(s) above the image before capture.`);
  await sleep(300);
  try {
    await imgLoc.screenshot({ path: filePath, animations: 'disabled', timeout: 30000 });
  } finally {
    await page.evaluate((attr) => {
      document.querySelectorAll('[' + attr + ']').forEach(el => {
        const v = el.getAttribute(attr).trim();
        if (v) el.style.setProperty('visibility', v); else el.style.removeProperty('visibility');
        el.removeAttribute(attr);
      });
    }, HIDE_ATTR).catch(() => {});
  }
  const stat = fs.statSync(filePath);
  if (stat.size < 1000) throw new Error('The captured banner image is unexpectedly small.');
  return { filename, filePath, size: stat.size, method: 'image-element-screenshot' };
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
    await dismissChatGPTPromotionalAd();
    const before = await getLargeImageSignatures();
    await sendPrompt(prompt);
    log('Prompt sent. Waiting for a new large image…');
    const imageMeta = await waitForNewLargeImage(before, 180000);
    const saved = await saveImageFromPage(imageMeta);

    log(`Banner saved via ${saved.method} (${saved.size} bytes).`);
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


// ===== Extra image engines (Hugging Face Inference Providers): FLUX.1, Stable Diffusion 3.5, Qwen-Image =====
const HF_ENGINES = {
  'flux':  { id: 'black-forest-labs/FLUX.1-schnell',        label: 'FLUX.1 [schnell]' },
  'sd35':  { id: 'stabilityai/stable-diffusion-3.5-large',  label: 'Stable Diffusion 3.5 Large' },
  'qwen':  { id: 'Qwen/Qwen-Image',                          label: 'Qwen-Image' }
};
let hfBusy = false;
function hfFriendlyError(err) {
  const m = String(err?.message || err || '');
  if (/401|403|unauthori[sz]ed|forbidden|invalid (user )?token|permission/i.test(m)) return 'Hugging Face rejected the token. Create a token at huggingface.co/settings/tokens with the "Make calls to Inference Providers" permission and paste it again.';
  if (/402|payment|credit|quota|exceeded your/i.test(m)) return 'Hugging Face says this account has no inference credits. Its current docs say free accounts no longer include monthly credits (you must buy credits or have PRO). Use Pollinations, Cloudflare or Ai-1 instead.';
  if (/429|rate/i.test(m)) return 'Hugging Face rate limit reached. Wait a minute and try again.';
  if (/503|loading|unavailable|timeout|timed out/i.test(m)) return 'The model is busy or still loading on Hugging Face. Try again in a moment, or choose a different engine.';
  return m || 'Image generation failed.';
}
app.post('/api/hf-image', async (req, res) => {
  if (hfBusy) return res.status(409).json({ ok: false, message: 'An image is already being generated. Wait for it to finish.' });
  const engine = String(req.body?.engine || '');
  const FREE_ENGINES = { poll: 'Pollinations FLUX', cf: 'Cloudflare FLUX.1 [schnell]' };
  const spec = HF_ENGINES[engine];
  if (!spec && !FREE_ENGINES[engine]) return res.status(400).json({ ok: false, message: 'Unknown image engine.' });
  const prompt = String(req.body?.prompt || '').trim().slice(0, 4000);
  if (!prompt) return res.status(400).json({ ok: false, message: 'Missing prompt.' });
  if (FREE_ENGINES[engine]) {
    if (hfBusy) return res.status(409).json({ ok: false, message: 'An image is already being generated. Wait for it to finish.' });
    hfBusy = true;
    try {
      const snap2 = n => Math.max(512, Math.min(1536, Math.round((Number(n) || 1024) / 16) * 16));
      const w = snap2(req.body?.width || 1216), h = snap2(req.body?.height || 784);
      let buf, mime = 'image/png';
      if (engine === 'poll') {
        log(`Pollinations image (${w}x${h})…`);
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 1800))}?width=${w}&height=${h}&model=flux&nologo=true&seed=${Math.floor(Math.random() * 1e9)}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(150000) });
        const ct = r.headers.get('content-type') || '';
        if (!r.ok || !/^image\//i.test(ct)) {
          if (r.status === 429) throw new Error('Pollinations is busy (rate limit). Wait a minute and try again.');
          throw new Error(`Pollinations returned HTTP ${r.status}. The free service may be busy or changed; try again or use another engine.`);
        }
        mime = ct; buf = Buffer.from(await r.arrayBuffer());
      } else {
        const accountId = String(req.body?.cfAccountId || process.env.CF_ACCOUNT_ID || '').trim();
        const cfToken = String(req.body?.cfToken || process.env.CF_API_TOKEN || '').trim();
        if (!accountId || !cfToken) throw new Error('Enter your Cloudflare Account ID and API token first (dash.cloudflare.com → AI → Workers AI → Use REST API).');
        log('Cloudflare FLUX.1 [schnell] image…');
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: prompt.slice(0, 2000), steps: 8 }),
          signal: AbortSignal.timeout(150000)
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j?.success || !j?.result?.image) {
          const em = (j?.errors && j.errors[0] && j.errors[0].message) || `HTTP ${r.status}`;
          if (r.status === 401 || r.status === 403) throw new Error('Cloudflare rejected the credentials. Check the Account ID and that the API token has Workers AI permission.');
          if (r.status === 429 || /neuron|limit|quota/i.test(em)) throw new Error('Cloudflare free daily allowance reached (resets 00:00 UTC). Try another engine or tomorrow.');
          throw new Error('Cloudflare error: ' + em);
        }
        const bin = Buffer.from(j.result.image, 'base64');
        mime = bin[0] === 0xFF ? 'image/jpeg' : 'image/png'; buf = bin;
      }
      if (!buf || buf.length < 1000) throw new Error('The provider returned an empty image.');
      const ext = /jpe?g/i.test(mime) ? 'jpg' : /webp/i.test(mime) ? 'webp' : 'png';
      const filename = `banner-${Date.now()}-${engine}.${ext}`;
      fs.writeFileSync(path.join(BANNERS_DIR, filename), buf);
      log(`${FREE_ENGINES[engine]} image saved: ${filename} (${buf.length} bytes).`);
      return res.json({ ok: true, filename, size: buf.length, method: engine, imageUrl: `/generated_banners/${encodeURIComponent(filename)}` });
    } catch (err) {
      log('Free image engine error:', err.message);
      return res.status(500).json({ ok: false, message: String(err.message || err) });
    } finally { hfBusy = false; }
  }
  const token = String(req.body?.token || process.env.HF_TOKEN || '').trim();
  if (!token) return res.status(400).json({ ok: false, message: 'Paste your free Hugging Face token first (huggingface.co/settings/tokens).' });
  const snap = n => Math.max(512, Math.min(1536, Math.round((Number(n) || 1024) / 16) * 16));
  const width = snap(req.body?.width || 1216), height = snap(req.body?.height || 784);

  let mod;
  try { mod = await import('@huggingface/inference'); }
  catch (e) { return res.status(500).json({ ok: false, message: 'The Hugging Face package is not installed yet. Close this window and run start-chatgpt-bridge.bat again (it will run npm install).' }); }

  hfBusy = true;
  try {
    const client = new mod.InferenceClient(token);
    log(`HF image: ${spec.label} (${width}x${height})…`);
    const run = parameters => client.textToImage({ provider: 'auto', model: spec.id, inputs: prompt, ...(parameters ? { parameters } : {}) });
    let out;
    try { out = await run({ width, height }); }
    catch (e) {
      if (/401|403|402|429|token|credit|quota/i.test(String(e?.message))) throw e;
      log('HF image: retrying without size parameters:', e.message);
      out = await run(null);
    }
    let buf, mime = 'image/png';
    if (typeof out === 'string') {
      const r = await fetch(out); if (!r.ok) throw new Error('Could not download the generated image.');
      mime = r.headers.get('content-type') || mime; buf = Buffer.from(await r.arrayBuffer());
    } else {
      mime = out.type || mime; buf = Buffer.from(await out.arrayBuffer());
    }
    if (buf.length < 1000) throw new Error('The provider returned an empty image.');
    const ext = /jpe?g/i.test(mime) ? 'jpg' : /webp/i.test(mime) ? 'webp' : 'png';
    const filename = `banner-${Date.now()}-${engine}.${ext}`;
    fs.writeFileSync(path.join(BANNERS_DIR, filename), buf);
    log(`HF image saved: ${filename} (${buf.length} bytes).`);
    res.json({ ok: true, filename, size: buf.length, method: 'hf-' + engine, imageUrl: `/generated_banners/${encodeURIComponent(filename)}` });
  } catch (err) {
    log('HF image error:', err.message);
    res.status(500).json({ ok: false, message: hfFriendlyError(err) });
  } finally { hfBusy = false; }
});

app.listen(PORT, HOST, () => {
  console.log(`Text-to-Mailer AI Bridge V25 (Microsoft Edge) running at http://${HOST}:${PORT}`);
  console.log(`Generated banners are saved to: ${BANNERS_DIR}`);
  console.log(`A dedicated Microsoft Edge profile is used at: ${PROFILE_DIR}`);
  console.log('The dedicated Edge profile keeps the session cookies so the same session is reused on later runs.');
});