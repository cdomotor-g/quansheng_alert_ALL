// The installer wizard: one page for both families of radio.
//
// Derived from the quansheng_alert installer (docs/js/app.js there), which
// knew only the UV-K5 / DP32G030. What is new here is the first question -
// which radio is this - and everything that hangs off it: the firmware list,
// the cable instructions, the backup block size, the flashing protocol, and
// the V3's USB-C port, which disappears whenever the radio is switched off.
'use strict';

const $  = (id) => document.getElementById(id);
const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

const state = {
	family: null,         // 'v1' | 'v3', chosen in step 1
	manifest: null,
	radio: null,
	image: null,          // { raw, version, packed, crcOk, family }
	imageName: '',
	imageMeta: null,      // manifest entry, when it came from this site
	backupDone: false,
	flashed: false,
	lastPortWasUsbC: false,
};

// ---------------------------------------------------------------- logging ---

const logLines = [];
function log(msg) {
	const line = `${new Date().toLocaleTimeString()}  ${msg}`;
	logLines.push(line);
	const el = $('log');
	el.textContent = logLines.join('\n');
	el.scrollTop = el.scrollHeight;
	console.log(line);
}

function say(id, msg, kind = '') {
	const el = $(id);
	el.textContent = msg;
	el.className = 'status' + (kind ? ' ' + kind : '');
}

function progress(id, fraction) {
	const box = $(id);
	box.hidden = false;
	box.firstElementChild.style.width = `${Math.round(fraction * 100)}%`;
}

const familyName = (f) => (K5.FAMILIES[f] ? K5.FAMILIES[f].name : 'radio');

// ------------------------------------------------------------------ steps ---

const STEPS = ['step-radio', 'step-fw', 'step-connect', 'step-backup', 'step-flash', 'step-done'];
let current = 0;

function setStep(index, scroll = true) {
	current = index;
	STEPS.forEach((id, i) => {
		const el = $(id);
		el.classList.toggle('locked', i > index);
		el.classList.toggle('current', i === index);
		el.classList.toggle('done', i < index);
	});
	if (scroll && index > 0) $(STEPS[index]).scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function unlock(index) {          // reach a step without jumping backwards
	if (index > current) setStep(index);
}

// ------------------------------------------------------------ file helpers --

function download(bytes, filename) {
	const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

function readFile(file) {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload  = () => resolve(new Uint8Array(r.result));
		r.onerror = () => reject(r.error);
		r.readAsArrayBuffer(file);
	});
}

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --------------------------------------------------------- browser support --

function checkSupport() {
	if (K5Radio.supported) return true;

	$('wizard').hidden   = true;
	$('toolbox').hidden  = true;
	$('unsupported').hidden = false;

	const ua = navigator.userAgent;
	let why = '';
	if (/iPhone|iPad|iPod/.test(ua))        why = 'This looks like an iPhone or iPad. iOS has no Web Serial at all, in any browser.';
	else if (/Android/.test(ua))            why = 'This looks like an Android device. Chrome on Android has no Web Serial.';
	else if (/Firefox\//.test(ua))          why = 'This looks like Firefox. Only very recent Firefox versions have Web Serial; Chrome or Edge is the safe choice.';
	else if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg/.test(ua))
	                                        why = 'This looks like Safari, which has no Web Serial.';
	else                                    why = 'Your browser did not offer the Web Serial interface this page needs.';
	$('unsupported-why').textContent = why;
	return false;
}

// ---------------------------------------------------------- step 1: radio ---

function pickFamily(family, { scroll = true } = {}) {
	if (!K5.FAMILIES[family]) return;
	const changed = state.family !== family;
	state.family = family;
	document.body.dataset.family = family;
	document.querySelectorAll('.radio-pick').forEach(b =>
		b.setAttribute('aria-pressed', String(b.dataset.family === family)));
	$('radio-chosen').hidden = false;
	$('radio-chosen').textContent = `Setting up a ${familyName(family)} (${K5.FAMILIES[family].chip} chip).`;
	log(`Radio family: ${family} (${familyName(family)}).`);
	try { localStorage.setItem(FAMILY_KEY, family); } catch { /* private window */ }

	if (changed) {
		// A firmware chosen for the other radio is no longer a valid choice.
		if (state.image && state.image.family !== family) {
			state.image = null;
			$('fw-chosen').hidden = true;
		}
		renderFirmwareCards();
		if (current > 1 && !state.image) setStep(1);
	}
	if (scroll) unlock(1); else if (current < 1) setStep(1, false);
}

const FAMILY_KEY = 'quansheng_alert_all.family';

// ------------------------------------------------------- step 2: firmware ---

async function loadManifest() {
	try {
		const res = await fetch('../firmware/manifest.json', { cache: 'no-cache' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} catch (err) {
		log(`Could not load the firmware list: ${err.message}`);
		return null;
	}
}

function renderFirmwareCards() {
	const box = $('fw-cards');
	box.innerHTML = '';
	const manifest = state.manifest;

	if (!manifest || !manifest.builds || !manifest.builds.length) {
		box.innerHTML = '<p class="warn">The built-in firmware list could not be loaded. ' +
			'You can still install a file of your own using the option below.</p>';
		return;
	}

	const builds = manifest.builds
		.filter(b => b.family === state.family)
		.sort((a, b) => (a.order || 0) - (b.order || 0));
	if (!builds.length) {
		box.innerHTML = '<p class="muted">Pick your radio in step 1 first.</p>';
		return;
	}

	for (const b of builds) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'fw';
		btn.setAttribute('aria-pressed', String(!!(state.imageMeta && state.imageMeta.id === b.id)));
		btn.innerHTML =
			(b.badge ? `<span class="badge ${escapeHtml(b.badge_kind || '')}">${escapeHtml(b.badge)}</span>` : '') +
			`<span class="name">${escapeHtml(b.title)}</span>` +
			`<span class="meta">${escapeHtml(b.description)}</span>` +
			`<span class="meta">${b.stations ? b.stations + ' stations built in · ' : ''}` +
			`${(b.size / 1024).toFixed(1)} KB · built ${escapeHtml(b.built || 'unknown')}</span>`;
		btn.addEventListener('click', () => pickBuild(b, btn));
		box.appendChild(btn);
	}
}

async function pickBuild(build, btn) {
	document.querySelectorAll('.fw').forEach(b => b.setAttribute('aria-pressed', 'false'));
	btn.setAttribute('aria-pressed', 'true');
	try {
		log(`Fetching ${build.file}…`);
		const res = await fetch(`../${build.file}`, { cache: 'no-cache' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (build.sha256 && crypto.subtle) {
			const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
			const hex = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
			if (hex !== build.sha256) throw new Error('the download did not match its published checksum');
		}
		acceptImage(bytes, build.file.split('/').pop(), build);
	} catch (err) {
		$('fw-chosen').hidden = false;
		$('fw-chosen').className = 'chosen bad';
		$('fw-chosen').textContent = `That build could not be downloaded (${err.message}). Try again, or use your own file.`;
		log(`Firmware fetch failed: ${err.message}`);
	}
}

function acceptImage(bytes, name, meta = null) {
	const image   = K5.readImage(bytes);
	const problem = K5.checkImage(image, state.family);
	const box = $('fw-chosen');
	box.hidden = false;

	if (problem) {
		box.className = 'chosen bad';
		box.textContent = problem;
		state.image = null;
		log(`Rejected ${name}: ${problem}`);
		return;
	}

	state.image     = image;
	state.imageName = name;
	state.imageMeta = meta;
	box.className = 'chosen';
	const version = K5.versionString(image.version);
	const shown = image.packed ? `version ${version || '(none)'}, checksum OK` : 'raw image';
	box.textContent = `Ready to install: ${meta ? meta.title : name} — ${(image.raw.length / 1024).toFixed(1)} KB, ` +
		`${shown}, built for the ${K5.FAMILIES[image.family].chip}.`;
	log(`Selected ${name}: ${image.raw.length} bytes, ${image.family}, version "${version}", ` +
	    `${image.packed ? 'packed' : 'raw'}${image.crcOk === false ? ', CRC BAD' : ''}.`);
	unlock(2);
}

// -------------------------------------------------------- step 3: connect ---

// A serial port can only be open in one place at a time, so whether this page
// is holding it has to be visible from anywhere on the page and impossible for
// two bits of UI to disagree about. Everything goes through here.
function setConnected(isOn, note) {
	$('btn-connect').hidden    = isOn;
	$('btn-disconnect').hidden = !isOn;
	$('portbar').hidden        = !isOn;
	$('portbar').classList.toggle('busy', !!note);
	$('portbar-text').textContent = note || 'Serial port held by this page';
}

// Open a port. Must be the first await in a click handler: the browser only
// shows its port picker during the short window a click grants.
async function openPort(statusId) {
	const radio = new K5Radio(log);
	try {
		say(statusId, 'Choose the radio or cable in the browser pop-up…', 'busy');
		await radio.connect();
	} catch (err) {
		if (err.name === 'NotFoundError')
			say(statusId, 'No port was chosen. Press the button again and pick the radio or cable from the list.', 'bad');
		else
			say(statusId, `Could not open the port: ${err.message}`, 'bad');
		log(`Connect failed: ${err.message}`);
		return null;
	}

	state.radio = radio;
	state.lastPortWasUsbC = radio.usbC;
	radio.onLost = () => {
		if (state.radio !== radio) return;
		state.radio = null;
		setConnected(false);
		if (radio.usbC) {
			say('connect-status', 'The radio’s USB port went away — that is normal on USB-C whenever the radio ' +
			    'is switched off. The next button you press will ask for it again.', 'ok');
			if (current >= 4 && !state.flashed)
				say('flash-status', 'The radio’s USB port went away as it switched off — that is expected on USB-C. ' +
				    'Now hold PTT and switch it on, then press “Install firmware now” and pick the radio again ' +
				    '(in bootloader mode it can appear under a new name).', 'ok');
		} else {
			say('connect-status', 'The cable was unplugged.', 'bad');
		}
	};
	setConnected(true);
	log(radio.usbC ? 'Connected through the radio’s own USB-C port.' : 'Connected through a USB-serial cable.');
	return radio;
}

async function connect() {
	if (state.radio && state.radio.connected) {
		say('connect-status', 'Already connected. Use "Release port" if you want to hand it back.', 'ok');
		return;
	}
	const radio = await openPort('connect-status');
	if (!radio) return;

	// Work out what state the radio is in, so the wizard can say something useful.
	say('connect-status', 'Connected. Asking the radio what it is…', 'busy');
	if (await radio.inBootloader(1500)) {
		const info = showCompatibility(radio.bootloaderInfo(state.family));
		if (info && !info.ok) {
			say('connect-status', `Connected, and the radio is in bootloader mode. ${info.summary} ` +
				'See the warning in step 5 before going any further.', 'bad');
			offerSwitch(info);
		} else {
			say('connect-status',
				`Connected — the radio is in bootloader mode (${info ? 'bootloader ' + info.version : 'no version'}). ` +
				'It cannot be backed up like this: the backup needs it switched on normally. Either switch it off and ' +
				'on normally and press "Back up my radio", or tick "skip this" to go straight to installing.', 'ok');
		}
		log('Radio detected in bootloader mode.');
		unlock(3);
		return;
	}

	try {
		const version = await radio.hello(1500);
		say('connect-status', `Connected. This radio is running: ${version}`, 'ok');
		log(`Radio firmware: ${version}`);
		hintFromVersion(version);
	} catch (err) {
		say('connect-status',
			'The port opened but the radio did not answer. Check the plugs are pushed all the way in, that the ' +
			'radio is switched on, and that no other program has the port open; then press Connect again.', 'bad');
		log(`Hello failed: ${err.message}`);
	}
	unlock(3);
}

// Stock firmware names give the family away: 2.x is a DP32G030 radio, 7.x a
// PY32F071 one. Custom firmware says anything, so only say something when the
// version is unambiguous and disagrees with step 1.
function hintFromVersion(version) {
	const fam = /^2\.\d\d\./.test(version) ? 'v1' : /^7\.\d\d\./.test(version) ? 'v3' : null;
	if (fam && fam !== state.family) {
		$('connect-hint').hidden = false;
		$('connect-hint').textContent =
			`This radio is running stock firmware ${version}, which is what a ${familyName(fam)} runs — but step 1 ` +
			`says ${familyName(state.family)}. Check the label under the battery, and change step 1 if it was wrong.`;
	} else {
		$('connect-hint').hidden = true;
	}
}

// When the bootloader names the other family, offer the one-click fix.
function offerSwitch(info) {
	if (!info || !info.family || info.family === state.family) return;
	$('compat-switch').hidden = false;
	$('compat-switch').textContent = `Switch to firmware for the ${familyName(info.family)}`;
	$('compat-switch').onclick = () => {
		pickFamily(info.family, { scroll: false });
		$('compat-block').hidden = true;
		$('compat-switch').hidden = true;
		say('flash-status', '');
		$('step-fw').scrollIntoView({ behavior: 'smooth', block: 'center' });
	};
}

// Hand the port back. Every step inside disconnect() is capped, so this always
// finishes and the page always ends up usable.
async function disconnect() {
	if (state.releasing) return;
	state.releasing = true;
	const radio = state.radio;
	$('btn-disconnect').disabled = true;
	$('btn-release').disabled = true;
	setConnected(true, 'Releasing the serial port…');
	try {
		state.radio = null;
		if (radio) await radio.disconnect();
		say('connect-status', 'Disconnected. The port is free for other programs.');
	} catch (err) {
		say('connect-status', `Released, but the browser reported: ${err.message}`, 'bad');
	} finally {
		state.releasing = false;
		$('btn-disconnect').disabled = false;
		$('btn-release').disabled = false;
		setConnected(false);
	}
}

// --------------------------------------------------------- step 4: backup ---

// Is this region of a backup only the 0xFF an unread or empty area returns?
function looksEmpty(bytes, [from, to]) {
	const part = bytes.subarray(from, to);
	return part.every(b => b === 0xff) || part.every(b => b === 0x00);
}

// Used by step 4 and, on a V3, again from the done step once the new firmware
// is running - the backup UV Studio and F4HWN recommend taking.
async function backup(statusId = 'backup-status', progressId = 'backup-progress', buttonId = 'btn-backup') {
	if (!state.radio || !state.radio.connected) {
		const radio = await openPort(statusId);
		if (!radio) return;
	}
	const family = state.family;
	$(buttonId).disabled = true;
	say(statusId, 'Reading the radio… this takes about ten seconds.', 'busy');
	try {
		if (await state.radio.inBootloader(600))
			throw new Error('the radio is in bootloader mode');
		let version = '';
		try { version = await state.radio.hello(1500); } catch { /* the reads below will say */ }
		const bytes = await state.radio.readEeprom(f => progress(progressId, f), family);
		const model = family === 'v3' ? 'uvk1-v3' : 'uvk5';
		const name  = `${model}-backup-${stamp()}.bin`;
		download(bytes, name);
		remember(name, bytes, family);
		state.backupDone = true;

		const cal = K5.FAMILIES[family].calibration;
		if (looksEmpty(bytes, cal)) {
			say(statusId, `Saved as ${name}, but its calibration area came back empty, so it is probably not a ` +
				'useful backup. ' + (family === 'v3'
					? 'Stock V3 firmware does not lay its memory out the way this tool reads it. That is safe to ' +
					  'carry on from: installing never touches calibration, which lives on a separate memory chip. ' +
					  'Take the backup again from the done step, once the new firmware is running.'
					: 'Check the radio is switched on normally and try again.'), 'bad');
		} else {
			say(statusId, `Saved as ${name} in your Downloads folder. A copy is kept in this browser too, ` +
				'under "Backups and installs on this computer". Keep it somewhere safe.', 'ok');
		}
		log(`EEPROM backup complete (${family}, firmware "${version}"): ${bytes.length} bytes -> ${name}`);
		if (statusId === 'backup-status') unlock(4);
	} catch (err) {
		const stockV3 = family === 'v3';
		say(statusId,
			`The backup did not finish: ${err.message}. The radio must be switched on normally ` +
			'(not in bootloader mode) for this step.' + (stockV3 && statusId === 'backup-status'
				? ' If it is on normally and still fails, it may be running stock firmware that does not answer ' +
				  'these commands. Installing does not touch the calibration, so it is safe to tick “skip this” ' +
				  'and take the backup from the done step afterwards.'
				: ''), 'bad');
		log(`Backup failed: ${err.message}`);
	} finally {
		$(buttonId).disabled = false;
	}
}

// ---------------------------------------------------------- step 5: flash ---

const OVERRIDE_PHRASE = 'FLASH ANYWAY';

// Show what the bootloader says about itself. Returns the classification so the
// caller can decide; showing it is not the same as allowing it.
function showCompatibility(info) {
	const box = $('compat-block');
	if (!info || info.ok) { box.hidden = true; $('compat-switch').hidden = true; return info; }
	box.hidden = false;
	box.classList.toggle('bad', info.level === 'incompatible');
	$('compat-summary').textContent = info.summary;
	$('compat-detail').textContent  = info.detail || '';
	// Overriding is for an unrecognised bootloader. For a known one of the
	// other family it would only ever brick the radio, so it is not offered.
	$('compat-override-wrap').hidden = info.level === 'incompatible';
	offerSwitch(info);
	log(`Bootloader compatibility: ${info.level} — ${info.summary}`);
	return info;
}

function overrideGiven() {
	return $('compat-override').value.trim().toUpperCase() === OVERRIDE_PHRASE;
}

async function flash() {
	if (!state.image) { say('flash-status', 'Pick a firmware in step 2 first.', 'bad'); return; }

	// On USB-C the port vanished when the radio was switched off, so ask for it
	// again now, while this click still allows the browser's port picker.
	if (!state.radio || !state.radio.connected) {
		const radio = await openPort('flash-status');
		if (!radio) return;
	}

	$('btn-flash').disabled = true;
	try {
		if (!await state.radio.inBootloader(1200)) {
			const hint = state.radio.usbC
				? 'Switch the radio off (this page will ask for the port again), hold PTT and switch it on.'
				: 'Switch it off, hold PTT, switch it on.';
			say('flash-status', `Waiting for the radio in bootloader mode — ${hint}`, 'busy');
			const found = await state.radio.waitForBootloader(120000, secs => {
				say('flash-status', `Waiting for the radio in bootloader mode… (${secs}s left). ${hint}`, 'busy');
			});
			if (!found) {
				if (!state.radio || !state.radio.connected) return;   // USB-C went away: onLost said what to do
				say('flash-status',
					'The radio never appeared in bootloader mode. Switch it off, hold the PTT button down, ' +
					'and switch it on while still holding PTT — the screen should stay blank. Then press Install again.', 'bad');
				return;
			}
		}

		// The radio is in bootloader mode, so it has told us what it is. This is
		// the last moment anything can be known about the hardware before we
		// start writing to its flash.
		const info = showCompatibility(state.radio.bootloaderInfo(state.family));
		let force = false;
		if (info && !info.ok) {
			if (info.level === 'incompatible' || !overrideGiven()) {
				say('flash-status',
					`${info.summary} Nothing has been written to the radio. ` +
					(info.level === 'incompatible'
						? 'Use the button above to switch to the right firmware.'
						: 'Check the label under the battery. If you are certain this is the right firmware, open ' +
						  `"Install it anyway" above and type the phrase ${OVERRIDE_PHRASE}.`), 'bad');
				log(`Flash refused: bootloader ${info.version || '(unreadable)'} is ${info.level}.`);
				return;
			}
			force = true;
			log(`Compatibility check OVERRIDDEN by the user for bootloader ${info.version}.`);
		}

		log(`Flashing ${state.imageName} (${state.image.raw.length} bytes)…`);
		say('flash-status', 'Installing — do not unplug anything or switch the radio off.', 'busy');
		await state.radio.flash(state.image, f => progress('flash-progress', f), { force });

		state.flashed = true;
		rememberInstall();
		say('flash-status', 'Installed.', 'ok');
		log('Flash complete.');
		unlock(5);
		verifyAfterReboot();
	} catch (err) {
		say('flash-status', err.message, 'bad');
		log(`Flash failed: ${err.message}`);
	} finally {
		$('btn-flash').disabled = false;
	}
}

// After a flash, watch for the radio coming back on normal firmware and read
// its version, so the user is told it actually worked rather than hoping. On
// USB-C the port drops as the radio restarts, so that check needs a click.
async function verifyAfterReboot() {
	$('btn-verify').hidden = true;
	$('done-summary').className = 'status';
	$('done-summary').textContent = state.lastPortWasUsbC
		? 'The radio restarts by itself after a USB-C install (if it does not, switch it off and on). ' +
		  'Press “Check what it is running” once its normal screen is back.'
		: 'Switch the radio off and on again (normally, without PTT) and this page will confirm what it is running…';
	const deadline = Date.now() + 90000;
	while (Date.now() < deadline && state.radio && state.radio.connected) {
		try {
			const version = await state.radio.hello(1200);
			doneConfirmed(version);
			return;
		} catch { /* not back yet */ }
	}
	$('btn-verify').hidden = false;
	if (!state.lastPortWasUsbC)
		$('done-summary').textContent =
			'Installed. (This page could not read the version back automatically — that is only the check, not the ' +
			'install. Switch the radio on normally and press “Check what it is running”, or look at the boot screen.)';
}

function doneConfirmed(version) {
	$('done-summary').textContent = `Confirmed: the radio is now running ${version}.`;
	$('done-summary').className = 'status ok';
	$('btn-verify').hidden = true;
	log(`Verified after reboot: ${version}`);
}

async function verifyClick() {
	if (!state.radio || !state.radio.connected) {
		const radio = await openPort('done-summary');
		if (!radio) return;
	}
	say('done-summary', 'Asking the radio…', 'busy');
	try {
		doneConfirmed(await state.radio.hello(1500));
	} catch (err) {
		say('done-summary', `The radio did not answer (${err.message}). Is it switched on normally?`, 'bad');
	}
}

// ------------------------------------------------------------- local store --

const STORE = 'quansheng_alert_all.history';

function history() {
	try { return JSON.parse(localStorage.getItem(STORE) || '[]'); }
	catch { return []; }
}

function saveHistory(items) {
	try { localStorage.setItem(STORE, JSON.stringify(items.slice(0, 8))); }
	catch (err) { log(`Could not save to browser storage: ${err.message}`); }
	renderHistory();
}

function remember(name, bytes, family) {
	const items = history();
	items.unshift({
		kind: 'backup', name, when: new Date().toISOString(), family,
		size: bytes.length, data: bytesToBase64(bytes),
	});
	// keep at most three copies: 8 KB each for a UV-K5, 45 KB for a V3
	let backups = 0;
	saveHistory(items.filter(i => i.kind !== 'backup' || ++backups <= 3));
}

function rememberInstall() {
	const items = history();
	items.unshift({
		kind: 'install',
		name: state.imageMeta ? state.imageMeta.title : state.imageName,
		when: new Date().toISOString(),
		family: state.image.family,
		size: state.image.raw.length,
		version: K5.versionString(state.image.version),
	});
	saveHistory(items);
}

function bytesToBase64(bytes) {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function base64ToBytes(b64) {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

function renderHistory() {
	const items = history();
	const box = $('history');
	if (!items.length) { box.innerHTML = '<p class="muted">Nothing recorded yet.</p>'; return; }

	const rows = items.map((it, i) => {
		const when = new Date(it.when).toLocaleString();
		const radio = it.family ? ` — ${escapeHtml(familyName(it.family))}` : '';
		const what = it.kind === 'backup'
			? `Backup of your radio (${(it.size / 1024).toFixed(0)} KB)${radio}`
			: `Installed ${escapeHtml(it.name)}${it.version ? ' — ' + escapeHtml(it.version) : ''}`;
		const action = it.kind === 'backup'
			? `<button class="ghost" data-save="${i}">Save again</button>`
			: '';
		return `<tr><td>${when}</td><td>${what}</td><td>${action}</td></tr>`;
	}).join('');

	box.innerHTML = `<table class="hist"><thead><tr><th>When</th><th>What</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
	box.querySelectorAll('[data-save]').forEach(btn => {
		btn.addEventListener('click', () => {
			const it = history()[+btn.dataset.save];
			download(base64ToBytes(it.data), it.name);
		});
	});
}

// ---------------------------------------------------------------- toolbox ---

async function identify() {
	if (!state.radio || !state.radio.connected) {
		const radio = await openPort('identify-status');
		if (!radio) return;
	}
	try {
		if (await state.radio.inBootloader(1200)) {
			const info = state.radio.bootloaderInfo(state.family || 'v1');
			const fam  = info && K5.bootloaderFamily(info.version);
			say('identify-status', `The radio is in bootloader mode, bootloader ${info ? info.version : '(unreadable)'}` +
				(fam ? ` — that is a ${familyName(fam)} (${K5.FAMILIES[fam].chip}).` : '.') +
				' Switch it on normally to ask which firmware it runs.', 'ok');
			return;
		}
		const version = await state.radio.hello(1500);
		say('identify-status', `This radio is running: ${version}`, 'ok');
	} catch (err) {
		say('identify-status', `The radio did not answer: ${err.message}`, 'bad');
	}
}

// Toolbox -> Check the cable. The browser-side version of tools/k5diag.py:
// identify the adapter, listen at 38400, ask a hello, and only if bytes are
// arriving that do not frame, try the other rates.

const CHIPS = {
	'1a86:7523': 'CH340, the usual K5 cable chip',
	'1a86:55d4': 'CH9102',
	'10c4:ea60': 'CP210x',
	'067b:2303': 'PL2303 - often counterfeit, and current Windows drivers refuse those',
	'067b:23a3': 'PL2303GC',
	'0403:6001': 'FTDI FT232',
	'36b7:ffff': 'the radio’s own USB-C port (UV-K5 V3 / UV-K1, firmware running)',
};
const SCAN_BAUDS = [38400, 115200, 57600, 19200, 9600, 76800, 128000, 230400, 4800, 460800];

const hexOf = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');

function reportTo(id) {
	const box = $(id);
	box.textContent = '';
	box.hidden = false;
	return (line) => {
		box.textContent += (box.textContent ? '\n' : '') + line;
		log(line);
	};
}

async function checkCable() {
	if (!state.radio || !state.radio.connected) {
		const opened = await openPort('cable-status');
		if (!opened) return;
	}
	const radio = state.radio;
	const line  = reportTo('cable-report');
	const done  = (msg, kind) => { say('cable-status', msg, kind); line('=> ' + msg); };
	$('btn-cable').disabled = true;
	$('btn-loopback').disabled = true;
	try {
		const { vid, pid } = radio.info();
		if (vid) {
			const key = `${vid.toString(16).padStart(4, '0')}:${pid.toString(16).padStart(4, '0')}`;
			line(`Adapter: USB ${key}` + (CHIPS[key] ? ` - ${CHIPS[key]}` :
				vid === K5Radio.RADIO_VID ? ' - the radio’s own USB-C port (bootloader mode, probably)' : ''));
		} else {
			line('Adapter: no USB identity (a built-in COM port, or a driver that hides it)');
		}

		const secs = 3;
		say('cable-status', `Listening for ${secs} seconds…`, 'busy');
		if (radio.baud !== K5Radio.BAUD) await radio.reopen(K5Radio.BAUD);
		const r = await radio.listen(secs * 1000);
		line(`Listened ${secs} s at 38400: ${r.bytes} bytes, ${r.packets} packets framed, ` +
		     `${r.beacons} bootloader beacons` + (r.sample.length ? `\n  first bytes: ${hexOf(r.sample)}` : ''));

		if (r.beacons) {
			const info = radio.bootloaderInfo(state.family || 'v1');
			const fam  = info && K5.bootloaderFamily(info.version);
			done(`The radio is in bootloader mode and the connection is good: ${r.beacons} beacons in ${secs} s` +
			     (info ? `, bootloader ${info.version}${fam ? ` (${familyName(fam)})` : ''}` : '') + '. ' +
			     'If installing still fails, the cause is on this computer: usually another program (a terminal, ' +
			     'CHIRP, another tab) holding the port, or the browser being given the wrong port.', 'ok');
			return;
		}
		if (r.packets) {
			done(`${r.packets} packets arrived, but none were bootloader beacons. The line is good. ` +
			     'Use "What is my radio running?" to identify the firmware.', 'ok');
			return;
		}

		say('cable-status', 'Nothing unprompted. Asking the radio for its version…', 'busy');
		try {
			const version = await radio.hello(1500);
			line(`Hello: answered, running ${version}`);
			done(`The radio answered when asked: it is switched on normally and running ${version}. ` +
			     'The connection works in both directions.', 'ok');
			return;
		} catch {
			line('Hello: no answer');
		}

		if (radio.usbC) {
			done('The radio’s USB port is open but nothing came back. Switch the radio off and on, close any other ' +
			     'program using the port (alertterm, a terminal, UV Studio, CHIRP), and try again.', 'bad');
			return;
		}

		if (!r.bytes) {
			done(`Nothing arrived in ${secs} s and the radio did not answer a hello. If it is in bootloader ` +
			     'mode (blank screen), its transmit line is not reaching the adapter: swap TX and RX at the adapter ' +
			     'end, and check the 2.5 mm plug is fully home. If it is switched on normally, check the same ' +
			     'things plus the 3.5 mm plug. To rule the adapter itself out, short its TX to its RX and press ' +
			     '"Test the adapter alone".', 'bad');
			return;
		}

		line('');
		line('Bytes arrived that did not frame, so trying every plausible rate (radio in bootloader mode, please):');
		line('   baud   bytes  packets  beacons');
		const results = {};
		for (const baud of SCAN_BAUDS) {
			say('cable-status', `Trying ${baud} baud…`, 'busy');
			try {
				await radio.reopen(baud);
			} catch {
				line(`${String(baud).padStart(7)}  the driver would not open the port at this rate`);
				continue;
			}
			const s = await radio.listen(1500);
			results[baud] = s;
			line(`${String(baud).padStart(7)}  ${String(s.bytes).padStart(6)}  ${String(s.packets).padStart(7)}  ${String(s.beacons).padStart(7)}`);
		}
		await radio.reopen(K5Radio.BAUD);

		const framed = SCAN_BAUDS.filter(b => results[b] && results[b].packets);
		const noisy  = SCAN_BAUDS.filter(b => results[b] && results[b].bytes);
		if (framed.includes(K5Radio.BAUD)) {
			done('Valid packets at 38400 this time - the standard rate - so the earlier run caught noise. ' +
			     'Nothing needs changing; run the check again.', 'ok');
		} else if (framed.length) {
			done(`Valid packets only at ${framed[0]} baud, which no known Quansheng bootloader uses. Check the ` +
			     'adapter\'s driver is not applying a divisor.', 'bad');
		} else if (noisy.length) {
			done('Bytes at some rates but no valid packet at any of them. It is not the rate: look for an ' +
			     'inverted signal, plugs not fully home, or a 5 V adapter loading the line.', 'bad');
		} else {
			done('Silence at every rate. The radio\'s transmit line is not reaching the adapter: wrong contact ' +
			     'on the 2.5 mm plug, TX/RX swapped, or the radio is not actually in bootloader mode.', 'bad');
		}
	} catch (err) {
		say('cable-status', `The check stopped: ${err.message}`, 'bad');
		line(`Stopped: ${err.message}`);
	} finally {
		if (radio.connected && radio.baud !== K5Radio.BAUD) {
			try { await radio.reopen(K5Radio.BAUD); } catch { /* reported above */ }
		}
		$('btn-cable').disabled = false;
		$('btn-loopback').disabled = false;
	}
}

// Toolbox -> Test the adapter alone. Adapter TX shorted to RX, no radio.
async function testAdapter() {
	if (!state.radio || !state.radio.connected) {
		const opened = await openPort('cable-status');
		if (!opened) return;
	}
	const line = reportTo('cable-report');
	$('btn-cable').disabled = true;
	$('btn-loopback').disabled = true;
	say('cable-status', 'Sending a test string and waiting for it to come back…', 'busy');
	try {
		const r = await state.radio.loopback();
		line(`Loopback: sent ${hexOf(r.sent)}` + (r.got.length ? `\n  got  ${hexOf(r.got)}` : '\n  got nothing'));
		if (r.ok) {
			say('cable-status', 'The adapter echoed the test string: the adapter and its driver work. ' +
			    'Now remove the short, plug the radio in and run "Check the cable".', 'ok');
		} else if (r.got.length) {
			say('cable-status', 'A garbled echo came back: the adapter is talking to itself but corrupting data. ' +
			    'Try another USB port or another adapter; counterfeit PL2303s do this.', 'bad');
		} else {
			say('cable-status', 'No echo. Either TX and RX are not actually shorted, or the adapter or its driver ' +
			    'is dead. Nothing about the radio can be tested until this passes.', 'bad');
		}
	} catch (err) {
		say('cable-status', `The test stopped: ${err.message}`, 'bad');
	} finally {
		$('btn-cable').disabled = false;
		$('btn-loopback').disabled = false;
	}
}

let restoreBytes = null;

// A backup made here is an image of the radio's EEPROM address space (see
// K5.FAMILIES). On a V3 a bare 512-byte file is taken as the calibration alone.
async function pickRestoreFile(ev) {
	const file = ev.target.files[0];
	if (!file) return;
	let bytes = await readFile(file);
	const family = state.family || 'v1';
	const fam = K5.FAMILIES[family];
	if (family === 'v3' && bytes.length === fam.calibration[1] - fam.calibration[0]) {
		const image = new Uint8Array(fam.backupSize).fill(0xff);
		image.set(bytes, fam.calibration[0]);
		bytes = image;
	}
	if (bytes.length < fam.backupSize || (family === 'v1' && bytes.length !== fam.backupSize)) {
		say('restore-status', `That file is ${file.size} bytes, which is not a ${familyName(family)} backup ` +
			`(${fam.backupSize} bytes${family === 'v3' ? ', or a 512-byte calibration file' : ''}). ` +
			'Check step 1 names the right radio.', 'bad');
		$('btn-restore').disabled = true;
		restoreBytes = null;
		return;
	}
	if (looksEmpty(bytes, fam.calibration)) {
		say('restore-status', 'The calibration in that file is empty, so writing it would wipe the radio’s ' +
			'calibration. Pick a different backup.', 'bad');
		$('btn-restore').disabled = true;
		restoreBytes = null;
		return;
	}
	restoreBytes = bytes;
	$('btn-restore').disabled = false;
	say('restore-status', `${file.name} looks like a valid ${familyName(family)} backup. Press the button to write ` +
		(family === 'v3' ? 'its calibration back.' : 'it back.'));
}

async function restore() {
	if (!restoreBytes) return;
	if (!state.family) { say('restore-status', 'Pick your radio in step 1 first, so the right method is used.', 'bad'); return; }
	const what = state.family === 'v3'
		? 'This replaces the radio’s factory calibration (channels and settings are left alone).'
		: 'This replaces every channel, setting and the factory calibration.';
	if (!confirm(`Write this backup into the radio?\n\n${what} Only do it with a backup taken from this same radio.`))
		return;
	if (!state.radio || !state.radio.connected) {
		const opened = await openPort('restore-status');
		if (!opened) return;
	}

	$('btn-restore').disabled = true;
	say('restore-status', 'Writing…', 'busy');
	try {
		if (state.family === 'v3') {
			// The address map is the F4HWN-based firmware's; stock V3 firmware
			// is not known to share it, so do not write through it blind.
			const version = await state.radio.hello(1500);
			if (!/F4HWN|ALERT/i.test(version))
				throw new Error(`the radio is running ${version}. Restoring a V3 calibration needs this site’s ` +
				                'firmware (or another F4HWN build) installed first, because only that memory layout is known');
		}
		await state.radio.writeEeprom(restoreBytes, f => progress('restore-progress', f), state.family);
		await state.radio.reset();
		say('restore-status', 'Restored. The radio has been told to restart.', 'ok');
		log('EEPROM restore complete.');
	} catch (err) {
		say('restore-status', `The restore did not finish: ${err.message}`, 'bad');
		log(`Restore failed: ${err.message}`);
	} finally {
		$('btn-restore').disabled = false;
	}
}

// ------------------------------------------------------------------- init ---

async function init() {
	renderHistory();
	if (!checkSupport()) return;

	setStep(0);
	state.manifest = await loadManifest();

	document.querySelectorAll('.radio-pick').forEach(btn =>
		btn.addEventListener('click', () => pickFamily(btn.dataset.family)));

	// ?radio=v3 (or v1) from the guide's links pre-selects the radio.
	const asked = new URLSearchParams(location.search).get('radio');
	let remembered = null;
	try { remembered = localStorage.getItem(FAMILY_KEY); } catch { /* private window */ }
	if (K5.FAMILIES[asked]) {
		pickFamily(asked, { scroll: false });
	} else {
		renderFirmwareCards();
		if (K5.FAMILIES[remembered]) {
			$('radio-remembered').hidden = false;
			$('radio-remembered').textContent = `Last time you set up a ${familyName(remembered)} on this computer.`;
		}
	}

	on('fw-file', 'change', async (ev) => {
		const file = ev.target.files[0];
		if (!file) return;
		if (!state.family) { $('fw-file-status').textContent = 'Pick your radio in step 1 first.'; return; }
		document.querySelectorAll('.fw').forEach(b => b.setAttribute('aria-pressed', 'false'));
		$('fw-file-status').textContent = `Checking ${file.name}…`;
		try {
			acceptImage(await readFile(file), file.name);
			$('fw-file-status').textContent = '';
		} catch (err) {
			$('fw-file-status').textContent = `Could not read that file: ${err.message}`;
		}
	});

	on('btn-connect',    'click', connect);
	on('btn-disconnect', 'click', disconnect);
	on('btn-release',    'click', disconnect);
	on('btn-backup',     'click', () => backup());
	on('btn-backup-after', 'click', () => backup('backup-after-status', 'backup-after-progress', 'btn-backup-after'));
	on('btn-flash',      'click', flash);
	on('btn-verify',     'click', verifyClick);
	on('btn-identify',   'click', identify);
	on('btn-cable',      'click', checkCable);
	on('btn-loopback',   'click', testAdapter);
	on('btn-restore',    'click', restore);
	on('restore-file',   'change', pickRestoreFile);

	on('skip-backup', 'change', (ev) => {
		if (ev.target.checked) {
			say('backup-status', 'Backup skipped. Make sure you already have one saved somewhere safe.', 'bad');
			unlock(4);
		}
	});

	on('btn-copylog', 'click', async () => {
		try { await navigator.clipboard.writeText(logLines.join('\n')); log('Log copied to the clipboard.'); }
		catch { log('The browser would not let the page copy to the clipboard - select the text instead.'); }
	});

	on('btn-restart', 'click', () => {
		state.backupDone = false;
		state.flashed = false;
		['backup-status', 'flash-status', 'done-summary'].forEach(id => say(id, ''));
		['backup-progress', 'flash-progress'].forEach(id => { $(id).hidden = true; $(id).firstElementChild.style.width = '0'; });
		$('skip-backup').checked = false;
		setStep(0);
		$('step-radio').scrollIntoView({ behavior: 'smooth', block: 'center' });
	});

	window.addEventListener('beforeunload', (ev) => {
		if ($('btn-flash').disabled && !state.flashed) { ev.preventDefault(); ev.returnValue = ''; }
	});

	log('Installer ready.');
}

init();
