// Game-file pack: the public site carries only code; the player imports pvz2-assets.zip once
// (from the Files app). Its contents go into Cache Storage under the same URLs the game
// fetches, and the service worker serves them from there, fully offline.

export const PACK_CACHE = 'pvz2pack-v1';
const TYPES = { json: 'application/json', webp: 'image/webp', png: 'image/png', mp3: 'audio/mpeg' };

// True when the game data can be fetched (from the server in dev, or from an imported pack).
export async function packAvailable() {
  try {
    const r = await fetch('data/game.json', { method: 'HEAD' });
    if (r.ok) return true;
  } catch (e) { /* offline and not cached */ }
  try { return !!(await caches.match(new URL('data/game.json', location.href).href)); } catch (e) { return false; }
}

// Minimal ZIP reader (stored + deflate entries) using the browser's DecompressionStream.
async function* zipEntries(buf) {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Broken ZIP directory');
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = new Uint8Array(buf, start, csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error('Unsupported ZIP compression');
    yield { name, data };
  }
}

// Imports the pack; onProgress(done, total). Returns the pack's manifest.
export async function importPack(file, onProgress) {
  const buf = await file.arrayBuffer();
  const cache = await caches.open(PACK_CACHE);
  const v = new DataView(buf);
  let total = 0;
  for (let i = buf.byteLength - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x06054b50) { total = v.getUint16(i + 10, true); break; }
  let done = 0, manifest = null;
  for await (const { name, data } of zipEntries(buf)) {
    const ext = name.split('.').pop().toLowerCase();
    if (name === 'pack.json') manifest = JSON.parse(new TextDecoder().decode(data));
    await cache.put(new URL(name, location.href).href,
      new Response(data, { headers: { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': String(data.length) } }));
    onProgress && onProgress(++done, total);
  }
  if (!manifest) throw new Error('This ZIP is not the PvZ2 game-file pack');
  try { localStorage.setItem('pvz2web.pack', manifest.version); } catch (e) { /* ignore */ }
  return manifest;
}

// The "load game files" screen shown when the pack is missing.
// Game-file version this code was built with (precache.json "pack"); null if unknown.
export async function expectedPack() {
  try { return (await (await fetch('precache.json')).json()).pack || null; } catch (e) { return null; }
}

export function importedPack() {
  try { return localStorage.getItem('pvz2web.pack'); } catch (e) { return null; }
}

export function showImportScreen(app, update = false) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;' +
    'background:#2b1d0e;color:#f4e2a0;font:16px "Trebuchet MS",sans-serif;text-align:center;padding:20px;z-index:10';
  wrap.innerHTML = `
    <div style="font-size:26px;font-weight:bold;color:#ffd34d">PvZ2 Night Carnival</div>
    <div style="max-width:560px;line-height:1.4">${update
      ? 'Вышли новые файлы игры (новые уровни/растения). Скачай свежий <b>pvz2-assets.zip</b> и выбери его. Сохранения не пропадут.'
      : 'Файлов игры ещё нет на этом устройстве. Выбери <b>pvz2-assets.zip</b> (один раз скачай его из своего приватного репозитория в «Файлы»). После этого игра работает без интернета.'}</div>
    <label style="background:linear-gradient(#8bd34a,#3f8a18);color:#fff;font-weight:bold;font-size:20px;padding:14px 26px;border-radius:14px">
      ${update ? 'ОБНОВИТЬ ФАЙЛЫ' : 'ЗАГРУЗИТЬ ФАЙЛЫ ИГРЫ'}<input type="file" accept=".zip,application/zip" style="display:none"></label>
    ${update ? '<div class="later" style="text-decoration:underline;opacity:.8">Потом — играть со старыми файлами</div>' : ''}
    <div class="st" style="min-height:22px"></div>
    <div style="width:min(420px,80vw);height:12px;background:rgba(255,255,255,.15);border-radius:6px;overflow:hidden">
      <div class="bar" style="height:100%;width:0;background:#9ccf3a"></div></div>`;
  document.body.appendChild(wrap);
  const st = wrap.querySelector('.st'), bar = wrap.querySelector('.bar');
  wrap.querySelector('input').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    st.textContent = 'Распаковка…';
    try {
      const m = await importPack(f, (d, t) => { bar.style.width = (100 * d / t).toFixed(1) + '%'; st.textContent = `Распаковка… ${d} / ${t}`; });
      st.textContent = `Готово (${m.files} файлов). Запуск…`;
      setTimeout(() => location.reload(), 400);
    } catch (err) {
      st.textContent = 'Не получилось: ' + err.message;
    }
  });
  const later = wrap.querySelector('.later');
  if (later) later.addEventListener('click', () => { wrap.remove(); app.skipUpdate && app.skipUpdate(); });
}
