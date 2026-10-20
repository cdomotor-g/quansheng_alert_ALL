// Talking to a Quansheng UV-K5 / UV-K1 over Web Serial.
//
// One persistent read loop feeds a small queue of decoded packets; everything
// else waits on that queue. With the two-pin cable the radio may be
// power-cycled at any time without the port going away, because the
// USB-serial chip lives in the cable, not in the radio - which is what lets
// this tool back up, wait for bootloader mode and flash without the user ever
// unplugging anything. The V3 / UV-K1's own USB-C socket is different: the
// USB device is inside the radio, so it vanishes when the radio is switched
// off and comes back under another USB product id in bootloader mode. The
// page has to ask for the port again then (see `usbC`).

'use strict';

// Web Serial teardown can wedge: port.close() waits forever if anything still
// holds a lock on the streams, and a reader that is mid-read() only lets go
// once it has been cancelled. Every close step is therefore capped - a port we
// cannot shut down tidily is still better abandoned than left hanging, because
// a hung close leaves the UI frozen AND the port held.
function withTimeout(promise, ms, label) {
	if (!promise || typeof promise.then !== 'function') return Promise.resolve();
	let timer;
	return Promise.race([
		Promise.resolve(promise).finally(() => clearTimeout(timer)),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
		}),
	]);
}

class K5Radio {
	constructor(log = () => {}) {
		this.port    = null;
		this.log     = log;
		this.queue   = [];          // decoded packets waiting to be claimed
		this.waiters = [];          // pending expect() calls
		this.buffer  = new Uint8Array(0);
		this.reading = false;
		this.onLost  = null;        // called if the cable is pulled
		this.stats   = { bytes: 0, packets: 0, badCrc: 0, beacons: 0 };   // since connect
		this._capture = null;       // raw bytes being collected for listen()
		this.lastBeacon = null;     // most recent bootloader broadcast, for identifying the radio
	}

	static get supported() {
		return typeof navigator !== 'undefined' && 'serial' in navigator;
	}

	get connected() {
		return !this.lost && !!(this.port && this.port.readable);
	}

	// ---- connection --------------------------------------------------------

	async connect() {
		if (!K5Radio.supported)
			throw new Error('This browser has no Web Serial support.');

		this.port = await navigator.serial.requestPort();

		// The device vanishing (cable pulled, radio's adapter re-enumerating)
		// fires here even when no read is outstanding, so state cannot get
		// stuck "connected" with nothing behind it.
		this.lost = false;
		this._onPortGone = () => {
			this.log('The serial device disappeared.');
			this.lost = true;
			this.reading = false;
			this._rejectAll(new Error('The cable was unplugged.'));
			if (this.onLost) this.onLost(new Error('The cable was unplugged.'));
		};
		try { this.port.addEventListener('disconnect', this._onPortGone); } catch { /* older impls */ }

		await this._open(K5Radio.BAUD);
	}

	// The radio's own USB-C port (V3 / UV-K1) rather than a cable's adapter.
	get usbC() {
		return this.info().vid === K5Radio.RADIO_VID;
	}

	static get RADIO_VID() { return 0x36b7; }

	// Always safe to call, in any state, and never throws: the caller's UI must
	// be able to get back to "not connected" no matter how wedged the port is.
	async disconnect() {
		try {
			await this._close();
		} catch (err) {
			this.log(`Forced the port shut: ${err.message}`);
		}
		try {
			if (this.port && this._onPortGone)
				this.port.removeEventListener('disconnect', this._onPortGone);
		} catch { /* ignore */ }
		this._onPortGone = null;
		this.port = null;
		this.log('Serial port closed.');
	}

	static get BAUD() { return 38400; }

	// Close and reopen the same port at another rate, without the user having
	// to pick it again. Only the cable check uses this: the radio itself is
	// 38400 and nothing else, so the last thing the check does is come back.
	async reopen(baudRate) {
		if (!this.port) throw new Error('The radio is not connected.');
		await this._close();
		await this._open(baudRate);
	}

	// What the browser knows about the adapter: its USB vendor and product
	// ids, or nothing for a built-in COM port.
	info() {
		const i = (this.port && this.port.getInfo) ? this.port.getInfo() : {};
		return { vid: i.usbVendorId || 0, pid: i.usbProductId || 0 };
	}

	async _open(baudRate) {
		try {
			await this.port.open({
				baudRate, dataBits: 8, stopBits: 1, parity: 'none',
				bufferSize: 4096, flowControl: 'none',
			});
		} catch (err) {
			// A serial port is single-access. Chrome reports another holder as a
			// bare "Failed to open serial port.", which tells the user nothing,
			// so name the cause they can actually act on.
			if (err.name === 'InvalidStateError')
				throw new Error('This page already has that port open.');
			throw new Error(`${err.message} A serial port can only be open in one place at ` +
				'a time - close CHIRP, any terminal window, and any other tab running this ' +
				'installer, then try again.');
		}
		this.baud = baudRate;
		this.log(`Serial port open at ${baudRate} baud.`);
		this._loopDone = this._readLoop();

		// The V3 firmware only sends text while the host holds DTR, and clears
		// its flag after one send nobody collected, so present a fresh rising
		// edge (docs/ALERT_SERIAL.md in quansheng_alert_v3, section 2). Binary
		// replies do not depend on it, and a cable's adapter ignores it.
		if (this.usbC && this.port.setSignals) {
			try {
				await this.port.setSignals({ dataTerminalReady: false });
				await new Promise(resolve => setTimeout(resolve, 50));
				await this.port.setSignals({ dataTerminalReady: true });
			} catch (err) {
				this.log(`Could not set DTR: ${err.message}`);
			}
		}
	}

	async _close() {
		this.reading = false;

		// Cancel first: a reader parked in read() only releases its lock once
		// the read resolves, and cancel() is what resolves it.
		try { await withTimeout(this._reader?.cancel(), 500, 'reader.cancel()'); } catch { /* ignore */ }

		// Then let the loop reach its own finally and release the lock.
		if (this._loopDone) {
			try { await withTimeout(this._loopDone, 1000, 'read loop'); } catch { /* ignore */ }
			this._loopDone = null;
		}

		// Belt and braces: if the loop never got there, drop the lock by hand.
		// Without this, close() below has something to wait on forever.
		try { this._reader?.releaseLock(); } catch { /* already released */ }
		this._reader = null;

		try {
			await withTimeout(this.port?.close(), 3000, 'port.close()');
		} catch (err) {
			// Report it rather than hanging. The port may linger until the tab
			// closes, but the app stays usable and says so.
			this.log(`The browser would not close the port cleanly (${err.message}).`);
		}

		this._resetState();
	}

	// Everything a fresh connection must not inherit.
	_resetState() {
		this.queue   = [];
		this.buffer  = new Uint8Array(0);
		this.stats   = { bytes: 0, packets: 0, badCrc: 0, beacons: 0 };
		this._capture = null;
		this.lastBeacon = null;
		this.reading = false;
		this._rejectAll(new Error('Disconnected.'));
	}

	async _readLoop() {
		this.reading = true;
		while (this.reading && this.port && this.port.readable) {
			this._reader = this.port.readable.getReader();
			try {
				for (;;) {
					const { value, done } = await this._reader.read();
					if (done) break;
					if (value && value.length) this._feed(value);
				}
			} catch (err) {
				if (this.reading) {
					this.lost = true;
					this.log(`Serial read error: ${err.message}`);
					this._rejectAll(err);
					if (this.onLost) this.onLost(err);
				}
				break;
			} finally {
				try { this._reader.releaseLock(); } catch { /* ignore */ }
				this._reader = null;
			}
		}
		this.reading = false;
	}

	_feed(chunk) {
		this.stats.bytes += chunk.length;
		if (this._capture && this._capture.length < 64)
			this._capture.push(...chunk.subarray(0, 64 - this._capture.length));

		const merged = new Uint8Array(this.buffer.length + chunk.length);
		merged.set(this.buffer, 0);
		merged.set(chunk, this.buffer.length);

		const { packets, rest } = K5.deframe(merged);
		this.buffer = rest.length > 4096 ? rest.subarray(rest.length - 4096) : rest;

		for (const pkt of packets) {
			// The radio never supplies a checksum we can verify. The firmware
			// sends 0xFFFF; the bootloader sends a fixed value matching no
			// CRC-16 variant over any span (0x6ed1 on a 7.00.07 bootloader).
			// Both were captured from real hardware. So the checksum is counted
			// for diagnostics but never used to discard a packet - dropping on
			// it meant a radio in bootloader mode was invisible, because every
			// beacon it sent was binned. Only what we transmit is checksummed
			// for real; that is the same trade-off k5prog makes.
			if (!pkt.crcOk) this.stats.badCrc++;
			this.stats.packets++;
			if (K5Radio.isBootloaderBroadcast(pkt.payload)) {
				this.stats.beacons++;
				this.lastBeacon = pkt.payload;
			}
			// hand it straight to a waiter if one matches, else queue it
			const idx = this.waiters.findIndex(w => w.want === null || w.want === pkt.payload[0]);
			if (idx >= 0) {
				const w = this.waiters.splice(idx, 1)[0];
				clearTimeout(w.timer);
				w.resolve(pkt.payload);
			} else {
				this.queue.push(pkt.payload);
				if (this.queue.length > 32) this.queue.shift();
			}
		}
	}

	_rejectAll(err) {
		for (const w of this.waiters) { clearTimeout(w.timer); w.reject(err); }
		this.waiters = [];
	}

	// ---- primitives --------------------------------------------------------

	async send(payload) {
		if (!this.connected) throw new Error('The radio is not connected.');
		const writer = this.port.writable.getWriter();
		try { await writer.write(K5.frame(payload)); }
		finally { writer.releaseLock(); }
	}

	// Wait for a packet whose first byte is `want` (or any packet if null).
	expect(want, timeoutMs = 1500) {
		const idx = this.queue.findIndex(p => want === null || p[0] === want);
		if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);

		return new Promise((resolve, reject) => {
			const w = { want, resolve, reject, timer: null };
			w.timer = setTimeout(() => {
				this.waiters = this.waiters.filter(x => x !== w);
				reject(new Error(want === null
					? 'The radio did not answer.'
					: `The radio did not send the expected 0x${want.toString(16)} reply in time.`));
			}, timeoutMs);
			this.waiters.push(w);
		});
	}

	drain() { this.queue = []; }

	// Just watch the line for `ms` and report what arrived: raw byte count,
	// packets that framed and passed their checksum, packets that did not,
	// bootloader beacons among them, and the first bytes seen. Nothing is
	// sent. This is the fault-finding check: a terminal shows the bootloader's
	// beacons as gibberish even when everything is right, because they are
	// scrambled binary, so counting them properly is the only honest test.
	// Send a few plain bytes and see whether they come straight back: the
	// test for an adapter whose TX has been shorted to its RX, with no radio
	// attached. Proves the adapter and its driver before the radio is blamed.
	async loopback(ms = 800) {
		if (!this.connected) throw new Error('The radio is not connected.');
		const probe = new TextEncoder().encode('K5-LOOP-' + Date.now());
		this._capture = [];
		const writer = this.port.writable.getWriter();
		try { await writer.write(probe); } finally { writer.releaseLock(); }
		await new Promise(resolve => setTimeout(resolve, ms));
		const got = Uint8Array.from(this._capture);
		this._capture = null;
		this.drain();
		const ok = got.length === probe.length && got.every((b, i) => b === probe[i]);
		return { ok, sent: probe, got };
	}

	async listen(ms) {
		if (!this.connected) throw new Error('The radio is not connected.');
		const before = { ...this.stats };
		this._capture = [];
		this.drain();
		await new Promise(resolve => setTimeout(resolve, ms));
		const sample = Uint8Array.from(this._capture);
		this._capture = null;
		this.drain();
		const after = this.stats;
		return {
			bytes:   after.bytes   - before.bytes,
			packets: after.packets - before.packets,
			badCrc:  after.badCrc  - before.badCrc,
			beacons: after.beacons - before.beacons,
			sample,
		};
	}

	async request(payload, want, timeoutMs = 1500, attempts = 3) {
		let last;
		for (let i = 0; i < attempts; i++) {
			try {
				// Every command here has exactly one reply, so anything already
				// queued is stale - typically bootloader broadcasts left over
				// from a flash. Dropping them stops an old packet being mistaken
				// for the answer to this command.
				this.drain();
				await this.send(payload);
				return await this.expect(want, timeoutMs);
			} catch (err) {
				last = err;
			}
		}
		throw last;
	}

	// ---- normal mode -------------------------------------------------------

	// Returns the running firmware version, e.g. "2.01.26" or "*ALERTRX 02f24b1".
	//
	// The reply to a hello is 0x15. A radio in the bootloader never sends one -
	// it only broadcasts 0x18 - so rather than let that end in a bare timeout,
	// check for a beacon before giving up and say what is actually wrong.
	async hello(timeoutMs = 1200) {
		let reply;
		try {
			reply = await this.request(K5.cmd.hello(), 0x15, timeoutMs, 2);
		} catch (err) {
			if (this.queue.some(p => K5Radio.isBootloaderBroadcast(p)))
				throw new Error('The radio is in bootloader mode, which cannot report a firmware version.');
			throw err;
		}
		const version = K5.versionString(reply.subarray(4, 20));
		if (!/^[\x20-\x7e]+$/.test(version))
			throw new Error('The radio answered with something that is not a version string.');
		return version;
	}

	// A radio in the bootloader broadcasts 0x18 packets about twice a second and
	// answers nothing else; a radio running normal firmware says nothing unless
	// asked. So: clear the queue, then listen. Anything arriving unprompted is
	// the bootloader. That test does not depend on the exact broadcast contents,
	// which differ between bootloader versions.
	// Identify it by its shape - command 0x18 carrying a 32-byte body - and not
	// by its contents. It used to demand 01 02 02 at [4..6], which is what a
	// stock 2.00.06 bootloader happens to put there; a 7.00.07 bootloader sends
	// 52 34 50 and was therefore never recognised. Those bytes are a device
	// identifier, not a protocol marker.
	static isBootloaderBroadcast(p) {
		return p[0] === 0x18 && p.length >= 7 && p[2] === 0x20 && p[3] === 0x00;
	}

	// ---- identifying the radio before writing to it ------------------------
	//
	// The beacon carries the bootloader's own version as ASCII at a fixed
	// offset. Confirmed on two lineages: a stock 2.00.06 beacon and a 7.00.07
	// one captured from hardware. This is the ONLY model evidence available at
	// flashing time, because a bootloader answers no hello - so the running
	// firmware version cannot be asked for once the radio is in this mode.
	//
	// Note this is read passively, out of a broadcast the radio sends unasked.
	// The 0x30 command is not an enquiry - it presents OUR version TO the
	// bootloader as the first step of flashing, so using it to identify a radio
	// would mean starting the flash before deciding whether flashing is safe.
	static bootloaderVersion(payload) {
		if (!payload || !K5Radio.isBootloaderBroadcast(payload)) return '';
		return K5.versionString(payload.subarray(20, 28));
	}

	// Whether the radio this bootloader belongs to can run firmware built for
	// `family`. Getting this wrong in the permissive direction writes code for
	// one chip into the other, which leaves a radio that will not start.
	static classifyBootloader(version, family = 'v1') {
		const want   = K5.FAMILIES[family];
		const actual = K5.bootloaderFamily(version);
		if (actual === family)
			return {
				ok: true, level: 'supported', family: actual,
				summary: `Bootloader ${version} — ${want.chip} hardware (${want.name}), which this firmware is built for.`,
			};

		if (actual) {
			const is = K5.FAMILIES[actual];
			return {
				ok: false, level: 'incompatible', family: actual,
				summary: `Bootloader ${version} — this radio is a ${is.name}, and the firmware you picked is for a ${want.name}.`,
				detail:
					`The radio reports bootloader ${version}, which means a ${is.chip} microcontroller (${is.name}). ` +
					`The firmware you picked is built for the ${want.chip} (${want.name}) and cannot run on it — ` +
					'installing it would leave the radio unable to start. Go back to step 1, choose ' +
					`“${is.name}” and pick a firmware from that list instead. Not sure? Take the battery off: ` +
					'a V3 says “V3” beside the barcode, often with a model like UV-K5(99).',
			};
		}

		return {
			ok: false, level: 'unknown', family: null,
			summary: `Bootloader ${version || '(unreadable)'} — not one this installer recognises.`,
			detail:
				`The radio reports bootloader ${version || 'nothing readable'}. Every UV-K5 / UV-K5(8) / UV-K6 known ` +
				'reports 2.x and every UV-K5 V3 / UV-K1 reports 7.x. This may be a variant nobody has catalogued yet, ' +
				'or different hardware. Check the label under the battery before going further.',
		};
	}

	// What we know about the attached radio, or null if it has not beaconed.
	bootloaderInfo(family = 'v1') {
		if (!this.lastBeacon) return null;
		const version = K5Radio.bootloaderVersion(this.lastBeacon);
		return { version, ...K5Radio.classifyBootloader(version, family) };
	}

	async inBootloader(timeoutMs = 1500) {
		this.drain();
		try {
			await this.expect(0x18, timeoutMs);
			return true;
		} catch { return false; }
	}

	// Poll until the radio appears in bootloader mode. `onTick` is called each
	// second so the page can count down while the user power-cycles the radio.
	async waitForBootloader(timeoutMs = 120000, onTick = () => {}) {
		const deadline = Date.now() + timeoutMs;
		this.drain();
		while (Date.now() < deadline) {
			if (!this.connected) return false;   // USB-C: the port left with the radio
			try {
				await this.expect(0x18, 1000);
				return true;
			} catch { /* keep waiting */ }
			onTick(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
		}
		return false;
	}

	static get EEPROM_SIZE()  { return 0x2000; }   // a v1 backup; see K5.FAMILIES for the V3's

	// Read every backup region of `family` into one image of its EEPROM
	// address space. A V3 is asked for 128 bytes at a time, which the ALERT /
	// F4HWN firmware answers; if the first such read gets no reply (other
	// firmware may hold a smaller buffer) it drops to serialtool's 16 for good.
	async readEeprom(onProgress = () => {}, family = 'v1') {
		const fam = K5.FAMILIES[family];
		const out = new Uint8Array(fam.backupSize).fill(0xff);
		const total = fam.backupRegions.reduce((n, [a, b]) => n + (b - a), 0);
		let step = fam.eepromBlock, done = 0, first = true;

		for (const [from, to] of fam.backupRegions) {
			for (let addr = from; addr < to; addr += step) {
				const len = Math.min(step, to - addr);
				let reply;
				try {
					reply = await this.request(K5.cmd.readEeprom(addr, len), 0x1c, 2000, first && family === 'v3' ? 1 : 3);
				} catch (err) {
					if (!(first && family === 'v3' && step > 0x10)) throw err;
					this.log(`No answer to a ${step}-byte read; reading 16 bytes at a time instead.`);
					step = 0x10;
					addr -= step;          // the loop adds it back: retry this address
					first = false;
					continue;
				}
				first = false;
				const data = reply.subarray(8, 8 + len);
				if (data.length !== len)
					throw new Error(`The radio returned ${data.length} bytes for address 0x${addr.toString(16)}, expected ${len}.`);
				// The V3 firmware echoes the address (uart.c REPLY_051B_t); check it
				// there, where the reply layout is known from source.
				const echoed = reply[4] | (reply[5] << 8);
				if (family === 'v3' && echoed !== addr)
					throw new Error(`The radio answered for address 0x${echoed.toString(16)} when asked for 0x${addr.toString(16)}.`);
				out.set(data, addr);
				done += len;
				onProgress(done / total);
			}
		}
		return out;
	}

	// Write the restore regions of `family` back from a backup image.
	async writeEeprom(bytes, onProgress = () => {}, family = 'v1') {
		const fam = K5.FAMILIES[family];
		const regions = fam.restoreRegions;
		const end = Math.max(...regions.map(([, b]) => b));
		if (bytes.length < end) throw new Error('That backup file is too short for this radio.');
		// 16 bytes per write on a V3 (two of its 8-byte flash writes), exactly as
		// serialtool restores; v1 tools have always used 0x80.
		const step = family === 'v3' ? 0x10 : 0x80;
		const total = regions.reduce((n, [a, b]) => n + (b - a), 0);
		let done = 0;
		for (const [from, to] of regions) {
			for (let addr = from; addr < to; addr += step) {
				await this.request(K5.cmd.writeEeprom(addr, bytes.subarray(addr, addr + step)), 0x1e, 2000, 3);
				done += step;
				onProgress(done / total);
			}
		}
	}

	async reset() {
		try { await this.send(K5.cmd.reset()); } catch { /* the radio may already be gone */ }
	}

	// ---- bootloader mode ---------------------------------------------------

	// Write a firmware image. `image` comes from K5.readImage(). The protocol
	// follows the bootloader the radio announced; an image for the other chip
	// is refused here too, not only by the page, unless `force` is given.
	async flash(image, onProgress = () => {}, { force = false } = {}) {
		const blFamily = K5.bootloaderFamily(K5Radio.bootloaderVersion(this.lastBeacon));
		if (blFamily && image.family && blFamily !== image.family && !force)
			throw new Error(`This image is for the ${K5.FAMILIES[image.family].chip} and the radio's bootloader ` +
			                `is a ${K5.FAMILIES[blFamily].chip} one. Nothing was written.`);
		const family = blFamily || image.family || 'v1';
		if (family === 'v3') return this._flashV3(image, onProgress);
		return this._flashV1(image, onProgress);
	}

	async _flashV1(image, onProgress) {
		const raw   = image.raw;
		const total = raw.length;
		if (total > K5.FAMILIES.v1.flashSize) throw new Error('Image too large for the radio.');

		this.drain();
		await this.send(K5.cmd.version(image.version));
		await this.expect(0x18, 3000);          // the bootloader acknowledges by carrying on

		for (let addr = 0; addr < total; addr += 0x100) {
			const block = raw.subarray(addr, Math.min(addr + 0x100, total));
			let done = false, lastErr = null;

			for (let attempt = 0; attempt < 3 && !done; attempt++) {
				try {
					await this.send(K5.cmd.flashBlock(addr, block, total));
					// the bootloader keeps broadcasting 0x18 early on; ignore those
					const deadline = Date.now() + 3000;
					for (;;) {
						const reply = await this.expect(null, Math.max(200, deadline - Date.now()));
						if (reply[0] === 0x1a) {
							const echoed = (reply[8] << 8) | reply[9];
							if (echoed !== addr)
								throw new Error(`The radio acknowledged block 0x${echoed.toString(16)} while we sent 0x${addr.toString(16)}.`);
							done = true;
							break;
						}
						if (Date.now() > deadline) throw new Error('No acknowledgement for this block.');
					}
				} catch (err) {
					lastErr = err;
					if (attempt < 2) this.log(`Block 0x${addr.toString(16)} failed (${err.message}) - retrying.`);
				}
			}
			if (!done)
				throw new Error(`Flashing stopped at address 0x${addr.toString(16)}: ${lastErr ? lastErr.message : 'no acknowledgement'}. ` +
				                'The radio is still in bootloader mode - switch it off and on holding PTT, then try again.');

			onProgress(Math.min(1, (addr + 0x100) / total));
		}
	}

	// The V3 / UV-K1 bootloader (7.x), after serialtool/_prog.py: answer three
	// beacons with the handshake, then send numbered 256-byte pages, each
	// acknowledged with its index and an error code.
	async _flashV3(image, onProgress) {
		const raw   = image.raw;
		const pages = Math.ceil(raw.length / 0x100);
		if (raw.length > K5.FAMILIES.v3.flashSize) throw new Error('Image too large for the radio.');

		const blVersion = K5Radio.bootloaderVersion(this.lastBeacon) || '7.00';
		const hello = K5.cmd.handshakeV3(blVersion);
		this.drain();
		let shaken = 0;
		for (let i = 0; i < 3; i++) {
			try {
				await this.expect(0x18, 2500);
			} catch {
				if (shaken) break;        // it has heard us and stopped beaconing: carry on
				throw new Error('The radio stopped broadcasting before the handshake. Switch it off, hold PTT, ' +
				                'switch it on, and try again.');
			}
			await this.send(hello);
			shaken++;
		}
		this.log(`Handshake sent (${JSON.stringify(blVersion.slice(0, 4))}, ${shaken}×). Writing ${pages} pages.`);

		const token = Math.floor(Date.now() / 10) >>> 0;   // any value, constant for the session
		for (let page = 0; page < pages; page++) {
			const data = raw.subarray(page * 0x100, Math.min((page + 1) * 0x100, raw.length));
			let done = false, lastErr = null;

			for (let attempt = 0; attempt < 5 && !done; attempt++) {
				try {
					await this.send(K5.cmd.flashPageV3(page, pages, data, token));
					const deadline = Date.now() + 3000;
					for (;;) {
						const reply = await this.expect(null, Math.max(200, deadline - Date.now()));
						if (reply[0] === 0x1a && reply[1] === 0x05 && reply.length >= 12) {
							const r = K5.parseFlashReplyV3(reply);
							if (r.page !== page) continue;          // a late answer to an earlier try
							if (r.err) throw new Error(`the radio refused page ${page + 1} (error ${r.err})`);
							done = true;
							break;
						}
						if (Date.now() > deadline) throw new Error('No acknowledgement for this page.');
					}
				} catch (err) {
					lastErr = err;
					if (attempt < 4) this.log(`Page ${page + 1}/${pages} failed (${err.message}) - retrying.`);
				}
			}
			if (!done)
				throw new Error(`Flashing stopped at page ${page + 1} of ${pages}: ${lastErr ? lastErr.message : 'no acknowledgement'}. ` +
				                'The radio is still in bootloader mode - switch it off and on holding PTT, then try again.');

			onProgress((page + 1) / pages);
		}
	}
}

if (typeof window !== 'undefined') window.K5Radio = K5Radio;
if (typeof module !== 'undefined' && module.exports) module.exports = K5Radio;
