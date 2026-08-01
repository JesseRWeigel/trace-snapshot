#!/usr/bin/env node
// Load docs/index.html in a real browser and measure it.
//
// Unit tests never load the page, so a single unbalanced parenthesis in the inline script leaves
// a page that renders as static HTML with a green test suite behind it. Every assertion here is
// therefore made against a live document, and one of them is a value the script must have
// produced.
//
// Driven over the Chrome DevTools Protocol with Node's built-in WebSocket, so there is no
// Playwright dependency and no path to a sibling project's node_modules. If no Chrome is found
// this FAILS with an install line rather than skipping, because a skipped check reports the same
// success as one that ran.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// TRACE_PAGE lets verify.sh point this at a deliberately broken copy, to prove the
// measurements below can actually fail. A check never seen to fail is not evidence.
const PAGE = process.env.TRACE_PAGE ? path.resolve(process.env.TRACE_PAGE) : path.join(ROOT, 'docs', 'index.html');
const TITLE_MARK = 'trace-snapshot';

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable', 'chrome']) {
    const r = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('\n')[0];
  }
  return null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        for (const h of this.handlers.get(msg.method)) h(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout on ${method}`));
        }
      }, 20000);
    });
  }
  once(method) {
    return new Promise((resolve) => {
      if (!this.handlers.has(method)) this.handlers.set(method, []);
      this.handlers.get(method).push(resolve);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluation threw');
    }
    return r.result.value;
  }
}

const OVERFLOW_PROBE = `
  const vw = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('*')) {
    // Content scrolling inside its own container is correct. Only content escaping the page
    // is a bug, so anything under an ancestor that scrolls horizontally is skipped.
    let anc = el.parentElement, inScroller = false;
    while (anc) {
      const ox = getComputedStyle(anc).overflowX;
      if (ox === 'auto' || ox === 'scroll') { inScroller = true; break; }
      anc = anc.parentElement;
    }
    if (inScroller) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) {
      bad.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
               (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') +
               ' right=' + Math.round(r.right));
    }
  }
  return { vw, scrollWidth: document.documentElement.scrollWidth, bad: bad.slice(0, 8) };
`;

async function main() {
  if (!fs.existsSync(PAGE)) {
    console.log(`FAIL  docs/index.html does not exist; run: node scripts/build_page.mjs`);
    return 1;
  }
  const chrome = findChrome();
  if (!chrome) {
    console.log('FAIL  no Chrome or Chromium binary found.');
    console.log('      Install one, for example:  sudo apt-get install -y chromium');
    console.log('      or point CHROME_BIN at an existing binary.');
    console.log('      Without it the page is only checked statically: the static pass covers');
    console.log('      doctype, charset, viewport, dark mode declarations and the absence of');
    console.log('      remote assets, but NOT whether the inline script parses or whether');
    console.log('      anything overflows at 390px.');
    return 1;
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-snapshot-chrome-'));
  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  const wsUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`browser did not report a debugging endpoint:\n${stderr.slice(-500)}`)), 25000);
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      const m = stderr.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(t); resolve(m[0]); }
    });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`browser exited ${c}\n${stderr.slice(-500)}`)); });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('could not connect to the browser')));
  });
  const cdp = new Cdp(ws);

  let fails = 0;
  const ok = (m) => console.log(`  ok    ${m}`);
  const bad = (m) => { console.log(`  FAIL  ${m}`); fails++; };

  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    // Flat sessions need the sessionId on every message, so every later call routes through
    // this one function. Replacing send outright (rather than adding a second path) is
    // deliberate: two send functions would let a call silently go to the browser target
    // instead of the page and return a plausible-looking empty result.
    cdp.send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++cdp.id;
        cdp.pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, sessionId, method, params }));
        setTimeout(() => {
          if (cdp.pending.has(id)) { cdp.pending.delete(id); reject(new Error(`CDP timeout on ${method}`)); }
        }, 20000);
      });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `file://${PAGE}` });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 8000))]);

    // Page identity first. Every measurement below is worthless against the wrong document.
    const title = await cdp.evaluate('return document.title;');
    if (!title.includes(TITLE_MARK)) {
      bad(`the loaded document is not the one under test (title: ${JSON.stringify(title)})`);
      return 1;
    }
    ok(`loaded the right document (title: ${JSON.stringify(title.slice(0, 40))}…)`);

    // The inline script must have run. This is the check a parse error fails.
    const ready = await cdp.evaluate("return document.documentElement.getAttribute('data-page-ready');");
    if (ready !== 'trace-snapshot') bad(`the inline script did not run (data-page-ready=${JSON.stringify(ready)})`);
    else ok('the inline script parsed and ran');

    const consoleErrors = await cdp.evaluate('return window.__errors || [];');

    for (const [w, h, label] of [[390, 844, 'a 390px phone'], [1280, 900, 'a 1280px desktop']]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: w < 500,
      });
      await cdp.evaluate('return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))));');
      const r = await cdp.evaluate(OVERFLOW_PROBE);
      if (r.bad.length) bad(`${r.bad.length} element(s) escape the page at ${label}: ${r.bad.join(' | ')}`);
      else if (r.scrollWidth > r.vw + 1) bad(`the root scrolls sideways at ${label} (${r.scrollWidth} > ${r.vw})`);
      else ok(`nothing overflows at ${label} (scrollWidth ${r.scrollWidth}, viewport ${r.vw})`);
    }

    // Dark mode via the media query.
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const lightBg = await cdp.evaluate("return getComputedStyle(document.body).backgroundColor;");
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    const darkBg = await cdp.evaluate("return getComputedStyle(document.body).backgroundColor;");
    if (lightBg === darkBg) bad(`prefers-color-scheme has no effect (both ${lightBg})`);
    else ok(`prefers-color-scheme switches the page (${lightBg} -> ${darkBg})`);

    // Dark mode via the attribute, which must beat the media query in BOTH directions.
    const forcedLight = await cdp.evaluate(
      "document.documentElement.setAttribute('data-theme','light'); return getComputedStyle(document.body).backgroundColor;",
    );
    if (forcedLight !== lightBg) {
      bad(`data-theme="light" does not override a dark media query (${forcedLight} vs ${lightBg})`);
    } else ok('data-theme="light" overrides a dark media query');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const forcedDark = await cdp.evaluate(
      "document.documentElement.setAttribute('data-theme','dark'); return getComputedStyle(document.body).backgroundColor;",
    );
    if (forcedDark !== darkBg) {
      bad(`data-theme="dark" does not override a light media query (${forcedDark} vs ${darkBg})`);
    } else ok('data-theme="dark" overrides a light media query');

    // The toggle actually toggles.
    const toggled = await cdp.evaluate(`
      document.documentElement.removeAttribute('data-theme');
      const before = getComputedStyle(document.body).backgroundColor;
      document.getElementById('theme').click();
      const after = getComputedStyle(document.body).backgroundColor;
      return { before, after, attr: document.documentElement.getAttribute('data-theme'),
               label: document.getElementById('theme').textContent };
    `);
    if (toggled.before === toggled.after || !toggled.attr) {
      bad(`the theme button did not change the theme (${JSON.stringify(toggled)})`);
    } else ok(`the theme button switches the page (${toggled.before} -> ${toggled.after}, label "${toggled.label}")`);

    // Content that is wide on purpose must scroll inside its own box, not move the page.
    // Measured at 390px, where the tables are genuinely wider than the viewport.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.evaluate('return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))));');
    const scrollers = await cdp.evaluate(`
      const s = [...document.querySelectorAll('.scroll')];
      return { n: s.length, scrollable: s.filter(e => e.scrollWidth > e.clientWidth).length };
    `);
    if (scrollers.n === 0) bad('the page has no horizontally scrollable container, so the wide-table case is untested');
    else if (scrollers.scrollable === 0) bad('no container is actually scrolling at 390px, so the wide-content path is not exercised');
    else ok(`${scrollers.n} scroll containers present, ${scrollers.scrollable} scrolling at 390px`);

    if (consoleErrors.length) bad(`console errors: ${consoleErrors.join(', ')}`);
  } catch (e) {
    bad(`browser check threw: ${e.message}`);
  } finally {
    try { ws.close(); } catch {}
    proc.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true });
  }

  console.log(fails === 0 ? 'BROWSER CHECK OK' : `BROWSER CHECK FAILED (${fails})`);
  return fails === 0 ? 0 : 1;
}

main().then((c) => process.exit(c));
