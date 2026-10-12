// Sound: the game's own Wwise events (exported by tools/build_audio.py) played with Web Audio.
// iOS only lets audio start inside a user gesture, so unlock() runs on the first tap.

export class Audio {
  constructor(base = 'assets/audio/') {
    this.base = base;
    this.events = {};
    this.buffers = new Map();     // media id -> AudioBuffer | Promise
    this.ctx = null;
    this.muted = false;
    this.last = new Map();        // event -> time last played (rate limit)
    this.music = null;
    try { this.muted = localStorage.getItem('pvz2web.muted') === '1'; } catch (e) { /* ignore */ }
  }

  async init() {
    try { this.events = await (await fetch(this.base + 'events.json')).json(); } catch (e) { this.events = {}; }
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(this.ctx.destination);
    // Warm up every clip in the background so the first plays are instant.
    const ids = [...new Set(Object.values(this.events).flat())];
    let i = 0;
    const next = () => { if (i < ids.length) this.load(ids[i++]).finally(next); };
    for (let k = 0; k < 4; k++) next();
    if (this.wantMusic) this.playMusic(this.wantMusic);
  }

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem('pvz2web.muted', this.muted ? '1' : '0'); } catch (e) { /* ignore */ }
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.8;
  }

  load(id) {
    let b = this.buffers.get(id);
    if (!b) {
      b = fetch(this.base + id + '.mp3').then(r => r.arrayBuffer())
        .then(data => new Promise((ok, fail) => this.ctx.decodeAudioData(data, ok, fail)))
        .then(buf => { this.buffers.set(id, buf); return buf; })
        .catch(() => { this.buffers.delete(id); return null; });
      this.buffers.set(id, b);
    }
    return b instanceof Promise ? b : Promise.resolve(b);
  }

  // Play a Wwise event by name; repeats of the same event are limited to one per `gap` seconds.
  play(name, { volume = 1, gap = 0.06 } = {}) {
    if (!this.ctx || this.muted || !name) return;
    const ev = name.toLowerCase();
    const ids = this.events[ev];
    if (!ids) return;
    const now = this.ctx.currentTime;
    if (now - (this.last.get(ev) ?? -1) < gap) return;
    this.last.set(ev, now);
    const id = ids[Math.floor(Math.random() * ids.length)];
    const buf = this.buffers.get(id);
    if (buf && !(buf instanceof Promise)) this.start(buf, volume);
    else this.load(id);
  }

  start(buf, volume, loop = false) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.master);
    src.start();
    return { src, g };
  }

  async playMusic(name, volume = 0.45) {
    this.wantMusic = name;
    if (!this.ctx) return;
    if (this.music && this.music.name === name) return;
    if (this.music) { try { this.music.src.stop(); } catch (e) { /* already stopped */ } this.music = null; }
    const id = (this.events[name] || [])[0];
    if (!id) return;
    const buf = await this.load(id);
    if (!buf || this.wantMusic !== name) return;
    this.music = { name, ...this.start(buf, volume, true) };
  }

  stopMusic() {
    this.wantMusic = null;
    if (this.music) { try { this.music.src.stop(); } catch (e) { /* already stopped */ } this.music = null; }
  }
}
