#!/usr/bin/env node
/**
 * Render-timing harness for the committed viewer.
 *
 * Opens the built site/index.html from file:// in headless Chromium and times
 * four views, each in a FRESH browser context (a remembered atlas:accounts
 * selection would otherwise make bare #/ non-empty):
 *
 *   #/                                   the empty overview (waits on .canvas-empty)
 *   #/?accounts=<first account>          one account
 *   #/?accounts=<every account>          show all
 *   #/vpc/<a VPC id>                     one VPC detail view
 *
 * "first" is from navigation start to the view being drawn: .canvas-empty for
 * the empty case, otherwise a .react-flow__node present with .loading gone.
 * "repeat" navigates away (a VPC for the overview views, #/ for the VPC view)
 * and back in the same page, timed from the hash change. Each view is run
 * --runs times (default 5) and the median is printed with the range.
 *
 * The built page has no StrictMode; the dev server does (double mount), so
 * time the built file, never `npm run dev`. Defaults come from the committed
 * fixture; pass --one, --all and --vpc to time another estate's data.
 *
 * Usage:  node tools/perf/time-views.cjs [--runs=5] [--html=site/index.html]
 *                [--one=<id>] [--all=<id>,<id>] [--vpc=<vpc-id>]
 *
 * Needs Chromium for Playwright. It never downloads one: if it is missing it
 * prints the install command and exits non-zero.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');

function die(msg) { console.error('\n[time-views] ERROR: ' + msg + '\n'); process.exit(1); }

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// Playwright is a viewer devDependency, hoisted to the root node_modules.
function loadPlaywright() {
  const paths = [ROOT, path.join(ROOT, 'packages', 'viewer')];
  try {
    return require(require.resolve('playwright', { paths }));
  } catch {
    die('playwright is not installed. Run `npm install` from the repo root.');
  }
}

const RUNS = Number(arg('runs', '5'));
const HTML = path.resolve(ROOT, arg('html', path.join('site', 'index.html')));
const ONE = arg('one', '111111111111');
const ALL = arg('all', '111111111111,222222222222,333333333333');
const VPC = arg('vpc', 'vpc-0prod00000000000a1');

const VIEWS = [
  { name: 'empty overview', hash: '#/', empty: true, away: `#/vpc/${VPC}` },
  { name: 'one account', hash: `#/?accounts=${ONE}`, away: `#/vpc/${VPC}` },
  { name: 'all accounts', hash: `#/?accounts=${ALL}`, away: `#/vpc/${VPC}` },
  { name: 'one VPC', hash: `#/vpc/${VPC}`, away: '#/' },
];

/**
 * Resolves, polled every animation frame, to performance.now() once the view
 * is drawn. A canvas left over from the previous view is marked data-stale
 * before navigating, so its nodes never count as the new view's.
 */
function drawn(page) {
  return page
    .waitForFunction(
      () => {
        if (document.querySelector('.canvas-empty')) return { at: performance.now(), empty: true, nodes: 0 };
        if (document.querySelector('.loading')) return false;
        const nodes = document.querySelectorAll('.react-flow:not([data-stale]) .react-flow__node').length;
        return nodes > 0 ? { at: performance.now(), empty: false, nodes } : false;
      },
      undefined,
      { polling: 'raf', timeout: 120000 },
    )
    .then((h) => h.jsonValue());
}

async function go(page, hash) {
  return page.evaluate((h) => {
    document.querySelectorAll('.react-flow').forEach((el) => el.setAttribute('data-stale', ''));
    const t0 = performance.now();
    window.location.hash = h;
    return t0;
  }, hash);
}

function check(view, result, when) {
  if (Boolean(view.empty) !== result.empty) {
    die(`${view.name} (${view.hash}) ${when}: expected ${view.empty ? 'the empty canvas' : 'a drawn graph'}, got ${result.empty ? 'the empty canvas' : result.nodes + ' nodes'}`);
  }
}

async function timeOnce(browser, url, view) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url + view.hash);
    const first = await drawn(page);
    check(view, first, 'first');
    const stored = await page.evaluate(() => {
      try { return window.localStorage.getItem('atlas:accounts'); } catch { return 'unavailable'; }
    });

    // Away, wait for it to be drawn, then back: the repeat.
    await go(page, view.away);
    await drawn(page);
    const t0 = await go(page, view.hash);
    const repeat = await drawn(page);
    check(view, repeat, 'repeat');
    if (errors.length) die(`${view.name}: page errors: ${errors.join('; ')}`);
    return { first: first.at, repeat: repeat.at - t0, nodes: first.nodes, stored };
  } finally {
    await context.close();
  }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const ms = (x) => `${Math.round(x)} ms`;

async function main() {
  if (!fs.existsSync(HTML)) die(`${path.relative(ROOT, HTML)} not found. Run \`npm run build\` first.`);
  if (!Number.isInteger(RUNS) || RUNS < 1) die('--runs must be a positive integer');
  const { chromium } = loadPlaywright();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    if (/Executable doesn't exist|install/i.test(String(e && e.message))) {
      die('Chromium for Playwright is not installed. Run:\n\n    npx playwright install chromium\n\nThis harness never downloads a browser itself.');
    }
    throw e;
  }
  const url = pathToFileURL(HTML).href;
  console.log(`[time-views] ${url}  (Playwright ${require(require.resolve('playwright/package.json', { paths: [ROOT] })).version}, Chromium ${browser.version()}, ${RUNS} run(s) per view, fresh context each)`);
  try {
    for (const view of VIEWS) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) runs.push(await timeOnce(browser, url, view));
      const f = runs.map((r) => r.first);
      const r = runs.map((x) => x.repeat);
      const nodes = runs[0].nodes;
      console.log(
        `${view.name.padEnd(15)} ${view.hash.padEnd(56)} first ${ms(median(f)).padStart(7)} (${ms(Math.min(...f))}–${ms(Math.max(...f))})` +
          `  repeat ${ms(median(r)).padStart(7)} (${ms(Math.min(...r))}–${ms(Math.max(...r))})` +
          `  ${view.empty ? 'empty canvas' : nodes + ' nodes'}  atlas:accounts=${runs[0].stored ?? 'null'}`,
      );
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
