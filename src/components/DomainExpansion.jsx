import React, { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import '../styles/domain-expansion.css';
import domainExpansionSfx from '../assets/domain_expansion.mp3';
import domainNameSfx      from '../assets/domain_name.mp3';
import domainThemeSfx     from '../assets/domain_theme.mp3';
import domainCutSfx       from '../assets/domain_cut.mp3';
import shrineImg          from '../assets/domain_shrine.png';
import handsImg           from '../assets/domain_hands.png';
import { getSharedAudioCtx, getSfxOutput, withRunningCtx, unlockAudioPlayback } from '../lib/sfx';

// DomainExpansion

const CONTENT = { eyebrow: 'DOMAIN EXPANSION', name: '伏魔御廚子' };

const T = {
  wave: 1700,        // water ripple on "DOMAIN EXPANSION"
  ring0: 2420,
  ringGap: 260,
  ringCount: 5,
  beat2: 3900,       // heartbeat speeds up
  beat3: 4700,
  draw: 5000,        // cut line is drawn
  impact: 5260,      // white impact frame
  open: 5350,
  barrage: 3600,     // barrage length (after open)
  finale: 3750,      // big X (after open)
  hits: 4050,
  hitGap: 230,
};
export const HIT_AT = T.open + T.hits;

const AUDIO_LAG = 0.12;
const AUDIO = [
  { key: 'expansion', at: 0,    volume: 0.9  },
  { key: 'name',      at: 1800, volume: 0.85 },
  { key: 'theme',     at: 4900, volume: 0.75 },
  { key: 'cut',       at: 5030, volume: 0.85 },   // big transition slash: its peak (~220ms in) lands on the impact frame
];
const CLIP_URLS = { expansion: domainExpansionSfx, name: domainNameSfx, theme: domainThemeSfx, cut: domainCutSfx };

let clipsPromise = null;
function loadClips() {
  if (clipsPromise) return clipsPromise;
  const ctx = getSharedAudioCtx();
  if (!ctx) return Promise.resolve(null);
  clipsPromise = Promise.all(Object.entries(CLIP_URLS).map(async ([key, url]) => {
    const data = await (await fetch(url)).arrayBuffer();
    const buffer = await new Promise((res, rej) => ctx.decodeAudioData(data, res, rej));
    return [key, buffer];
  })).then(Object.fromEntries).catch((err) => {
    console.warn('[DomainExpansion] audio preload failed', err);
    clipsPromise = null;
    return null;
  });
  return clipsPromise;
}
function mistPixels(seed, N, oct, tint, lo, gain) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const amps = [0.55, 0.3, 0.15];
  const grids = oct.map(([ox, oy]) => Array.from({ length: ox * oy }, rnd));
  const px = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0;
    for (let k = 0; k < oct.length; k++) {
      const [ox, oy] = oct[k], g = grids[k];
      const fx = (x / N) * ox, fy = (y / N) * oy, x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const X0 = x0 % ox, X1 = (x0 + 1) % ox, Y0 = (y0 % oy) * ox, Y1 = ((y0 + 1) % oy) * ox;
      const a = g[Y0 + X0], b = g[Y0 + X1], c = g[Y1 + X0], d = g[Y1 + X1];
      v += amps[k] * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
    }
    const i = (y * N + x) * 4;
    px[i] = tint[0]; px[i + 1] = tint[1]; px[i + 2] = tint[2];
    px[i + 3] = Math.max(0, Math.min(1, (v - lo) * gain)) * 255;
  }
  return px;
}
let mistDone = false;
function bakeMist() {
  if (mistDone || typeof document === 'undefined') return;
  try {
    const N = 128, root = document.documentElement.style;
    [['--de-m1', 5, [[3, 5], [6, 10], [12, 20]], [191, 10, 26], 0.42, 3.2],
     ['--de-m2', 17, [[4, 6], [8, 12], [16, 24]], [115, 8, 20], 0.45, 3.4]].forEach(([name, seed, oct, tint, lo, gain]) => {
      const cv = document.createElement('canvas'); cv.width = cv.height = N;
      const c = cv.getContext('2d'), img = c.createImageData(N, N);
      img.data.set(mistPixels(seed, N, oct, tint, lo, gain));
      c.putImageData(img, 0, 0);
      root.setProperty(name, `url(${cv.toDataURL('image/png')})`);
    });
    mistDone = true;
  } catch (_) { }
}

let shrinePromise = null;
function decodeShrine() {
  if (!shrinePromise) {
    const img = new Image();
    img.src = shrineImg;
    shrinePromise = (img.decode ? img.decode() : Promise.resolve()).catch(() => {});
  }
  return shrinePromise;
}

const cap = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
const frames = (n) => new Promise((res) => {
  const step = () => (--n <= 0 ? res() : requestAnimationFrame(step));
  requestAnimationFrame(step);
});
function prepare() {
  bakeMist();
  return cap(Promise.all([loadClips(), decodeShrine()]), 1500)
    .then(() => cap(frames(4), 600));
}

if (typeof window !== 'undefined') {
  setTimeout(() => { loadClips(); decodeShrine(); bakeMist(); }, 1500);
  const unlock = () => {
    unlockAudioPlayback();
    ['pointerup', 'touchend', 'keydown', 'click'].forEach((e) => window.removeEventListener(e, unlock));
  };
  ['pointerup', 'touchend', 'keydown', 'click'].forEach((e) => window.addEventListener(e, unlock, { passive: true }));
}

function makeSynth(ctx, nodes) {
  let nb;
  const out = getSfxOutput(ctx);
  const boom = (t, v, f, d) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(f * 2.4, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.12);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.connect(g).connect(out); o.start(t); o.stop(t + d); nodes.push(o);
  };
  const noise = (t, d, f0, f1, v, pan) => {
    if (!nb) {
      nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const a = nb.getChannelData(0);
      for (let i = 0; i < a.length; i++) a[i] = Math.random() * 2 - 1;
    }
    const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = nb; fl.type = 'bandpass'; fl.Q.value = 1.4;
    fl.frequency.setValueAtTime(f0, t); fl.frequency.exponentialRampToValueAtTime(f1, t + d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + d * 0.3);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    s.connect(fl).connect(g);
    if (pan != null && ctx.createStereoPanner) { const pn = ctx.createStereoPanner(); pn.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(pn).connect(out); }
    else g.connect(out);
    s.start(t); s.stop(t + d); nodes.push(s);
  };
  return { boom, noise };
}

const R = (a, b) => a + Math.random() * (b - a);
const STY = [
  { core: '#fff', out: '#e0102c' }, { core: '#0a0a0a', out: '#fff' }, { core: '#e0102c', out: '#0a0a0a' },
  { core: '#0a0a0a', out: '#e0102c' }, { core: '#fff', out: '#0a0a0a' }, { core: '#fff', out: '#e0102c' },
];
function Scene({ embers, caster }) {
  return (
    <>
      <div className="de-sky" /><div className="de-moon"><div className="de-hands"><img alt="" src={handsImg} /></div></div>
      <div className="de-smoke" /><div className="de-smoke de-b" /><div className="de-fog" />
      <div className="de-mist de-m1" /><div className="de-mist de-m2" />
      {embers.map((s, i) => <i key={i} className="de-em" style={s} />)}
      <div className="de-vig" />
      <div className="de-ttl">
        <div className="de-eb">{CONTENT.eyebrow}</div>
        <div className="de-ln" />
        <div className="de-nm">{[...CONTENT.name].map((ch, i) => <span key={i} style={{ '--i': i }}>{ch}</span>)}</div>
        {caster && <div className="de-cast">CAST BY&nbsp;&nbsp;<b>{String(caster).toUpperCase()}</b></div>}
      </div>
    </>
  );
}

export default function DomainExpansion({ onDone, deltas = [], casterName, casterTeamId }) {
  const [fading, setFading] = useState(false);
  const [hits, setHits] = useState([]);
  const [go, setGo] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const stRef = useRef(null), hARef = useRef(null), hBRef = useRef(null), cvRef = useRef(null);
  const fxRef = useRef(null), impRef = useRef(null), shrRef = useRef(null), dispRef = useRef(null), turbRef = useRef(null), rgbRRef = useRef(null), rgbCRef = useRef(null), bkRef = useRef(null);

  const embers = useMemo(() => Array.from({ length: 14 }, () => ({
    left: `${R(0, 100)}%`, width: `${R(2, 6)}px`, height: `${R(2, 6)}px`,
    '--d': `${R(4, 9)}s`, '--dl': `${R(0, 4)}s`, '--dx': `${R(-80, 80)}px`,
  })), []);
  const origin = useMemo(() => {
    const el = casterTeamId != null && document.querySelector(`[data-team-id="${casterTeamId}"]`);
    if (!el) return { '--ox': '50vw', '--oy': '50vh' };
    const r = el.getBoundingClientRect();
    return { '--ox': `${r.left + r.width / 2}px`, '--oy': `${r.top + r.height / 2}px` };
  }, [casterTeamId]);

  useEffect(() => {
    let cancelled = false, stop = null;
    const run = () => {
    const st = stRef.current, hA = hARef.current, hB = hBRef.current, cv = cvRef.current, cx = cv.getContext('2d');
    const t0 = performance.now();
    let alive = true, shk = 0, shDir = null, raf = 0, wid = 0, sl = [], pa = [], sc = [];
    const tm = [], nodes = [];
    const ctx = getSharedAudioCtx();
    const synth = ctx && makeSynth(ctx, nodes);
    const nHit = deltas.length || 3;
    const FADE_AT = HIT_AT + (nHit - 1) * T.hitGap + 1900 + 300;
    const at = (ms, fn) => tm.push(setTimeout(fn, ms));
    // colour split: red and cyan channels slide apart, then settle
    const rgbSplit = (px) => {
      const r = rgbRRef.current, c = rgbCRef.current; if (!r || !c) return;
      const w0 = performance.now(), D = 180; st.style.filter = 'url(#de-rgb)';
      const f = (n) => {
        if (!alive) return;
        const p = Math.min(1, (n - w0) / D), k = px * (1 - p) * (1 - p);
        r.setAttribute('dx', (-k).toFixed(1)); c.setAttribute('dx', k.toFixed(1));
        if (p < 1) requestAnimationFrame(f); else st.style.filter = '';
      };
      requestAnimationFrame(f);
    };
    // hit pause: freeze every running CSS animation for a beat
    const freeze = (ms) => {
      try {
        const an = st.parentNode.getAnimations({ subtree: true }).filter((a) => a.playState === 'running');
        an.forEach((a) => a.pause());
        setTimeout(() => an.forEach((a) => { try { a.play(); } catch (_) {} }), ms);
      } catch (_) {}
    };

    loadClips().then((clips) => {
      if (!alive || !clips || !ctx) return;
      withRunningCtx(ctx, () => {
        if (!alive) return;
        const el = (performance.now() - t0) / 1000;
        AUDIO.forEach(({ key, at: ms, volume }) => {
          const buffer = clips[key];
          if (!buffer) return;
          const delay = ms / 1000 - el + AUDIO_LAG;
          const src = ctx.createBufferSource(), gain = ctx.createGain();
          src.buffer = buffer; gain.gain.value = volume; src.connect(gain).connect(getSfxOutput(ctx));
          if (delay >= 0) src.start(ctx.currentTime + delay);
          else if (-delay < buffer.duration) src.start(ctx.currentTime, -delay);
          else return;
          nodes.push(src);
        });
        const when = (ms) => { const d = ms / 1000 - el + AUDIO_LAG; return d >= 0 ? ctx.currentTime + d : null; };
        const B = (ms, ...a) => { const t = when(ms); if (t != null) synth.boom(t, ...a); };
        const N = (ms, ...a) => { const t = when(ms); if (t != null) synth.noise(t, ...a); };
        for (let i = 0; i < T.ringCount; i++) N(T.ring0 + i * T.ringGap, 0.35, 900 + i * 250, 300, 0.12);
        B(T.impact, 1, 42, 1.2); N(T.impact, 0.5, 400, 120, 0.7);            // impact frame
        B(T.open + T.finale, 1, 36, 1.5); N(T.open + T.finale, 0.6, 5000, 300, 0.8); // finale X
      });
    });

    const fit = () => { const d = Math.min(2, devicePixelRatio || 1); cv.width = cv.clientWidth * d; cv.height = cv.clientHeight * d; cx.setTransform(d, 0, 0, d, 0, 0); };
    fit(); window.addEventListener('resize', fit);
    const slash = (deg, x, y, len, w, dur, style) => {
      const a = deg * Math.PI / 180, dx = Math.cos(a) * len / 2, dy = Math.sin(a) * len / 2;
      sl.push({ x1: x - dx, y1: y - dy, x2: x + dx, y2: y + dy, w, dur, t0: performance.now(), ...(style || STY[Math.floor(Math.random() * STY.length)]) });
    };
    const frame = (now) => {
      shk *= 0.88;
      const sx = (Math.random() - 0.5) * shk, sy = (Math.random() - 0.5) * shk, dm = (Math.random() - 0.5) * shk * 1.6;
      st.style.transform = shk > 0.4 ? (shDir == null ? `translate(${sx}px,${sy}px)` : `translate(${Math.cos(shDir) * dm + sx * 0.2}px,${Math.sin(shDir) * dm + sy * 0.2}px)`) + ` rotate(${(Math.random() - 0.5) * shk * 0.03}deg)` : '';
      cx.clearRect(0, 0, cv.clientWidth, cv.clientHeight); cx.lineCap = 'butt';
      sl = sl.filter((s) => { if (now - s.t0 < s.dur) return true; if (s.w < 8) sc.push({ ...s, born: now }); return false; });
      for (const s of sl) {
        const p = (now - s.t0) / s.dur, h = Math.min(1, p * 4), t = Math.max(0, (p - 0.2) / 0.8);
        if (h - t < 0.002) continue;
        if (h < 1 && now - (s.lp || 0) > 14) {   // sparks fly off the blade tip while it sweeps
          s.lp = now;
          const ux = s.x2 - s.x1, uy = s.y2 - s.y1, L = Math.hypot(ux, uy) || 1, hx = s.x1 + ux * h, hy = s.y1 + uy * h;
          for (let q = 0; q < 2; q++) {
            const al = R(60, 280), pe = R(-200, 200);
            pa.push({ x: hx, y: hy, vx: ux / L * al - uy / L * pe, vy: uy / L * al + ux / L * pe, t0: now, life: R(220, 420), c: Math.random() < 0.5 ? '#fff' : '#ff3a50' });
          }
          if (pa.length > 160) pa.splice(0, pa.length - 160);
        }
        const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
        const STEPS = 12, pts = [];
        for (let i = 0; i <= STEPS; i++) {
          const u = i / STEPS, k = t + (h - t) * u;
          // blade profile: razor tip at the head, thickest near the tail, pointed at both ends
          pts.push([s.x1 + dx * k, s.y1 + dy * k, Math.sin(Math.PI * Math.pow(u, 0.7))]);
        }
        const blade = (half, color) => {
          cx.beginPath();
          pts.forEach(([x, y, tp], i) => (i ? cx.lineTo : cx.moveTo).call(cx, x + nx * half * tp, y + ny * half * tp));
          for (let i = pts.length - 1; i >= 0; i--) cx.lineTo(pts[i][0] - nx * half * pts[i][2], pts[i][1] - ny * half * pts[i][2]);
          cx.closePath(); cx.fillStyle = color; cx.fill();
        };
        cx.globalAlpha = Math.min(1, (1 - t) * 1.4); cx.shadowBlur = 0; cx.lineJoin = 'miter';
        blade(s.w * 0.8 + 2.5, s.out);   // crisp outline
        blade(s.w * 0.8, s.core);        // sharp inner blade
      }
      sc = sc.filter((q) => now - q.born < 1500);   // faint slash scars that linger and fade
      cx.lineWidth = 1.2;
      for (const q of sc) {
        cx.globalAlpha = 0.24 * (1 - (now - q.born) / 1500);
        cx.strokeStyle = q.out === '#e0102c' || q.core === '#e0102c' ? '#ff4458' : '#fff';
        cx.beginPath(); cx.moveTo(q.x1, q.y1); cx.lineTo(q.x2, q.y2); cx.stroke();
      }
      pa = pa.filter((q) => now - q.t0 < q.life);
      for (const q of pa) {
        const a = (now - q.t0) / q.life, age = (now - q.t0) / 1000, px = q.x + q.vx * age, py = q.y + q.vy * age;
        cx.globalAlpha = 1 - a; cx.strokeStyle = q.c; cx.lineWidth = 1.8 * (1 - a) + 0.4;
        cx.beginPath(); cx.moveTo(px, py); cx.lineTo(px - q.vx * 0.04, py - q.vy * 0.04); cx.stroke();
      }
      cx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const ring = () => {
      const r = document.createElement('div'); r.className = 'de-ring'; fxRef.current.appendChild(r);
      setTimeout(() => r.remove(), 1500);
    };
    const wave = () => {
      const id = ++wid, els = st.querySelectorAll('.de-eb'), d = dispRef.current, tb = turbRef.current, w0 = performance.now(), D = 2400;
      els.forEach((e) => e.classList.add('de-wv'));
      const f = (n) => {
        if (!alive || id !== wid) return;
        const p = Math.min(1, (n - w0) / D);
        d.setAttribute('scale', (74 * Math.sin(Math.PI * p) * (1 - p)).toFixed(1));
        tb.setAttribute('baseFrequency', `${(0.008 + 0.012 * p).toFixed(4)} ${(0.02 + 0.01 * Math.sin(p * 12)).toFixed(4)}`);
        if (p < 1) requestAnimationFrame(f); else els.forEach((e) => e.classList.remove('de-wv'));
      };
      requestAnimationFrame(f);
    };

    const ovEl = st.parentNode;
    ovEl.dataset.lb = '1';
    at(T.wave, wave);
    for (let i = 0; i < T.ringCount; i++) at(T.ring0 + i * T.ringGap, () => { ring(); shk = Math.max(shk, 9 + i * 2); shDir = null; });
    at(T.beat2, () => st.style.setProperty('--bt', '.65s'));
    at(T.beat3, () => st.style.setProperty('--bt', '.38s'));
    at(T.draw, () => st.classList.add('de-draw'));
    at(T.impact, () => { impRef.current.style.opacity = 1; shk = 28; shDir = null; freeze(80); rgbSplit(14); setTimeout(() => { if (impRef.current) impRef.current.style.opacity = 0; }, 90); });
    at(T.open, () => {
      st.classList.remove('de-draw'); st.classList.add('de-open', 'de-clear'); ovEl.dataset.lb = '2';
      if (bkRef.current) bkRef.current.style.display = 'none';
      shrRef.current.className = 'de-shr de-up';
      const o = { duration: 950, easing: 'cubic-bezier(.6,0,.2,1)', fill: 'forwards' };
      hA.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(-4vw,-15vh)', opacity: 0 }], o);
      hB.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(4vw,15vh)', opacity: 0 }], o);
      let t = 0, gap = 300;
      while (t < T.barrage) {
        const ms = t;
        at(ms, () => {
          const W = cv.clientWidth, H = cv.clientHeight, n = 1 + (ms > 1500) + (Math.random() < 0.4);
          let dir = 0, px = 0.5, steepAny = false;
          for (let i = 0; i < n; i++) {
            const steep = Math.random() < 0.25, deg = steep ? (Math.random() < 0.5 ? 1 : -1) * R(60, 80) : R(-28, 28), x = W * R(0.15, 0.85);
            slash(deg, x, H * R(0.15, 0.85), W * R(1.25, 1.9), R(2, 5), 460);
            dir = deg; px = x / W; steepAny = steepAny || steep;
          }
          // whoosh follows the slash: steep = lower and heavier, flat = higher, panned by where it lands
          if (ctx && ctx.state === 'running') synth.noise(ctx.currentTime, 0.14, 3200, 900, 0.16 + Math.min(0.2, ms / 9000));
          shk = Math.max(shk, 8 + ms / 200); shDir = (dir + 90) * Math.PI / 180;
        });
        gap = Math.max(45, gap * 0.9); t += gap;
      }
      at(T.finale, () => {
        const W = cv.clientWidth, H = cv.clientHeight;
        slash(-24, W / 2, H / 2, W * 2.1, 14, 760, { core: '#0a0a0a', out: '#fff' });
        setTimeout(() => slash(24, W / 2, H / 2, W * 2.1, 14, 760, { core: '#e0102c', out: '#0a0a0a' }), 90);
        shk = 34; shDir = null; rgbSplit(20);
      });
      at(T.hits, () => {
        ovEl.dataset.lb = '0'; shrRef.current.className = 'de-shr de-out'; st.classList.remove('de-open');
        const ir = document.createElement('div'); ir.className = 'de-iris';   // closing ring contracts toward the caster
        st.parentNode.insertBefore(ir, st); setTimeout(() => ir.remove(), 1000);
        setHits(deltas.map((d, k) => {
          const el = document.querySelector(`[data-team-id="${d.teamId}"]`);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const ab = (v) => Math.abs(parseFloat(String(v).replace(/[^\d.-]/g, '')) || 0), mx = Math.max(1, ...deltas.map((q) => ab(q.delta)));
          return { id: d.teamId, delta: d.delta, k, x: r.left + r.width / 2, y: r.top, sc: 0.85 + 0.75 * ab(d.delta) / mx };
        }).filter(Boolean));
        for (let k = 0; k < nHit; k++) at(k * T.hitGap, () => { shk = Math.max(shk, 10); shDir = null; });
      });
    });
    at(FADE_AT, () => setFading(true));
    at(FADE_AT + 250, () => onDoneRef.current?.());

    return () => {
      alive = false;
      tm.forEach(clearTimeout);
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
      nodes.forEach((n) => { try { n.stop(); } catch (_) {} });
    };
    }; // end run
    prepare().then(() => {
      if (cancelled) return;
      flushSync(() => setGo(true));            // un-freeze the CSS animations...
      requestAnimationFrame(() => { if (!cancelled) stop = run(); });
    });
    return () => { cancelled = true; if (stop) stop(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`de-overlay${go ? ' de-go' : ''}${fading ? ' de-fade' : ''}`} style={origin}>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <filter id="de-water" x="-5%" y="-80%" width="110%" height="260%">
          <feTurbulence ref={turbRef} type="turbulence" baseFrequency="0.01 0.02" numOctaves="1" seed="3" result="n" />
          <feDisplacementMap ref={dispRef} in="SourceGraphic" in2="n" scale="0" />
        </filter>
        <filter id="de-rgb" x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r" />
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0" result="c" />
          <feOffset ref={rgbRRef} in="r" dx="0" dy="0" result="ro" />
          <feOffset ref={rgbCRef} in="c" dx="0" dy="0" result="co" />
          <feBlend in="ro" in2="co" mode="screen" />
        </filter>
      </svg>
      <div ref={bkRef} className="de-bk" />
      <div ref={stRef} className="de-stage">
        <div ref={shrRef} className="de-shr"><img alt="" src={shrineImg} /></div>
        <div ref={hARef} className="de-half de-hA"><Scene embers={embers} caster={casterName} /></div>
        <div ref={hBRef} className="de-half de-hB"><Scene embers={embers} caster={casterName} /></div>
        <svg className="de-cutsvg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line x1="-5" y1="72" x2="105" y2="28" pathLength="1" />
        </svg>
        <canvas ref={cvRef} className="de-cv" />
        <div ref={fxRef} className="de-fx" />
        <div ref={impRef} className="de-imp" />
      </div>
      {/* letterbox bars live outside the shaking stage, so they always cover the screen edges */}
      <div className="de-lb" aria-hidden="true"><i /><i /></div>
      {hits.map((d) => (
        <div key={d.id} className="de-dmg" style={{ left: d.x, top: d.y, '--dl': `${d.k * T.hitGap}ms`, '--sc': d.sc }}>{d.delta}</div>
      ))}
    </div>
  );
}