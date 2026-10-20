// End-to-end test of the installer (docs/flash/) against simulated radios.
//
//   node test/test_installer.mjs
//
// A fake navigator.serial is injected into the page. It speaks the real
// protocol for both families - hello, EEPROM reads and writes, bootloader
// beacons, the UV-K5's flash blocks and the V3's handshake and numbered pages
// - and models the one physical difference that matters: a cable's adapter
// stays put when the radio is switched off, while a V3's own USB-C port goes
// away with it and comes back as a different device. The bytes the "radio"
// receives are compared against the published builds, so a framing, layout or
// ordering mistake fails here instead of on someone's hardware.
//
// Needs Playwright and a Chromium; skips cleanly (exit 0) if either is missing.

import { createServer } from 'node:http';
import { readFile, readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const docs = join(root, 'docs');

let chromium;
try {
	({ chromium } = await import('playwright'));
} catch {
	console.log('installer: skipped (playwright is not installed)');
	process.exit(0);
}

const CHROME_CANDIDATES = [
	process.env.CHROMIUM_PATH,
	'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/usr/bin/google-chrome',
].filter(Boolean);
const executablePath = CHROME_CANDIDATES.find(p => existsSync(p));

// ---- a tiny static server for docs/ ----------------------------------------

const TYPES = {
	'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
	'.json': 'application/json', '.bin': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png',
};

const server = createServer((req, res) => {
	let rel = decodeURIComponent(req.url.split('?')[0]);
	if (rel.endsWith('/')) rel += 'index.html';
	const path = join(docs, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
	readFile(path, (err, data) => {
		if (err) { res.writeHead(404).end('not found'); return; }
		res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
		res.end(data);
	});
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/flash/`;

// ---- the simulated radio, injected into the page ---------------------------

function installFakeRadio() {
	const radio = {
		family: 'v3',           // which bootloader and memory map it has
		mode: 'normal',         // 'normal' | 'boot' | 'off' | 'noise' | 'loop'
		usbC: true,             // true: the port lives in the radio (V3 USB-C); false: in a cable
		version: 'F4HWN v5.9.0',
		opens: [],
		eeprom: new Uint8Array(0xd000),
		writes: [],             // EEPROM addresses written, in order
		flashed: new Map(),     // v1: address -> block, v3: page -> page bytes
		pageCounts: new Set(),  // v3: every page count the host announced
		handshakes: [],         // v3: 0x0530 tokens received
		earlyPages: 0,          // v3: pages sent before any handshake
		versionPresented: null, // v1: the 16-byte version string
		port: null,
		portsMade: 0,
		autoReboot: true,       // v3: restart into the app after the last page
	};
	window.__radio = radio;
	for (let i = 0; i < radio.eeprom.length; i++) radio.eeprom[i] = (i * 7 + 3) & 0xff;

	// Real beacons, captured from hardware: a stock 2.00.06 (v1) and a 7.00.07 (V3).
	const BEACONS = {
		v1: [0x18, 0x05, 0x20, 0x00, 0x01, 0x02, 0x02, 0x06, 0x1c, 0x53, 0x50, 0x4b,
		     0x4c, 0x5d, 0x02, 0xc1, 0x22, 0x87, 0x73, 0xdb, 0x32, 0x2e, 0x30, 0x30,
		     0x2e, 0x30, 0x36, 0x00, 0, 0, 0, 0, 0, 0, 0, 0],
		v3: [0x18, 0x05, 0x20, 0x00, 0x52, 0x34, 0x50, 0x41, 0x14, 0x33, 0x33, 0x33,
		     0x56, 0x43, 0xa3, 0x00, 0x78, 0x47, 0x04, 0x56, 0x37, 0x2e, 0x30, 0x30,
		     0x2e, 0x30, 0x37, 0x00, 0x00, 0x00, 0xc4, 0x20, 0x00, 0x08, 0x00, 0x00],
	};
	// a bootloader nobody has catalogued: "5.00.01"
	BEACONS.unknown = BEACONS.v1.slice();
	BEACONS.unknown.splice(20, 7, 0x35, 0x2e, 0x30, 0x30, 0x2e, 0x30, 0x31);
	radio.beaconKind = 'v3';

	const forceCrc = (frame, len, value) => {
		const key = window.K5.XOR_KEY;
		frame[4 + len]     = (value & 0xff)        ^ key[len % key.length];
		frame[4 + len + 1] = ((value >> 8) & 0xff) ^ key[(len + 1) % key.length];
		return frame;
	};

	// The radio never sends a checksum that verifies: 0xFFFF from firmware,
	// 0x6ed1 from a 7.00.07 bootloader. Reproduce that, or these tests
	// exercise a radio that does not exist.
	const send = (payload, crc = 'none') => {
		const port = radio.port;
		if (!port || !port.controller) return;
		const bytes = Uint8Array.from(payload);
		const frame = window.K5.frame(bytes);
		if (crc === 'none') forceCrc(frame, bytes.length, 0xffff);
		else if (crc === 'boot') forceCrc(frame, bytes.length, 0x6ed1);
		port.controller.enqueue(frame);
	};

	let ticker = null;
	const tick = () => {
		clearInterval(ticker);
		ticker = setInterval(() => {
			if (radio.mode === 'boot') send(BEACONS[radio.beaconKind], 'boot');
			if (radio.mode === 'noise' && radio.port && radio.port.controller)
				radio.port.controller.enqueue(Uint8Array.from({ length: 20 }, () => Math.random() * 256));
		}, 200);
	};
	tick();

	const le16 = (p, i) => p[i] | (p[i + 1] << 8);

	const handle = (p) => {
		const cmd = p[0];
		if (radio.mode === 'noise' || radio.mode === 'off') return;

		if (radio.mode === 'boot') {
			if (radio.beaconKind !== 'v3') {                     // a UV-K5 bootloader
				if (cmd === 0x30) {
					radio.versionPresented = new TextDecoder().decode(p.slice(4)).replace(/\0+$/, '');
					send(BEACONS[radio.beaconKind], 'boot');
				} else if (cmd === 0x19) {
					const addr = (p[8] << 8) | p[9];
					radio.flashed.set(addr, p.slice(16, 16 + 0x100));
					send([0x1a, 0x05, 0x08, 0x00, 0x8a, 0x8d, 0x9f, 0x1d, p[8], p[9], 0x00, 0x00], 'real');
				}
				return;
			}
			// the V3 bootloader, as serialtool/_prog.py describes it
			if (cmd === 0x30) {
				radio.handshakes.push(new TextDecoder().decode(p.slice(4, 4 + le16(p, 2))));
			} else if (cmd === 0x19) {
				const page = le16(p, 8), count = le16(p, 10);
				let err = 0;
				if (!radio.handshakes.length) { radio.earlyPages++; err = 1; }   // rejected until the handshake
				else {
					radio.flashed.set(page, p.slice(16, 16 + 0x100));
					radio.pageCounts.add(count);
				}
				send([0x1a, 0x05, 0x08, 0x00, p[4], p[5], p[6], p[7], p[8], p[9], err, 0x00], 'boot');
				if (!err && page === count - 1 && radio.autoReboot && radio.usbC)
					setTimeout(() => window.__power('normal', 'F4HWN v5.9.1'), 300);
			}
			return;
		}

		if (cmd === 0x14) {                                      // hello
			const v = new TextEncoder().encode(radio.version);
			const body = new Uint8Array(16);
			body.set(v.subarray(0, 16));
			send([0x15, 0x05, 0x10, 0x00, ...body]);
		} else if (cmd === 0x1b) {                               // read EEPROM
			const addr = le16(p, 4), len = p[6];
			if (radio.family === 'v3' && len > 0x80) return;     // its reply buffer is 128 bytes
			send([0x1c, 0x05, len + 4, 0x00, p[4], p[5], len, 0x00, ...radio.eeprom.slice(addr, addr + len)]);
		} else if (cmd === 0x1d) {                               // write EEPROM
			const addr = le16(p, 4), len = p[6];
			radio.eeprom.set(p.slice(12, 12 + len), addr);
			radio.writes.push(addr);
			send([0x1e, 0x05, 0x02, 0x00, p[4], p[5]]);
		} else if (cmd === 0xdd) {
			radio.resetSeen = true;
		}
	};

	const makePort = () => {
		radio.portsMade++;
		const vid = radio.usbC ? 0x36b7 : 0x1a86;
		const pid = radio.usbC ? (radio.mode === 'boot' ? 0x0001 : 0xffff) : 0x7523;
		let rx = new Uint8Array(0);
		const port = {
			readable: null, writable: null, controller: null, signals: [],
			async open(opts) {
				radio.opens.push(opts.baudRate);
				this.readable = new ReadableStream({
					start: c => { this.controller = c; },
					cancel: () => { this.controller = null; },
				});
				this.writable = new WritableStream({
					write: chunk => {
						if (radio.port !== this) return;               // a port whose device has gone
						if (radio.mode === 'loop') { this.controller?.enqueue(Uint8Array.from(chunk)); return; }
						const merged = new Uint8Array(rx.length + chunk.length);
						merged.set(rx, 0);
						merged.set(chunk, rx.length);
						const { packets, rest } = window.K5.deframe(merged);
						rx = rest;
						for (const pk of packets) if (pk.crcOk) handle(pk.payload);
					},
				});
			},
			async close() {
				if (this.readable && this.readable.locked) throw new DOMException('port is locked', 'InvalidStateError');
				this.controller = null;
				this.readable = null;
				this.writable = null;
			},
			async setSignals(s) { this.signals.push(s); },
			getInfo() { return { usbVendorId: vid, usbProductId: pid }; },
			_listeners: {},
			addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
			removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn); },
			_gone() {
				try { this.controller?.error(new DOMException('The device has been lost.', 'NetworkError')); } catch { /* closed */ }
				this.controller = null;
				for (const f of this._listeners.disconnect || []) f({ type: 'disconnect' });
			},
		};
		return port;
	};

	// Switch the radio off, on normally, or on with PTT held. A cable's port
	// survives all of it; the radio's own USB-C port does not.
	window.__power = (mode, version) => {
		if (version) radio.version = version;
		radio.mode = mode;
		if (radio.usbC) {
			const old = radio.port;
			radio.port = null;
			if (old) old._gone();
			if (mode !== 'off') radio.port = makePort();
		} else if (!radio.port) {
			radio.port = makePort();
		}
		tick();
	};
	window.__setup = (opts) => {
		Object.assign(radio, opts);
		if (radio.port) radio.port._gone();
		radio.port = null;
		window.__power(radio.mode);
	};
	window.__power('normal');

	Object.defineProperty(navigator, 'serial', {
		configurable: true,
		value: {
			async requestPort() {
				if (!radio.port) throw new DOMException('No port selected by the user.', 'NotFoundError');
				return radio.port;
			},
			async getPorts() { return radio.port ? [radio.port] : []; },
			addEventListener() {}, removeEventListener() {},
		},
	});
}

// ---- drive the page --------------------------------------------------------

let failures = 0;
const check = (name, cond, extra = '') => {
	if (cond) { console.log(`  ok    ${name}`); }
	else { failures++; console.log(`  FAIL  ${name}${extra ? '\n        ' + extra : ''}`); }
};

const text = (page, id) => page.locator(`#${id}`).textContent();
const waitText = (page, id, re, timeout = 10000) =>
	page.waitForFunction(([id, src, flags]) => new RegExp(src, flags).test(document.getElementById(id).textContent),
		[id, re.source, re.flags], { timeout });

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const tmp = mkdtempSync(join(tmpdir(), 'k5test-'));

async function newPage(query = '') {
	const context = await browser.newContext({ acceptDownloads: true });
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
	page.on('dialog', d => d.accept());
	await page.addInitScript(installFakeRadio);
	await page.goto(base + query, { waitUntil: 'networkidle' });
	return { page, errors, context };
}

const v3raw = new Uint8Array(readFileSync(join(docs, 'firmware/v3/quansheng-alert-v3.bin')));
const v1raw = new Uint8Array(readFileSync(join(docs, 'firmware/v1/quansheng-alert-default.bin')));

try {
	// =================================================== V3 over its own USB-C
	console.log('installer: UV-K1 / UV-K5 V3 over USB-C');
	{
		const { page, errors } = await newPage();
		check('the browser-support blocker stays hidden', await page.locator('#unsupported').isHidden());
		check('both kinds of radio are offered', await page.locator('.radio-pick').count() === 2);

		await page.locator('.radio-pick[data-family="v3"]').click();
		await page.waitForSelector('.fw');
		const cards = await page.locator('.fw').count();
		check('only the V3 build is offered for a V3', cards === 1, `saw ${cards} cards`);
		check('UV-K5-only text is hidden once a V3 is picked',
		      await page.locator('#step-connect .only-v1').first().isHidden());

		await page.locator('.fw').first().click();
		await waitText(page, 'fw-chosen', /Ready to install/);
		check('the V3 build is validated as PY32F071 code', /PY32F071/.test(await text(page, 'fw-chosen')), await text(page, 'fw-chosen'));

		await page.locator('#btn-connect').click();
		await waitText(page, 'connect-status', /F4HWN v5\.9\.0/);
		check('connecting over USB-C reads the running firmware', true);
		const signals = await page.evaluate(() => window.__radio.port.signals);
		check('DTR is lowered and raised on the radio’s own port',
		      signals.length >= 2 && signals.at(-2).dataTerminalReady === false && signals.at(-1).dataTerminalReady === true,
		      JSON.stringify(signals));

		// backup: the V3 memory map, not the UV-K5's 8 KB
		const dl = page.waitForEvent('download', { timeout: 30000 });
		await page.locator('#btn-backup').click();
		const download = await dl;
		await waitText(page, 'backup-status', /Saved as/, 30000);
		const saved = new Uint8Array(readFileSync(await download.path()));
		const eeprom = await page.evaluate(() => Array.from(window.__radio.eeprom));
		check('the V3 backup is an image up to the end of calibration', saved.length === 0xb200, `${saved.length} bytes`);
		const inRegion = a => [[0, 0x8870], [0x9000, 0x90f0], [0xa000, 0xa180], [0xb000, 0xb200]].some(([f, t]) => a >= f && a < t);
		let bad = null;
		for (let a = 0; a < saved.length && !bad; a++) {
			const want = inRegion(a) ? eeprom[a] : 0xff;
			if (saved[a] !== want) bad = `0x${a.toString(16)}: got ${saved[a]}, want ${want}`;
		}
		check('the backup holds channels, settings and the calibration at 0xB000', !bad, bad || '');
		check('the backup file is named for a V3', /^uvk1-v3-backup-[\d-]+\.bin$/.test(download.suggestedFilename()), download.suggestedFilename());
		writeFileSync(join(tmp, 'v3-backup.bin'), saved);

		// switch off: the port goes with the radio
		await page.evaluate(() => window.__power('off'));
		await page.waitForFunction(() => document.getElementById('portbar').hidden, null, { timeout: 5000 });
		check('switching a USB-C radio off releases the port in the UI', true);
		check('the page says that is expected',
		      /normal on USB-C/.test(await text(page, 'connect-status')), await text(page, 'connect-status'));

		// PTT + power: a new USB device, picked again by the install click
		await page.evaluate(() => window.__power('boot'));
		await page.locator('#btn-flash').click();
		await waitText(page, 'flash-status', /Installed/, 90000);
		const r = await page.evaluate(() => ({
			hs: window.__radio.handshakes,
			early: window.__radio.earlyPages,
			counts: Array.from(window.__radio.pageCounts),
			pages: Array.from(window.__radio.flashed.keys()).sort((a, b) => a - b),
			bytes: Object.fromEntries(Array.from(window.__radio.flashed, ([k, v]) => [k, Array.from(v)])),
			ports: window.__radio.portsMade,
		}));
		const pages = Math.ceil(v3raw.length / 0x100);
		check('the install click picked up the bootloader’s new port', r.ports === 2, `${r.ports} ports made`);
		check('the handshake carried "7.00", before any page', r.hs.length >= 1 && r.hs.every(t => t === '7.00') && r.early === 0,
		      JSON.stringify(r.hs) + ` early=${r.early}`);
		check('every page was written, in order, once', r.pages.length === pages && r.pages.every((p, i) => p === i),
		      `${r.pages.length} of ${pages}`);
		check('every page announced the right page count', r.counts.length === 1 && r.counts[0] === pages, JSON.stringify(r.counts));
		let mismatch = null;
		for (let p = 0; p < pages && !mismatch; p++)
			for (let i = 0; i < 0x100; i++) {
				const a = p * 0x100 + i;
				const want = a < v3raw.length ? v3raw[a] : 0;
				if (r.bytes[p][i] !== want) { mismatch = `0x${a.toString(16)}: got ${r.bytes[p][i]}, want ${want}`; break; }
			}
		check('the radio received the V3 build byte for byte', !mismatch, mismatch || '');

		// it restarts by itself; the port changes again, so checking takes a click
		await page.waitForSelector('#btn-verify:not([hidden])', { timeout: 15000 });
		await page.locator('#btn-verify').click();
		await waitText(page, 'done-summary', /Confirmed/, 15000);
		check('the new firmware is confirmed after a click',
		      /F4HWN v5\.9\.1/.test(await text(page, 'done-summary')), await text(page, 'done-summary'));

		// the after-install backup in the done step
		const dl2 = page.waitForEvent('download', { timeout: 30000 });
		await page.locator('#btn-backup-after').click();
		await dl2;
		await waitText(page, 'backup-after-status', /Saved as/, 30000);
		check('the done step takes a backup from the new firmware', true);

		// restore: calibration only, 16 bytes at a time
		await page.evaluate(() => { window.__radio.writes = []; });
		await page.locator('#restore-file').evaluate(el => { el.closest('details').open = true; });
		await page.locator('#restore-file').setInputFiles(join(tmp, 'v3-backup.bin'));
		await waitText(page, 'restore-status', /looks like a valid/);
		await page.locator('#btn-restore').click();
		await waitText(page, 'restore-status', /Restored|did not finish/, 20000);
		const writes = await page.evaluate(() => window.__radio.writes);
		check('a V3 restore writes the calibration and nothing else',
		      writes.length === 32 && writes.every((a, i) => a === 0xb000 + i * 16), JSON.stringify(writes.slice(0, 4)) + ` … ${writes.length}`);

		check('no JavaScript errors on the page', errors.length === 0, errors.join('\n        '));
	}

	// ======================================= the guard between the two chips
	console.log('installer: firmware for one chip, radio with the other');
	{
		const { page, errors } = await newPage('?radio=v3');
		check('?radio=v3 pre-selects the V3', await page.locator('.radio-pick[data-family="v3"]').getAttribute('aria-pressed') === 'true');
		await page.locator('.fw').first().click();
		await waitText(page, 'fw-chosen', /Ready to install/);

		// a UV-K5 (2.x bootloader) behind a cable, already in bootloader mode
		await page.evaluate(() => window.__setup({ usbC: false, family: 'v1', beaconKind: 'v1', mode: 'boot' }));
		await page.locator('#btn-connect').click();
		await waitText(page, 'connect-status', /bootloader mode/);
		await page.locator('#skip-backup').check();
		await page.locator('#btn-flash').click();
		await waitText(page, 'flash-status', /Nothing has been written/, 20000);
		check('V3 firmware is refused for a radio with a 2.x bootloader', true);
		check('nothing was written', await page.evaluate(() => window.__radio.flashed.size === 0));
		check('no override is offered between known chips', await page.locator('#compat-override-wrap').isHidden());
		check('a one-click switch to the right firmware is offered', await page.locator('#compat-switch').isVisible());

		await page.locator('#compat-switch').click();
		await page.waitForFunction(() => document.querySelectorAll('.fw').length === 2, null, { timeout: 5000 });
		check('switching offers the two UV-K5 builds', true);
		check('the earlier V3 choice is dropped', await page.locator('#fw-chosen').isHidden());
		check('no JavaScript errors on the page', errors.length === 0, errors.join('\n        '));
	}

	// ============================================== the UV-K5 over the cable
	console.log('installer: UV-K5 over the two-pin cable');
	{
		const { page, errors } = await newPage();
		await page.evaluate(() => window.__setup({ usbC: false, family: 'v1', beaconKind: 'v1', mode: 'normal', version: '2.01.26' }));
		await page.locator('.radio-pick[data-family="v1"]').click();
		await page.waitForFunction(() => document.querySelectorAll('.fw').length === 2, null, { timeout: 5000 });
		check('both UV-K5 builds are offered', true);
		await page.locator('.fw').first().click();
		await waitText(page, 'fw-chosen', /checksum OK.*DP32G030/);
		check('the packed UV-K5 build is validated as DP32G030 code', true);

		await page.locator('#btn-connect').click();
		await waitText(page, 'connect-status', /2\.01\.26/);
		check('the cable connection reads the stock version', true);

		const dl = page.waitForEvent('download', { timeout: 30000 });
		await page.locator('#btn-backup').click();
		const download = await dl;
		await waitText(page, 'backup-status', /Saved as/, 30000);
		const saved = new Uint8Array(readFileSync(await download.path()));
		const eeprom = await page.evaluate(() => Array.from(window.__radio.eeprom.slice(0, 0x2000)));
		check('the UV-K5 backup is its full 8 KB EEPROM', saved.length === 0x2000 && saved.every((b, i) => b === eeprom[i]));

		// the cable's port survives the power cycle
		await page.evaluate(() => window.__power('off'));
		check('switching the radio off keeps a cable’s port', await page.locator('#portbar').isVisible());
		await page.locator('#btn-flash').click();
		await waitText(page, 'flash-status', /Waiting for the radio/);
		await page.evaluate(() => window.__power('boot'));
		await waitText(page, 'flash-status', /Installed/, 60000);
		const r = await page.evaluate(() => ({
			version: window.__radio.versionPresented,
			blocks: Array.from(window.__radio.flashed.keys()).sort((a, b) => a - b),
			bytes: Object.fromEntries(Array.from(window.__radio.flashed, ([k, v]) => [k, Array.from(v)])),
		}));
		check('the wildcard version was presented first', typeof r.version === 'string' && r.version.startsWith('*'), String(r.version));
		check('every block was written from address 0', r.blocks.length === Math.ceil(v1raw.length / 0x100) && r.blocks.every((a, i) => a === i * 0x100));
		let mismatch = null;
		for (let a = 0; a < v1raw.length && !mismatch; a += 0x100)
			for (let i = 0; i < 0x100; i++) {
				const want = a + i < v1raw.length ? v1raw[a + i] : 0;
				if (r.bytes[a][i] !== want) { mismatch = `0x${(a + i).toString(16)}`; break; }
			}
		check('the radio received the UV-K5 build byte for byte', !mismatch, mismatch || '');

		await page.evaluate(() => window.__power('normal', '*ALERTRX test'));
		await waitText(page, 'done-summary', /Confirmed/, 60000);
		check('the reboot is confirmed without a click on a cable', /\*ALERTRX test/.test(await text(page, 'done-summary')));

		// an uncatalogued bootloader can be overridden deliberately
		await page.evaluate(() => {
			window.__radio.flashed.clear();
			document.getElementById('flash-status').textContent = '';
			window.__radio.beaconKind = 'unknown';
			window.__power('boot');
		});
		await page.locator('#btn-flash').click();
		await waitText(page, 'flash-status', /Nothing has been written/, 20000);
		check('an unknown bootloader is stopped', await page.evaluate(() => window.__radio.flashed.size === 0));
		check('…with the typed override on offer', await page.locator('#compat-override-wrap').isVisible());
		await page.locator('#compat-override-wrap').evaluate(el => { el.open = true; });
		await page.locator('#compat-override').fill('FLASH ANYWAY');
		await page.evaluate(() => { document.getElementById('flash-status').textContent = ''; });
		await page.locator('#btn-flash').click();
		await waitText(page, 'flash-status', /Installed/, 60000);
		check('the override lets a deliberate install through', await page.evaluate(() => window.__radio.flashed.size > 0));

		// the cable check counts beacons and names the bootloader
		await page.evaluate(() => { window.__radio.beaconKind = 'v1'; window.__power('boot'); });
		await page.locator('#btn-cable').evaluate(el => { el.closest('details').open = true; });
		await page.locator('#btn-cable').click();
		await waitText(page, 'cable-status', /beacons/, 15000);
		check('the cable check names the bootloader', /2\.00\.06/.test(await text(page, 'cable-status')), await text(page, 'cable-status'));

		check('no JavaScript errors on the page', errors.length === 0, errors.join('\n        '));
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
