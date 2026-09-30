import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../styles/domain-expansion.css';
import domainExpansionSfx from '../assets/domain_expansion.mp3';
import domainNameSfx      from '../assets/domain_name.mp3';
import domainThemeSfx     from '../assets/domain_theme.mp3';
import shrineImg          from '../assets/domain_shrine.png';

/* DomainExpansion — merged preview version
   bars in → title (blood sky + smoke) → flash → slash barrage + rising shrine → bars out.
   Tweak pacing in TIMING; text in CONTENT. */

const CONTENT = { eyebrow: 'DOMAIN EXPANSION', name: '伏魔御廚子' };

const TIMING = {
  barsInMs: 150,
  riseMs: 4600,       // must match --de-rise in the CSS
  holdMs: 4600,       // hold after eyebrow rise, before flash
  flashMs: 0,          // 0 = slashes start the instant the title hold ends
  slashMs: 5800,
  slashCount: 280,
  freezeMs: 0,        // impact freeze frame (0 = off)
  barsOutTailMs: 2800, // exit + time to show the damage numbers
};

const TITLE_START    = TIMING.barsInMs;
const FLASH_START    = TITLE_START + TIMING.riseMs + TIMING.holdMs;
const SLASH_START    = FLASH_START + TIMING.flashMs;
const BARS_OUT_START = SLASH_START + TIMING.slashMs;
const DONE_AT        = BARS_OUT_START + TIMING.barsOutTailMs;

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
      '--dl': `${i < 40 ? rand(0, 250) : rand(0, TIMING.slashMs - 200)}ms`, // first 40 fire right away
    };
  });
}

export default function DomainExpansion({ onDone, deltas = [], casterName }) {
  const [phase, setPhase] = useState('bars-in');
  const [frozen, setFrozen] = useState(false);
  const [dmg, setDmg] = useState([]);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const slashes = useMemo(buildSlashes, []);

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

    const at = (ms, fn) => setTimeout(fn, ms);
    const timers = [
      at(TITLE_START,    () => setPhase('title')),
      at(FLASH_START,    () => setPhase('flash')),
      at(SLASH_START,    () => { setPhase('slash'); if (TIMING.freezeMs > 0) { setFrozen(true); setTimeout(() => setFrozen(false), TIMING.freezeMs); } sfxTheme.current.play().catch(() => {}); document.body.classList.add('de-shaking'); }),
      at(BARS_OUT_START, () => { setPhase('bars-out'); document.body.classList.remove('de-shaking'); }),
      at(DONE_AT,        () => onDoneRef.current?.()),
    ];

    return () => {
      timers.forEach(clearTimeout);
      document.body.classList.remove('de-shaking');
      sfxExpansion.current.removeEventListener('ended', onExpansionEnded);
      [sfxExpansion, sfxName, sfxTheme].forEach((ref) => {
        try { ref.current.pause(); ref.current.currentTime = 0; } catch (_) {}
      });
    };
  }, []);

  // place each damage number above its team card (needs data-team-id on TeamCard)
  useEffect(() => {
    if (phase !== 'bars-out') return;
    setDmg(deltas.map((d) => {
      const el = document.querySelector(`[data-team-id="${d.teamId}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { id: d.teamId, delta: d.delta, x: r.left + r.width / 2, y: r.top };
    }).filter(Boolean));
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const showTitle = phase === 'title' || phase === 'flash';
  const showSlashes = phase === 'slash' || phase === 'bars-out';

  return (
    <div className={`de-overlay de-phase-${phase}${frozen ? ' de-frozen' : ''}`}>
      <div className="de-layer de-veil" />
      <div className="de-layer de-smoke" />
      <div className="de-layer de-shrine"><img alt="" src={shrineImg} /></div>

      {showTitle && (
        <div className={`de-layer de-title-wrap${phase === 'flash' ? ' de-flashing' : ''}`}>
          <div className="de-eyebrow">{CONTENT.eyebrow}</div>
          <div className="de-name">
            {[...CONTENT.name].map((ch, i) => <span key={i} style={{ '--i': i }}>{ch}</span>)}
          </div>
          {casterName && <div className="de-cast">CAST BY&nbsp;&nbsp;<b>{String(casterName).toUpperCase()}</b></div>}
        </div>
      )}

      {showSlashes && (
        <div className="de-layer de-slashes" aria-hidden="true">
          {slashes.map((st, i) => <div key={i} className="de-cut" style={st} />)}
        </div>
      )}

      <div className="de-layer de-vig" />
      <div className="de-layer de-grain" />

      {phase === 'bars-out' && dmg.map((d) => (
        <div key={d.id} className="de-dmg" style={{ left: d.x, top: d.y }}>{d.delta}</div>
      ))}
    </div>
  );
}