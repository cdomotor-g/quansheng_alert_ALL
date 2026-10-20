// Checks the guide and its sibling pages as a visitor's browser sees them:
// no script errors, every local image and link resolves, every in-page anchor
// exists, the downloads table is filled from the manifest, and the page fits
// a phone's width.
//
//   node test/test_site.mjs
//
// Needs Playwright and a Chromium; skips cleanly (exit 0) if either is missing.

import { createServer } from 'node:http';
import { readFile, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, '..', 'docs');

let chromium;
try {
	({ chromium } = await import('playwright'));
} catch {
	console.log('site: skipped (playwright is not installed)');
	process.exit(0);
}
const executablePath = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
	.filter(Boolean).find(p => existsSync(p));

const TYPES = {
	'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
	'.json': 'application/json', '.bin': 'application/octet-stream', '.jpg': 'image/jpeg',
	'.png': 'image/png', '.py': 'text/plain',
};
const missing = [];
const server = createServer((req, res) => {
	let rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
	if (rel.endsWith('/')) rel += 'index.html';
	const path = join(docs, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
	readFile(path, (err, data) => {
		if (err) { missing.push(rel); res.writeHead(404).end('not found'); return; }
		res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
		res.end(data);
	});
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

let failures = 0;
const check = (name, cond, extra = '') => {
	if (cond) console.log(`  ok    ${name}`);
	else { failures++; console.log(`  FAIL  ${name}${extra ? '\n        ' + extra : ''}`); }
};

const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
	for (const [path, label] of [['', 'guide'], ['flash/', 'installer'], ['cable/', 'cable page']]) {
		console.log(`site: ${label}`);
		// 360 px: a small phone, and a margin for CI fonts that set wider than a desktop's
		const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
		const errors = [];
		page.on('pageerror', e => errors.push(e.message));
		page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
		missing.length = 0;
		await page.goto(base + path, { waitUntil: 'networkidle' });
		// lazy images below the fold would otherwise never be fetched, and so never fail
		await page.evaluate(() => document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; }));
		await page.waitForLoadState('networkidle');
		await page.waitForFunction(() => Array.from(document.images).every(i => i.complete), null, { timeout: 10000 }).catch(() => {});

		const broken = await page.evaluate(() =>
			Array.from(document.images).filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src')));
		check('every image loads', broken.length === 0, broken.join(', '));

		// every link to a file on this site must exist
		const local = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
			.map(a => a.href).filter(h => h.startsWith(location.origin)));
		const dead = [];
		for (const href of new Set(local.map(h => h.split('#')[0]))) {
			const res = await page.request.get(href);
			if (!res.ok()) dead.push(href.replace(base, '/'));
		}
		check('every local link resolves', dead.length === 0, dead.join(', '));

		const anchors = await page.evaluate(() => Array.from(document.querySelectorAll('a[href^="#"]'))
			.map(a => a.getAttribute('href').slice(1)).filter(id => id && !document.getElementById(id)));
		check('every in-page anchor has a target', anchors.length === 0, anchors.join(', '));

		const overflow = await page.evaluate(() => {
			document.querySelectorAll('details').forEach(d => { d.open = true; });
			return document.documentElement.scrollWidth - window.innerWidth;
		});
		check('nothing scrolls sideways on a phone', overflow <= 1, `${overflow}px too wide`);

		if (label === 'guide') {
			await page.waitForFunction(() => document.querySelectorAll('#dl-table code[title]').length >= 3, null, { timeout: 5000 })
				.catch(() => {});
			const rows = await page.locator('#dl-table code[title]').count();
			check('the downloads table is filled from the manifest', rows >= 3, `${rows} rows with checksums`);
			const uncredited = await page.evaluate(async () => {
				const credits = await (await fetch('img/photos/credits.json')).json();
				const have = new Set(credits.map(c => c.file));
				return [...new Set(Array.from(document.querySelectorAll('img[src*="img/photos/"]'))
					.map(i => i.getAttribute('src').split('/').pop()))].filter(f => !have.has(f));
			});
			check('every photo on the page has a credit and licence', uncredited.length === 0, uncredited.join(', '));

			await page.locator('#tab-v1').click();
			check('the older-UV-K5 tab opens', await page.locator('#use-v1').isVisible() && await page.locator('#use-v3').isHidden());
		}
		check('no JavaScript errors', errors.length === 0, errors.join('\n        '));
		await page.close();
	}
} catch (err) {
	failures++;
	console.log(`  FAIL  unexpected error\n        ${err.stack || err.message}`);
} finally {
	await browser.close();
	server.close();
}

console.log(failures ? `\nFAILED: ${failures}` : '\nPASSED');
process.exit(failures ? 1 : 0);
