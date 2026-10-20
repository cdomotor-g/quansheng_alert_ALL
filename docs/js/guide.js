// The setup guide's few moving parts. Everything on the page reads fine
// without this: it adds the radio tabs, marks the section you're in, fills in
// photo credits, and puts sizes and checksums next to the downloads.
'use strict';

(() => {
	const $ = (sel, el = document) => el.querySelector(sel);
	const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
	const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

	// ---- tabs: UV-K1 / V3 versus the older UV-K5 ----------------------------
	const tabs = $$('[role="tab"]');
	function show(tab) {
		for (const t of tabs) {
			const on = t === tab;
			t.setAttribute('aria-selected', String(on));
			document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
		}
	}
	tabs.forEach(t => t.addEventListener('click', () => show(t)));
	// a link to #v1-... content should open the older radio's tab
	if (location.hash === '#use-v1') show(document.getElementById('tab-v1'));

	// ---- which section is on screen ----------------------------------------
	const links = new Map($$('nav.toc a').map(a => [a.getAttribute('href').slice(1), a]));
	if ('IntersectionObserver' in window) {
		const seen = new Set();
		const io = new IntersectionObserver(entries => {
			for (const e of entries) (e.isIntersecting ? seen.add : seen.delete).call(seen, e.target.id);
			const first = [...links.keys()].find(id => seen.has(id));
			for (const [id, a] of links) a.classList.toggle('here', id === first);
		}, { rootMargin: '-60px 0px -55% 0px' });
		for (const id of links.keys()) {
			const el = document.getElementById(id);
			if (el) io.observe(el);
		}
	}

	// ---- photo credits -----------------------------------------------------
	fetch('img/photos/credits.json', { cache: 'no-cache' })
		.then(r => (r.ok ? r.json() : []))
		.then(list => {
			const box = $('#photo-credits');
			for (const c of list) {
				const line = `${esc(c.shows)}: ${c.author ? esc(c.author) + ', ' : ''}` +
					`<a href="${esc(c.source)}" target="_blank" rel="noopener">source</a>, ` +
					(c.license_url ? `<a href="${esc(c.license_url)}" target="_blank" rel="noopener">${esc(c.license)}</a>`
					               : esc(c.license)) +
					(c.modified ? ` (${esc(c.modified)})` : '');
				if (box) box.insertAdjacentHTML('beforeend', `<li>${line}</li>`);
				for (const el of $$(`[data-credit="${CSS.escape(c.file)}"]`))
					el.innerHTML = `Photo: ${c.author ? esc(c.author) + ', ' : ''}${esc(c.license)}.`;
			}
		})
		.catch(() => { /* credits stay in credits.json and the README */ });

	// ---- downloads, from the same manifest the installer uses ----------------
	fetch('firmware/manifest.json', { cache: 'no-cache' })
		.then(r => (r.ok ? r.json() : null))
		.then(m => {
			if (!m || !m.builds) return;
			const radio = { v1: 'UV-K5 family', v3: 'UV-K1 / UV-K5 V3' };
			const rows = m.builds.map(b => {
				const file = b.file.split('/').pop();
				const raw = b.raw_file ? ` · <a href="${esc(b.raw_file)}" download>raw .bin</a>` : '';
				const src = b.source || {};
				const commit = src.commit
					? `<a href="https://github.com/${esc(src.repo)}/tree/${esc(src.commit)}" target="_blank" rel="noopener">${esc(src.repo.split('/')[1])}@${esc(src.commit)}</a>`
					: esc(src.repo || '');
				return `<tr><td>${radio[b.family] || esc(b.family)}</td>` +
					`<td>${esc(b.title)}<br><span class="muted">${b.stations ? b.stations + ' stations · ' : ''}built ${esc(b.built || '?')}</span></td>` +
					`<td><a href="${esc(b.file)}" download>${esc(file)}</a>${raw}<br>` +
					`<span class="muted">${(b.size / 1024).toFixed(1)} KB · SHA-256 <code title="${esc(b.sha256)}">${esc(b.sha256.slice(0, 16))}…</code></span></td>` +
					`<td>${commit}</td></tr>`;
			}).join('');
			$('#dl-table tbody').innerHTML = rows;
		})
		.catch(() => { /* the static table stays */ });
})();
