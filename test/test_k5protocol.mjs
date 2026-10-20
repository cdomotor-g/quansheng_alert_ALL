// Tests for the installer's protocol layer (docs/js/k5protocol.js).
//   node test/test_k5protocol.mjs
//
// The packet vectors are the byte sequences the established tools put on the
// wire (k5prog's uvk5_hello, the uvmod/uvtools framing for the UV-K5, and
// muzkr's serialtool for the V3 / UV-K1 - its vectors below were produced by
// running quansheng_alert_v3/tools/serialtool/msg.py), so a mistake in framing,
// obfuscation, CRC or page layout shows up here rather than on someone's radio.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// k5protocol.js is a plain script that defines `const K5`; evaluate it and take
// the binding out of the module scope it creates.
const source = readFileSync(join(root, 'docs/js/k5protocol.js'), 'utf8');
const K5 = new Function(`${source}; return K5;`)();

let failures = 0;
const pending = [];
function test(name, fn) {
	const done = (err) => {
		if (err) { failures++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
		else console.log(`  ok    ${name}`);
	};
	try {
		const r = fn();
		if (r && typeof r.then === 'function') pending.push(r.then(() => done(), done));
		else done();
	} catch (err) { done(err); }
}

const hex = (b) => Array.from(b, x => x.toString(16).padStart(2, '0')).join(' ');

console.log('k5protocol');

test('CRC-16/XMODEM matches the reference vector', () => {
	// The canonical check value for CRC-16/XMODEM over "123456789" is 0x31C3.
	assert.equal(K5.crc16(new TextEncoder().encode('123456789')), 0x31c3);
});

test('the hello packet is byte-for-byte what k5prog sends', () => {
	// k5prog: uvk5_hello = 14 05 04 00 6a 39 57 64, framed and obfuscated.
	const framed = K5.frame(K5.cmd.hello());
	assert.equal(framed[0], 0xab);
	assert.equal(framed[1], 0xcd);
	assert.equal(framed[2], 8);          // payload length, little endian
	assert.equal(framed[3], 0);
	assert.equal(framed[framed.length - 2], 0xdc);
	assert.equal(framed[framed.length - 1], 0xba);
	assert.equal(framed.length, 8 + 8);  // 4 header + payload + 2 crc + 2 footer

	// De-obfuscating the body must give the payload back plus its CRC.
	const body = framed.slice(4, framed.length - 2).map((b, i) => b ^ K5.XOR_KEY[i % K5.XOR_KEY.length]);
	assert.equal(hex(body.slice(0, 8)), '14 05 04 00 6a 39 57 64');
	const crc = body[8] | (body[9] << 8);
	assert.equal(crc, K5.crc16(body.slice(0, 8)));
});

test('framing and deframing round-trip, including junk and split packets', () => {
	const payloads = [K5.cmd.hello(), K5.cmd.readEeprom(0x1e00, 0x80), K5.cmd.reset()];
	const stream = [];
	stream.push(0x00, 0xff, 0xab);                      // leading noise, incl. a false start
	for (const p of payloads) stream.push(...K5.frame(p));
	stream.push(0xab, 0xcd, 0x99);                      // a truncated packet at the end

	const { packets, rest } = K5.deframe(Uint8Array.from(stream));
	assert.equal(packets.length, 3);
	packets.forEach((pkt, i) => {
		assert.ok(pkt.crcOk, `packet ${i} CRC`);
		assert.equal(hex(pkt.payload), hex(payloads[i]));
	});
	assert.ok(rest.length > 0, 'the partial packet is kept for next time');
});

test('a corrupted packet is reported, not silently accepted', () => {
	const framed = K5.frame(K5.cmd.hello());
	framed[6] ^= 0x01;                                  // flip a bit inside the payload
	const { packets } = K5.deframe(framed);
	assert.equal(packets.length, 1);
	assert.equal(packets[0].crcOk, false);
});

test('EEPROM read and write commands carry address, length and session token', () => {
	const read = K5.cmd.readEeprom(0x1234, 0x80);
	assert.equal(hex(read.slice(0, 8)), '1b 05 08 00 34 12 80 00');
	assert.equal(hex(read.slice(8, 12)), hex(K5.SESSION));

	const data  = Uint8Array.from({ length: 0x10 }, (_, i) => i);
	const write = K5.cmd.writeEeprom(0x0f50, data);
	assert.equal(hex(write.slice(0, 8)), '1d 05 18 00 50 0f 10 01');
	assert.equal(hex(write.slice(8, 12)), hex(K5.SESSION));
	assert.equal(hex(write.slice(12)), hex(data));
});

test('a flash block is 0x110 bytes with the address big-endian', () => {
	const block = new Uint8Array(0x100).fill(0xa5);
	const cmd   = K5.cmd.flashBlock(0x1200, block, 0xee01);
	assert.equal(cmd.length, 16 + 0x100);
	assert.equal(hex(cmd.slice(0, 8)), '19 05 0c 01 8a 8d 9f 1d');
	assert.equal(cmd[8], 0x12);                          // address MSB
	assert.equal(cmd[9], 0x00);                          // address LSB
	assert.equal(cmd[10], 0xef);                         // final block address, rounded up
	assert.equal(cmd[11], 0x00);
	assert.equal(hex(cmd.slice(16)), hex(block));
});

test('a short final block is padded with zeroes', () => {
	const tail = Uint8Array.from([1, 2, 3]);
	const cmd  = K5.cmd.flashBlock(0x0100, tail, 0x103);
	assert.equal(cmd.length, 16 + 0x100);
	assert.equal(hex(cmd.slice(16, 19)), '01 02 03');
	assert.ok(cmd.slice(19).every(b => b === 0));
});

test('an oversized image is refused before anything is sent', () => {
	assert.throws(() => K5.cmd.flashBlock(0, new Uint8Array(0x100), 0xf001), /too large/);
});


// ---- the V3 / UV-K1 bootloader (serialtool's layout) ------------------------

test('the V3 handshake is byte-for-byte what serialtool sends', () => {
	// msg.py: Msg.make(0x0530, 4) with "7.00", then make_packet()
	assert.equal(hex(K5.frame(K5.cmd.handshakeV3('7.00.07'))),
	             hex(Uint8Array.from(Buffer.from('abcd0800266910e619bf3d703edfdcba', 'hex'))));
});

test('the hello packet matches serialtool too (same command, other token)', () => {
	// serialtool puts a timestamp where k5prog puts 6a 39 57 64; with k5prog's
	// token the two must agree exactly.
	assert.equal(hex(K5.frame(K5.cmd.hello())),
	             hex(Uint8Array.from(Buffer.from('abcd0800026910e644a85a24b9a9dcba', 'hex'))));
});

test('a V3 flash page is byte-for-byte what serialtool sends', async () => {
	const data = Uint8Array.from({ length: 0x100 }, (_, i) => (i * 13 + 5) & 0xff);
	const framed = K5.frame(K5.cmd.flashPageV3(3, 444, data, 0x12345678));
	assert.equal(framed.length, 280);
	assert.equal(hex(framed.slice(0, 24)),
	             hex(Uint8Array.from(Buffer.from('abcd10010f6918e756c73952223569411303e980137e0bca', 'hex'))));
	const { createHash } = await import('node:crypto');
	assert.equal(createHash('sha256').update(framed).digest('hex'),
	             '2c2f6f8743627e4bd50376a3289b900e5869bc7ac97a8d453afedda1d9cb0b0b');
});

test('a V3 page header carries token, index and count little-endian', () => {
	const cmd = K5.cmd.flashPageV3(0x0102, 0x01d8, Uint8Array.of(9, 8, 7), 0xa1b2c3d4);
	assert.equal(hex(cmd.slice(0, 16)), '19 05 0c 01 d4 c3 b2 a1 02 01 d8 01 00 00 00 00');
	assert.equal(hex(cmd.slice(16, 19)), '09 08 07');
	assert.ok(cmd.slice(19).every(b => b === 0), 'short page zero-padded');
});

test('a V3 0x051A reply is read as token, page and error', () => {
	const r = K5.parseFlashReplyV3(Uint8Array.of(0x1a, 0x05, 0x08, 0x00, 0x78, 0x56, 0x34, 0x12, 0x2a, 0x01, 0x01, 0x00));
	assert.deepEqual(r, { token: 0x12345678, page: 0x012a, err: 1 });
});

test('bootloader versions map to the right chip', () => {
	assert.equal(K5.bootloaderFamily('2.00.06'), 'v1');
	assert.equal(K5.bootloaderFamily('7.00.07'), 'v3');
	assert.equal(K5.bootloaderFamily('5.00.01'), null);
	assert.equal(K5.bootloaderFamily(''), null);
});

test('an image is classified by where its reset vector points', () => {
	const vt = (sp, reset) => {
		const b = new Uint8Array(0x3000);
		new DataView(b.buffer).setUint32(0, sp, true);
		new DataView(b.buffer).setUint32(4, reset, true);
		return b;
	};
	assert.equal(K5.imageFamily(vt(0x20003ff0, 0x000000d5)), 'v1');
	assert.equal(K5.imageFamily(vt(0x20003fe0, 0x08003219)), 'v3');
	assert.equal(K5.imageFamily(vt(0x20003fe0, 0x08003218)), null, 'Thumb bit missing');
	assert.equal(K5.imageFamily(vt(0x30000000, 0x08003219)), null, 'stack outside SRAM');
	assert.equal(K5.imageFamily(vt(0x20003fe0, 0x08000101)), null, 'inside the V3 bootloader');
	const why = K5.checkImage(K5.readImage(vt(0x20003fe0, 0x08003219)), 'v1');
	assert.ok(/different chips/.test(why || ''), `cross-family image must be refused: ${why}`);
});

// ---- real firmware images --------------------------------------------------

const packedPath = join(root, 'docs/firmware/v1/quansheng-alert-default.packed.bin');
const rawPath    = join(root, 'docs/firmware/v1/quansheng-alert-default.bin');
const v3Path     = join(root, 'docs/firmware/v3/quansheng-alert-v3.bin');

if (existsSync(packedPath) && existsSync(rawPath)) {
	const packed = new Uint8Array(readFileSync(packedPath));
	const raw    = new Uint8Array(readFileSync(rawPath));

	test('the published packed image unpacks to exactly the raw build', () => {
		const image = K5.readImage(packed);
		assert.equal(image.packed, true, 'recognised as a packed image');
		assert.equal(image.crcOk, true, 'checksum');
		assert.equal(image.raw.length, raw.length, 'unpacked length');
		assert.equal(hex(image.raw.slice(0, 64)), hex(raw.slice(0, 64)));
		assert.ok(image.raw.every((b, i) => b === raw[i]), 'every byte matches the raw build');
	});

	test('the version string in the published image starts with the wildcard', () => {
		const image = K5.readImage(packed);
		const v = K5.versionString(image.version);
		assert.ok(v.startsWith('*'), `version "${v}" must start with * so every bootloader accepts it`);
	});

	test('a raw build is accepted too, and gets the wildcard version', () => {
		const image = K5.readImage(raw);
		assert.equal(image.packed, false);
		assert.equal(K5.versionString(image.version), '*');
		assert.equal(K5.checkImage(image), null);
	});

	test('both published images pass the safety check', () => {
		assert.equal(K5.checkImage(K5.readImage(packed)), null);
		assert.equal(K5.checkImage(K5.readImage(raw)), null);
		assert.equal(K5.checkImage(K5.readImage(packed), 'v1'), null);
	});

	test('the UV-K5 build is recognised as DP32G030 code and refused for a V3', () => {
		assert.equal(K5.readImage(packed).family, 'v1');
		assert.ok(/different chips/.test(K5.checkImage(K5.readImage(packed), 'v3') || ''));
	});

	test('a damaged image is rejected with a readable reason', () => {
		const broken = Uint8Array.from(packed);
		broken[broken.length - 1] ^= 0xff;              // wreck the checksum
		const why = K5.checkImage(K5.readImage(broken));
		assert.ok(why && /checksum/i.test(why), `expected a checksum complaint, got: ${why}`);

		assert.ok(/too small/.test(K5.checkImage(K5.readImage(new Uint8Array(100)))));
	});
} else {
	console.log('  skip  published v1 firmware checks (docs/firmware/v1 not present)');
}

if (existsSync(v3Path)) {
	const v3 = new Uint8Array(readFileSync(v3Path));

	test('the published V3 build is recognised as PY32F071 code', () => {
		const image = K5.readImage(v3);
		assert.equal(image.packed, false, 'a raw image');
		assert.equal(image.family, 'v3');
		assert.equal(K5.checkImage(image, 'v3'), null);
		assert.ok(image.raw.length <= K5.FAMILIES.v3.flashSize, 'fits in 118 KB');
	});

	test('the V3 build is refused for a UV-K5', () => {
		assert.ok(/different chips/.test(K5.checkImage(K5.readImage(v3), 'v1') || ''));
	});

	test('the V3 build carries the ALERT app', () => {
		const text = Buffer.from(v3).toString('latin1');
		for (const s of ['ALERT SETTINGS', 'SQ GATE'])
			assert.ok(text.includes(s), `"${s}" missing - built with ENABLE_ALERT off?`);
	});

	test('a packed V3 image unpacks to the same raw bytes', () => {
		// Pack it the way the stock updater would, then read it back.
		const version = new TextEncoder().encode('7.03.01'.padEnd(16, '\0'));
		const plain = new Uint8Array(v3.length + 16);
		plain.set(v3.subarray(0, K5.VERSION_OFFSET), 0);
		plain.set(version, K5.VERSION_OFFSET);
		plain.set(v3.subarray(K5.VERSION_OFFSET), K5.VERSION_OFFSET + 16);
		const body = K5.fwXor(plain);
		const crc = K5.crc16(body);
		const packed = new Uint8Array(body.length + 2);
		packed.set(body, 0);
		packed[body.length] = crc & 0xff;
		packed[body.length + 1] = crc >> 8;
		const image = K5.readImage(packed);
		assert.equal(image.packed, true);
		assert.equal(image.family, 'v3');
		assert.equal(K5.versionString(image.version), '7.03.01');
		assert.ok(image.raw.every((b, i) => b === v3[i]));
	});
} else {
	console.log('  skip  published v3 firmware checks (docs/firmware/v3 not present)');
}

await Promise.all(pending);
console.log(failures ? `\nFAILED: ${failures}` : '\nPASSED');
process.exit(failures ? 1 : 0);
