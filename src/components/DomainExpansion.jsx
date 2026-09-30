import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../styles/domain-expansion.css';
import domainExpansionSfx from '../assets/domain_expansion.mp3';
import domainNameSfx      from '../assets/domain_name.mp3';
import domainThemeSfx     from '../assets/domain_theme.mp3';
import shrineImg          from '../assets/domain_shrine.png';

/* DomainExpansion — v2
   circle-open from the caster's card → title (blood moon + ritual ring + layered smoke, letterbox)
   → ripple rings + white flash at the cut → slash barrage + rising shrine → scarred team cards
   + damage numbers → fade out.
   Tweak pacing in TIMING; text in CONTENT. */

const CONTENT = { eyebrow: 'DOMAIN EXPANSION', name: '伏魔御廚子' };

const TIMING = {
  barsInMs: 150,
  riseMs: 4600,        // must match --de-rise in the CSS
  holdMs: 3000,        // hold after eyebrow rise, before the cut
  flashMs: 140,        // white flash at the cut
  slashMs: 6200,
  slashCount: 170,
  freezeMs: 0,         // impact freeze frame (0 = off)
  transitionMs: 900,   // title fades out OVER the first slashes
  barsOutTailMs: 2600, // exit + time to show scars and damage numbers
  fadeMs: 250,         // final fade-out before onDone
  ringCount: 5,        // ripple rings fired as the kanji land
};

const TITLE_START    = TIMING.barsInMs;
const FLASH_START    = TITLE_START + TIMING.riseMs + TIMING.holdMs;
const SLASH_START    = FLASH_START + TIMING.flashMs;
const BARS_OUT_START = SLASH_START + TIMING.slashMs;
const FADE_AT        = BARS_OUT_START + TIMING.barsOutTailMs;
const DONE_AT        = FADE_AT + TIMING.fadeMs;

const rand = (a, b) => a + Math.random() * (b - a);
const PALETTE = ['#ffffff', '#ffffff', '#ffffff', '#111111', '#cc0000', '#ff3300', '#dddddd'];
function outline(c) {
  if (c === '#111111') return Math.random() < 0.5 ? '#ffffff' : '#cc0000';
  if (c === '#cc0000' || c === '#ff3300') return Math.random() < 0.5 ? '#ffffff' : '#111111';
  return Math.random() < 0.5 ? '#111111' : '#cc0000';
}
function buildSlashes() {
  return Array.from({ length: TIMING.slashCount }, (_, i) => {
    const c = PALETTE[Math.floor(rand(0, PALETTE.length))];
    const big = i % 20 === 0;
    return {
      '--t': `${rand(0, 100)}%`, '--a': `${rand(-35, 35)}deg`, '--c': c, '--oc': outline(c),
      '--ow': `${rand(1, 4).toFixed(1)}px`, '--h': `${big ? rand(12, 22) : rand(2, 8)}px`,
      '--bl': `${rand(0, 6).toFixed(1)}px`, '--d': `${big ? rand(220, 380) : rand(80, 220)}ms`,
      '--dl': `${i < 40 ? rand(150, 900) : rand(0, TIMING.slashMs - 200)}ms`, // first 40 ease in during the transition
    };
  });
}

export default function DomainExpansion({ onDone, deltas = [], casterName, casterTeamId }) {
  const [phase, setPhase] = useState('bars-in');
  const [frozen, setFrozen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [fading, setFading] = useState(false);
  const [rings, setRings] = useState([]);
  const [dmg, setDmg] = useState([]);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const slashes = useMemo(buildSlashes, []);
  const embers = useMemo(() => Array.from({ length: 8 }, () => ({
    '--x': `${rand(0, 100)}%`, '--s': `${rand(2, 6).toFixed(1)}px`, '--d': `${rand(4, 9).toFixed(1)}s`,
    '--dl': `${rand(0, 5).toFixed(1)}s`, '--dx': `${rand(-80, 80).toFixed(0)}px`,
  })), []);
  // the circle opens from the caster's team card (falls back to screen centre)
  const origin = useMemo(() => {
    const el = casterTeamId != null && document.querySelector(`[data-team-id="${casterTeamId}"]`);
    if (!el) return { '--ox': '50vw', '--oy': '50vh' };
    const r = el.getBoundingClientRect();
    return { '--ox': `${r.left + r.width / 2}px`, '--oy': `${r.top + r.height / 2}px` };
  }, [casterTeamId]);
  const titleRef = useRef(null);
  const dispRef = useRef(null);
  const turbRef = useRef(null);
  const rafRef = useRef(0);

  const sfxExpansion = useRef(new Audio(domainExpansionSfx));
  const sfxName      = useRef(new Audio(domainNameSfx));
  const sfxTheme     = useRef(new Audio(domainThemeSfx));

  useEffect(() => {
    sfxExpansion.current.volume = 0.9;
    sfxName.current.volume      = 0.85;
    sfxTheme.current.volume     = 0.75;

    sfxExpansion.current.play().catch(() => {});
    const onExpansionEnded = () => sfxName.current.play().catch(() => {});
    sfxExpansion.current.addEventListener('ended', onExpansionEnded, { once: true });

    // water ripple that distorts the title while "DOMAIN EXPANSION" shrinks
    const waterWave = () => {
      const tw = titleRef.current, disp = dispRef.current, turb = turbRef.current;
      if (!tw || !disp || !turb) return;
      tw.classList.add('de-wave');
      const t0 = performance.now(), D = 2400;
      const f = (now) => {
        const p = Math.min(1, (now - t0) / D);
        disp.setAttribute('scale', (74 * Math.sin(Math.PI * p) * (1 - p)).toFixed(1));
        turb.setAttribute('baseFrequency', `${(0.008 + 0.012 * p).toFixed(4)} ${(0.02 + 0.01 * Math.sin(p * 12)).toFixed(4)}`);
        if (p < 1) rafRef.current = requestAnimationFrame(f); else tw.classList.remove('de-wave');
      };
      rafRef.current = requestAnimationFrame(f);
    };

    const at = (ms, fn) => setTimeout(fn, ms);
    const timers = [
      at(TITLE_START,    () => setPhase('title')),
      at(TITLE_START + 2300, waterWave),
      ...Array.from({ length: TIMING.ringCount }, (_, i) =>
        at(TITLE_START + TIMING.riseMs + i * 220 + 150, () => setRings((r) => [...r, i]))),
      at(FLASH_START,    () => setPhase('flash')),
      at(SLASH_START,    () => { setPhase('slash'); setLeaving(true); if (TIMING.freezeMs > 0) { setFrozen(true); setTimeout(() => setFrozen(false), TIMING.freezeMs); } sfxTheme.current.play().catch(() => {}); document.body.classList.add('de-shaking'); }),
      at(SLASH_START + TIMING.transitionMs, () => setLeaving(false)),
      at(BARS_OUT_START, () => { setPhase('bars-out'); document.body.classList.remove('de-shaking'); }),
      at(FADE_AT,        () => setFading(true)),
      at(DONE_AT,        () => onDoneRef.current?.()),
    ];

    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(rafRef.current);
      document.body.classList.remove('de-shaking');
      sfxExpansion.current.removeEventListener('ended', onExpansionEnded);
      [sfxExpansion, sfxName, sfxTheme].forEach((ref) => {
        try { ref.current.pause(); ref.current.currentTime = 0; } catch (_) {}
      });
    };
  }, []);

  // scar + damage number over each hit team's card (needs data-team-id on TeamCard).
  // These are overlay elements, so the real card DOM is never touched.
  useEffect(() => {
    if (phase !== 'bars-out') return;
    setDmg(deltas.map((d, k) => {
      const el = document.querySelector(`[data-team-id="${d.teamId}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        id: d.teamId, delta: d.delta, k,
        x: r.left + r.width / 2, y: r.top,
        l: r.left, t: r.top, w: r.width, h: r.height,
        rot: `${(Math.random() * 30 - 22).toFixed(0)}deg`,
      };
    }).filter(Boolean));
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const showTitle = phase === 'title' || phase === 'flash' || leaving;
  const showSlashes = phase === 'slash' || phase === 'bars-out';

  return (
    <div
      className={`de-overlay de-phase-${phase}${frozen ? ' de-frozen' : ''}${leaving ? ' de-leaving' : ''}${fading ? ' de-fade' : ''}`}
      style={origin}
    >
      <div className="de-layer de-veil" />
      {showTitle && (
        <div className="de-layer de-atm" aria-hidden="true">
          <div className="de-moon" />
          <svg className="de-smk de-s2" width="100%" height="100%"><rect width="100%" height="100%" filter="url(#de-sm2)" /></svg>
          <svg className="de-smk de-s1" width="100%" height="100%"><rect width="100%" height="100%" filter="url(#de-sm1)" /></svg>
          <svg className="de-smk de-s3" width="100%" height="100%"><rect width="100%" height="100%" filter="url(#de-sm3)" /></svg>
        </div>
      )}
      {showTitle && <div className="de-layer de-fog" />}
      {showTitle && (
        <div className="de-layer de-embers" aria-hidden="true">
          {embers.map((st, i) => <i key={i} style={st} />)}
        </div>
      )}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <filter id="de-water" x="-5%" y="-80%" width="110%" height="260%">
          <feTurbulence ref={turbRef} type="turbulence" baseFrequency="0.01 0.02" numOctaves="1" seed="3" result="n" />
          <feDisplacementMap ref={dispRef} in="SourceGraphic" in2="n" scale="0" />
        </filter>
        <filter id="de-sm1" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.005 0.011" numOctaves="4" seed="7" /><feColorMatrix values="0 0 0 0 .72  0 0 0 0 .05  0 0 0 0 .1  2.8 0 0 0 -1.25" /></filter>
        <filter id="de-sm2" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.009" numOctaves="4" seed="21" /><feColorMatrix values="0 0 0 0 .3  0 0 0 0 .02  0 0 0 0 .07  3 0 0 0 -1.32" /></filter>
        <filter id="de-sm3" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.008 0.016" numOctaves="3" seed="4" /><feColorMatrix values="0 0 0 0 .95  0 0 0 0 .12  0 0 0 0 .16  2.6 0 0 0 -1.4" /></filter>
      </svg>
      <div className="de-layer de-shrine"><img alt="" src={shrineImg} /></div>

      {showTitle && (
        <div className="de-layer de-title-wrap">
          <div ref={titleRef} className="de-eyebrow">{CONTENT.eyebrow}</div>
          <div className="de-tline" />
          <div className="de-name">
            {[...CONTENT.name].map((ch, i) => <span key={i} style={{ '--i': i }}>{ch}</span>)}
          </div>
          {casterName && <div className="de-cast">CAST BY&nbsp;&nbsp;<b>{String(casterName).toUpperCase()}</b></div>}
        </div>
      )}

      {rings.map((i) => <div key={i} className="de-ring" />)}
      <div className="de-layer de-flashfx" />

      {showSlashes && (
        <div className="de-layer de-slashes" aria-hidden="true">
          {slashes.map((st, i) => <div key={i} className="de-cut" style={st} />)}
        </div>
      )}

      <div className="de-layer de-lb" aria-hidden="true"><i /><i /></div>
      <div className="de-layer de-vig" />

      {phase === 'bars-out' && dmg.map((d) => (
        <React.Fragment key={d.id}>
          <div className="de-scar" style={{ left: d.l, top: d.t, width: d.w, height: d.h, '--r': d.rot, animationDelay: `${300 + d.k * 250}ms` }} />
          <div className="de-dmg" style={{ left: d.x, top: d.y, animationDelay: `${d.k * 250}ms` }}>{d.delta}</div>
        </React.Fragment>
      ))}
    </div>
  );
}