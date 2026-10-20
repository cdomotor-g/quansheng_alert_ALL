// Quansheng UV-K5 / UV-K1 serial protocol - pure functions, no I/O.
//
// Two radio families share one wire format and most of one command set:
//
//   v1  UV-K5, UV-K5(8), UV-K6, UV-5R Plus - DP32G030 MCU, bootloader 2.x,
//       firmware linked at 0x00000000, at most 0xF000 bytes.
//   v3  UV-K5 V3, UV-K1 - PY32F071 MCU, bootloader 7.x, firmware linked at
//       0x08002800, at most 118 KB.
//
// The v1 half was written for quansheng_alert from the protocol as documented
// by sq5bpf/k5prog and whosmatt/uvmod / egzumer/uvtools (none of their code is
// copied). The v3 flashing half follows muzkr's serialtool (MIT), as shipped in
// cdomotor-g/quansheng_alert_v3/tools/serialtool, which has flashed real V3
// radios: same framing, a different handshake and a different page header.
//
// Wire format, both families, both modes, 38400 8N1 (the V3's USB-C port is a
// CDC device and ignores the baud rate):
//
//   AB CD | len_lo len_hi | XOR( payload || crc16_xmodem(payload) ) | DC BA
//
// `len` counts the payload only; the two CRC bytes sit inside the obfuscated
// section but outside the length. Every payload starts with a little-endian
// 16-bit message type (0x0514, 0x0518, ...) and a 16-bit body length.
//
// The radio does not checksum what it sends, in either mode. The firmware puts
// 0xFFFF where the CRC belongs; a 7.00.07 bootloader puts a fixed 0x6ed1 that
// matches no CRC-16 variant over any span. Both were captured from hardware.
// So `crcOk` on a received packet means "this happened to verify", almost
// always false, and callers MUST NOT use it to discard anything. Only what we
// transmit is checksummed for real.
//
// Normal mode (radio switched on the usual way, firmware running) - both:
//   0x0514 hello            -> 0x0515 reply carrying the firmware version at [4..]
//   0x051B read EEPROM      -> 0x051C reply, data at [8..]
//   0x051D write EEPROM     -> 0x051E reply
//   0x05DD reset the radio   (no reply)
// The four bytes after hello/read/write's header are a session token; every
// command in one session must carry the same value.
//
// Bootloader mode (hold PTT while switching on) - both families broadcast
// 0x0518 "I am in flash mode" with the bootloader version as ASCII at [20..].
//   v1: 0x0530 + 16-byte firmware version -> the beacons carry on
//       0x0519 flash block, addressed by byte -> 0x051A
//   v3: 0x0530 + first 4 chars of the bootloader's own version, sent once per
//       beacon for three beacons (a fresh 7.x bootloader rejects every page
//       with err=1 until it has seen this)
//       0x0519 flash page, by index and count -> 0x051A with an error code
// There is no read-flash command in any known bootloader, which is why the
// firmware on a radio cannot be backed up - only the EEPROM can.

'use strict';

const K5 = (() => {

	// ---- obfuscation and checksum -----------------------------------------

	const XOR_KEY = Uint8Array.of(
		0x16, 0x6c, 0x14, 0xe6, 0x2e, 0x91, 0x0d, 0x40,
		0x21, 0x35, 0xd5, 0x40, 0x13, 0x03, 0xe9, 0x80);

	function xorInPlace(bytes) {
		for (let i = 0; i < bytes.length; i++)
			bytes[i] ^= XOR_KEY[i % XOR_KEY.length];
		return bytes;
	}

	function xorCopy(bytes) {
		return xorInPlace(Uint8Array.from(bytes));
	}

	// CRC-16/XMODEM: poly 0x1021, init 0, no reflection, no final xor.
	function crc16(bytes, crc = 0) {
		for (let i = 0; i < bytes.length; i++) {
			crc ^= bytes[i] << 8;
			for (let bit = 0; bit < 8; bit++)
				crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
			crc &= 0xffff;
		}
		return crc;
	}

	// ---- packet codec ------------------------------------------------------

	const SOF = Uint8Array.of(0xab, 0xcd);
	const EOF = Uint8Array.of(0xdc, 0xba);

	function frame(payload) {
		const sum  = crc16(payload);
		const body = new Uint8Array(payload.length + 2);
		body.set(payload, 0);
		body[payload.length]     = sum & 0xff;
		body[payload.length + 1] = (sum >> 8) & 0xff;
		xorInPlace(body);

		const packet = new Uint8Array(body.length + 6);
		packet.set(SOF, 0);
		packet[2] = payload.length & 0xff;
		packet[3] = (payload.length >> 8) & 0xff;
		packet.set(body, 4);
		packet.set(EOF, packet.length - 2);
		return packet;
	}

	// Pull complete packets out of a rolling receive buffer. Returns
	// { packets: [{ payload, crcOk }...], rest: Uint8Array }. Malformed or
	// partial data at the front is dropped a byte at a time so the stream
	// re-syncs by itself after line noise - or after the text lines the V3
	// ALERT firmware prints on the same USB port.
	function deframe(buffer) {
		const packets = [];
		let at = 0;

		for (;;) {
			while (at + 1 < buffer.length && !(buffer[at] === 0xab && buffer[at + 1] === 0xcd))
				at++;
			if (at + 8 > buffer.length)
				break;   // need at least an empty packet's worth of bytes

			const len   = buffer[at + 2] | (buffer[at + 3] << 8);
			const total = len + 8;
			if (len > 0x400) { at++; continue; }              // implausible: re-sync
			if (at + total > buffer.length) break;            // wait for the rest

			if (buffer[at + total - 2] !== 0xdc || buffer[at + total - 1] !== 0xba) {
				at++;                                         // bad footer: re-sync
				continue;
			}

			const body    = xorCopy(buffer.subarray(at + 4, at + total - 2));
			const payload = body.subarray(0, len);
			const want    = body[len] | (body[len + 1] << 8);
			packets.push({ payload, crcOk: crc16(payload) === want });
			at += total;
		}

		return { packets, rest: buffer.subarray(at) };
	}

	// ---- radio families ----------------------------------------------------

	// Everything that differs between the two lines of hardware, in one place.
	// `bootloader` is the version prefix the radio's beacon carries; `flashBase`
	// and `flashSize` bound where a firmware image's reset vector may point and
	// how big the image may be.
	//
	// The "EEPROM" is addressed the same way on both (0x051B/0x051D with a
	// 16-bit address) but laid out differently. A v1 radio has a real 8 KB
	// EEPROM with the calibration at 0x1E00. A V3 has none: its firmware maps a
	// 16-bit "EEPROM" address space onto the SPI flash chip
	// (quansheng_alert_v3/App/driver/eeprom_compat.c), with channels at 0x0000,
	// settings at 0xA000 and the 512-byte calibration at 0xB000 - so the v1
	// range 0x0000-0x1FFF on a V3 is channel memory, not calibration. Backup
	// files are an image of that address space from 0 to `backupSize`, with
	// anything not read left as 0xFF; `restoreRegions` is what a restore puts
	// back.
	const FAMILIES = {
		v1: {
			id: 'v1',
			name: 'UV-K5 / UV-K5(8) / UV-K6 / UV-5R Plus',
			chip: 'DP32G030',
			bootloader: /^2\./,
			flashBase: 0x00000000,
			flashSize: 0xf000,
			eepromBlock: 0x80,
			backupSize: 0x2000,
			backupRegions:  [[0x0000, 0x2000]],
			restoreRegions: [[0x0000, 0x2000]],
			calibration: [0x1e00, 0x2000],
		},
		v3: {
			id: 'v3',
			name: 'UV-K5 V3 / UV-K1',
			chip: 'PY32F071',
			bootloader: /^7\./,
			flashBase: 0x08002800,
			flashSize: 118 * 1024,
			eepromBlock: 0x80,          // the firmware's reply holds 128 bytes; serialtool reads 16
			backupSize: 0xb200,
			backupRegions: [
				[0x0000, 0x8870],       // channel frequencies, names, attributes, scan-list names
				[0x9000, 0x90f0],       // VFOs and fox-hunt settings
				[0xa000, 0xa180],       // settings, including the ALERT app's at 0xA170
				[0xb000, 0xb200],       // calibration
			],
			// Calibration only, as UV Studio does: it is the part that cannot be
			// recreated, and writing a settings block from another firmware
			// version into this one is not something to do blind.
			restoreRegions: [[0xb000, 0xb200]],
			calibration: [0xb000, 0xb200],
		},
	};

	// Both chips have 16 KB of SRAM at 0x20000000, so the initial stack pointer
	// of any real image sits in (0x20000000, 0x20004000].
	function plausibleSp(sp) {
		return sp >>> 0 > 0x20000000 && sp >>> 0 <= 0x20004000;
	}

	// Which family a raw image was linked for, judged from its vector table:
	// the reset vector must be a Thumb address inside that chip's program area.
	// Returns 'v1', 'v3' or null.
	function imageFamily(raw) {
		if (!raw || raw.length < 8) return null;
		const sp    = (raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24)) >>> 0;
		const reset = (raw[4] | (raw[5] << 8) | (raw[6] << 16) | (raw[7] << 24)) >>> 0;
		if (!plausibleSp(sp) || (reset & 1) !== 1) return null;
		for (const f of Object.values(FAMILIES))
			if (reset >= f.flashBase && reset < f.flashBase + f.flashSize) return f.id;
		return null;
	}

	// Which family a bootloader version string implies, or null.
	function bootloaderFamily(version) {
		for (const f of Object.values(FAMILIES))
			if (f.bootloader.test(version || '')) return f.id;
		return null;
	}

	// ---- commands ----------------------------------------------------------

	// The session token. Any four bytes work as long as they stay the same for
	// the whole session; these are the ones k5prog has always used.
	const SESSION = Uint8Array.of(0x6a, 0x39, 0x57, 0x64);

	const cmd = {
		// normal mode
		hello() {
			return Uint8Array.of(0x14, 0x05, 0x04, 0x00, ...SESSION);
		},
		readEeprom(address, length) {
			return Uint8Array.of(0x1b, 0x05, 0x08, 0x00,
				address & 0xff, (address >> 8) & 0xff, length & 0xff, 0x00, ...SESSION);
		},
		// Byte 7 is the flag serialtool calls "allow password" on V3 restores;
		// v1 tools have always sent 1 there as well.
		writeEeprom(address, data) {
			const out = new Uint8Array(12 + data.length);
			out.set([0x1d, 0x05, data.length + 8, 0x00,
			         address & 0xff, (address >> 8) & 0xff, data.length & 0xff, 0x01,
			         ...SESSION], 0);
			out.set(data, 12);
			return out;
		},
		reset() {
			return Uint8Array.of(0xdd, 0x05, 0x00, 0x00);
		},

		// ---- bootloader mode, v1 ----

		// The version string is presented to the bootloader before flashing.
		// Anything starting with '*' is accepted by every known 2.x bootloader,
		// which is what our own images carry.
		version(versionBytes) {
			const v = new Uint8Array(16);
			v.set(versionBytes.subarray(0, 16));
			return Uint8Array.of(0x30, 0x05, 0x10, 0x00, ...v);
		},

		// One 0x100-byte block of flash. `totalSize` is the whole image length;
		// the bootloader is told the final block address so it knows when the
		// image ends.
		//
		//   0x19 05 0c 01 | 8a 8d 9f 1d | addr_hi addr_lo final_hi 00
		//   | len_hi len_lo 00 00 | 0x100 bytes
		flashBlock(address, data, totalSize) {
			if (data.length > 0x100) throw new Error('flash block too long');
			const finalAddr = (totalSize + 0xff) & ~0xff;
			if (finalAddr > FAMILIES.v1.flashSize) throw new Error('firmware image too large for the flash area');

			const out = new Uint8Array(16 + 0x100);
			out.set([0x19, 0x05, 0x0c, 0x01,
			         0x8a, 0x8d, 0x9f, 0x1d,
			         (address >> 8) & 0xff, address & 0xff, (finalAddr >> 8) & 0xff, 0x00,
			         0x01, 0x00, 0x00, 0x00], 0);
			out.set(data, 16);       // the tail is left as zeroes for a short last block
			return out;
		},

		// ---- bootloader mode, v3 (after serialtool/_prog.py) ----

		// 0x0530 carrying the first four characters of the bootloader's own
		// version - "7.00" for a 7.00.07 bootloader, the only token it accepts.
		handshakeV3(blVersion) {
			const tag = new TextEncoder().encode(String(blVersion || '').slice(0, 4));
			const out = new Uint8Array(8);
			out.set([0x30, 0x05, 0x04, 0x00], 0);
			out.set(tag.subarray(0, 4), 4);
			return out;
		},

		// One 256-byte page:
		//   0x19 05 0c 01 | token (u32 LE) | page index (u16 LE) | page count (u16 LE)
		//   | 00 00 00 00 | 0x100 bytes, zero-padded
		flashPageV3(pageIndex, pageCount, data, token) {
			if (data.length > 0x100) throw new Error('flash page too long');
			if (pageCount * 0x100 > FAMILIES.v3.flashSize + 0xff)
				throw new Error('firmware image too large for the flash area');
			const out = new Uint8Array(16 + 0x100);
			out.set([0x19, 0x05, 0x0c, 0x01,
			         token & 0xff, (token >>> 8) & 0xff, (token >>> 16) & 0xff, (token >>> 24) & 0xff,
			         pageIndex & 0xff, (pageIndex >> 8) & 0xff,
			         pageCount & 0xff, (pageCount >> 8) & 0xff,
			         0x00, 0x00, 0x00, 0x00], 0);
			out.set(data, 16);
			return out;
		},
	};

	// A v3 0x051A reply: { token, page, err }.
	function parseFlashReplyV3(p) {
		return {
			token: (p[4] | (p[5] << 8) | (p[6] << 16) | (p[7] << 24)) >>> 0,
			page:  p[8] | (p[9] << 8),
			err:   p[10] | (p[11] << 8),
		};
	}

	// ---- firmware images ---------------------------------------------------

	// A ".packed.bin" is the form the official updaters accept: the raw image
	// with a 16-byte version string inserted at 0x2000, the whole thing XORed
	// with a 128-byte key, and a CRC-16 appended little-endian. Both families'
	// stock updaters use it. The bootloader itself wants the raw bytes, plus,
	// on v1, the version sent separately.

	const FW_XOR_KEY = Uint8Array.of(
		0x47, 0x22, 0xc0, 0x52, 0x5d, 0x57, 0x48, 0x94, 0xb1, 0x60, 0x60, 0xdb, 0x6f, 0xe3, 0x4c, 0x7c,
		0xd8, 0x4a, 0xd6, 0x8b, 0x30, 0xec, 0x25, 0xe0, 0x4c, 0xd9, 0x00, 0x7f, 0xbf, 0xe3, 0x54, 0x05,
		0xe9, 0x3a, 0x97, 0x6b, 0xb0, 0x6e, 0x0c, 0xfb, 0xb1, 0x1a, 0xe2, 0xc9, 0xc1, 0x56, 0x47, 0xe9,
		0xba, 0xf1, 0x42, 0xb6, 0x67, 0x5f, 0x0f, 0x96, 0xf7, 0xc9, 0x3c, 0x84, 0x1b, 0x26, 0xe1, 0x4e,
		0x3b, 0x6f, 0x66, 0xe6, 0xa0, 0x6a, 0xb0, 0xbf, 0xc6, 0xa5, 0x70, 0x3a, 0xba, 0x18, 0x9e, 0x27,
		0x1a, 0x53, 0x5b, 0x71, 0xb1, 0x94, 0x1e, 0x18, 0xf2, 0xd6, 0x81, 0x02, 0x22, 0xfd, 0x5a, 0x28,
		0x91, 0xdb, 0xba, 0x5d, 0x64, 0xc6, 0xfe, 0x86, 0x83, 0x9c, 0x50, 0x1c, 0x73, 0x03, 0x11, 0xd6,
		0xaf, 0x30, 0xf4, 0x2c, 0x77, 0xb2, 0x7d, 0xbb, 0x3f, 0x29, 0x28, 0x57, 0x22, 0xd6, 0x92, 0x8b);

	const VERSION_OFFSET = 0x2000;
	const VERSION_LENGTH = 16;

	function fwXor(bytes) {
		const out = Uint8Array.from(bytes);
		for (let i = 0; i < out.length; i++)
			out[i] ^= FW_XOR_KEY[i % FW_XOR_KEY.length];
		return out;
	}

	// Accepts either form and returns { raw, version, packed, crcOk, family }.
	// `raw` is what goes to the bootloader, `version` the 16 bytes a v1
	// bootloader is shown, `family` which radio the code was linked for.
	function readImage(bytes) {
		const looksPacked = bytes.length > VERSION_OFFSET + VERSION_LENGTH + 2 &&
		                    isPacked(bytes);
		if (!looksPacked) {
			// A raw build: no version inside, so present the wildcard version
			// that every v1 bootloader accepts.
			const version = new Uint8Array(VERSION_LENGTH);
			version.set(new TextEncoder().encode('*'));
			const raw = Uint8Array.from(bytes);
			return { raw, version, packed: false, crcOk: null, family: imageFamily(raw) };
		}

		const payload = bytes.subarray(0, bytes.length - 2);
		const want    = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);
		const crcOk   = crc16(payload) === want;

		const plain   = fwXor(payload);
		const version = plain.slice(VERSION_OFFSET, VERSION_OFFSET + VERSION_LENGTH);
		const raw     = new Uint8Array(plain.length - VERSION_LENGTH);
		raw.set(plain.subarray(0, VERSION_OFFSET), 0);
		raw.set(plain.subarray(VERSION_OFFSET + VERSION_LENGTH), VERSION_OFFSET);
		return { raw, version, packed: true, crcOk, family: imageFamily(raw) };
	}

	// A packed image decodes to a plausible Cortex-M0 vector table for one of
	// the two chips. A raw image never does, because XOR scrambles it.
	function isPacked(bytes) {
		return imageFamily(fwXor(bytes.subarray(0, 8))) !== null;
	}

	function versionString(versionBytes) {
		let s = '';
		for (const b of versionBytes) {
			if (b === 0) break;
			s += String.fromCharCode(b);
		}
		return s;
	}

	// A sanity check with a plain-English reason, so the tool can refuse an
	// image before it touches the radio rather than half way through. With
	// `family`, also refuse an image built for the other chip.
	function checkImage(image, family = null) {
		if (image.packed && image.crcOk === false)
			return 'This file failed its checksum, so it is damaged or is not a Quansheng firmware image.';
		if (image.raw.length < 0x2000)
			return `This file is only ${image.raw.length} bytes - far too small to be radio firmware.`;
		if (!image.family)
			return 'This file does not start like firmware for either kind of radio (bad interrupt vector table).';
		const f = FAMILIES[image.family];
		if (image.raw.length > f.flashSize)
			return `This image is ${image.raw.length} bytes, larger than the ${f.flashSize} bytes of program flash in a ${f.name}.`;
		if (family && family !== image.family) {
			const want = FAMILIES[family];
			return `This file is firmware for the ${f.name} (${f.chip} chip), but you picked a ${want.name} ` +
			       `(${want.chip}). They are different chips and cannot run each other's firmware.`;
		}
		return null;
	}

	return {
		XOR_KEY, SESSION, FAMILIES, VERSION_OFFSET, VERSION_LENGTH,
		FLASH_LIMIT: FAMILIES.v1.flashSize,      // kept for callers written against v1 only
		crc16, frame, deframe, cmd, parseFlashReplyV3,
		readImage, checkImage, versionString, fwXor, isPacked,
		imageFamily, bootloaderFamily,
	};
})();

// `const` at the top level of a classic script does not become a window
// property, so publish it explicitly for other scripts, tests and the console.
if (typeof window !== 'undefined') window.K5 = K5;
if (typeof module !== 'undefined' && module.exports) module.exports = K5;
