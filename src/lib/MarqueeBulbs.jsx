import React, { useState, useEffect, useRef } from "react";

/* =========================================================================
   MARQUEE LIGHTS
   Generates evenly-spaced "bulb" dots that trace the real perimeter of the
   nearest positioned ancestor (straight edges + rounded corner arcs),
   recalculated on resize via ResizeObserver.

   Bulbs are allocated PER SEGMENT (each straight edge, each corner arc)
   rather than by walking a single global step around the whole perimeter.
   The four corner arcs are identical in length by construction, so the
   largest-remainder allocation below always gives them the same bulb
   count — no phase drift, no bunching/gapping at any one corner (the old
   global-step approach could drift out of phase with segment boundaries
   depending on the box's exact aspect ratio, which is what caused the
   top corners to look uneven while the bottom happened to line up).

   Shared by the title marquee (JeopardyBoard.jsx) and the Team Randomizer
   slot machine border (TeamRandomizer.jsx) — drop it in as the first
   child of any `position: relative` box and it'll trace that box's edge.
   ========================================================================= */
export default function MarqueeBulbs({ inset = 6, radius = 14, spacing = 20, size = 7 }) 
{  const wrapRef = useRef(null);
  const [bulbs, setBulbs] = useState([]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const compute = () => {
      const parent = el.parentElement;
      if (!parent) return;
      const w = parent.clientWidth - inset * 2;
      const h = parent.clientHeight - inset * 2;
      if (w <= 0 || h <= 0) return;

      const r = Math.min(radius, w / 2, h / 2);
      const straightW = Math.max(0, w - 2 * r);
      const straightH = Math.max(0, h - 2 * r);
      const cornerArc = (Math.PI / 2) * r;
      const perimeter = 2 * straightW + 2 * straightH + 4 * cornerArc;
      if (perimeter <= 0) return;

      const totalCount = Math.max(8, Math.round(perimeter / spacing));

      // Walk clockwise from the top-left corner's start of the top edge.
      const segments = [
        { len: straightW, type: "top" },
        { len: cornerArc, type: "corner", cx: w - r, cy: r, start: -Math.PI / 2 },
        { len: straightH, type: "right" },
        { len: cornerArc, type: "corner", cx: w - r, cy: h - r, start: 0 },
        { len: straightW, type: "bottom" },
        { len: cornerArc, type: "corner", cx: r, cy: h - r, start: Math.PI / 2 },
        { len: straightH, type: "left" },
        { len: cornerArc, type: "corner", cx: r, cy: r, start: Math.PI },
      ];

      // Largest-remainder allocation: give each segment floor(share) bulbs,
      // then hand out the leftover bulbs to the segments with the biggest
      // fractional remainder until the total matches totalCount exactly.
      // Because all four corner arcs share the same length, they always
      // receive the same base share and (with symmetric remainders) the
      // same final count — keeping every corner visually identical.
      const raw = segments.map((s) => (s.len / perimeter) * totalCount);
      const base = raw.map(Math.floor);
      let assigned = base.reduce((a, b) => a + b, 0);
      const order = raw
        .map((v, i) => ({ i, frac: v - base[i] }))
        .sort((a, b) => b.frac - a.frac);
      let k = 0;
      while (assigned < totalCount && k < order.length) {
        base[order[k].i] += 1;
        assigned++;
        k++;
      }
      // Make sure no non-zero-length segment ends up with 0 bulbs.
      for (let i = 0; i < segments.length; i++) {
        if (segments[i].len > 0 && base[i] === 0) {
          let maxIdx = base.reduce((m, v, j) => (v > base[m] ? j : m), 0);
          if (base[maxIdx] > 1) {
            base[maxIdx] -= 1;
            base[i] += 1;
          }
        }
      }

      const points = [];
      let globalIndex = 0;
      segments.forEach((seg, si) => {
        const n = base[si];
        if (n <= 0 || seg.len <= 0) return;
        const step = seg.len / n;
        for (let i = 0; i < n; i++) {
          const d = i * step;
          let x, y;
          if (seg.type === "top") {
            x = r + d;
            y = 0;
          } else if (seg.type === "bottom") {
            x = w - r - d;
            y = h;
          } else if (seg.type === "left") {
            x = 0;
            y = h - r - d;
          } else if (seg.type === "right") {
            x = w;
            y = r + d;
          } else {
            const angle = seg.start + d / r;
            x = seg.cx + r * Math.cos(angle);
            y = seg.cy + r * Math.sin(angle);
          }
          points.push({ x, y, delay: (globalIndex % 6) * 0.18 });
          globalIndex++;
        }
      });
      setBulbs(points);
    };

    compute();
    const ro = new ResizeObserver(compute);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [inset, radius, spacing]);

  return (
    <div className="marquee-bulbs" ref={wrapRef} aria-hidden="true">
      {bulbs.map((b, i) => (
        <span
          key={i}
          className="marquee-bulb"
          style={{
            left: b.x,
            top: b.y,
            width: size,
            height: size,
            animationDelay: `${b.delay}s`,
          }}
        />
      ))}
    </div>
  );
}