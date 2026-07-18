import React, { useState, useEffect, useRef } from "react";

/* =========================================================================
   MARQUEE LIGHTS
   Generates evenly-spaced "bulb" dots that trace the real perimeter of the
   nearest positioned ancestor (straight edges + rounded corner arcs),
   recalculated on resize via ResizeObserver. This replaces relying on
   `border: dotted`, whose spacing is uneven around corners and shifts
   awkwardly as the responsive box changes width.

   Shared by the title marquee (JeopardyBoard.jsx) and the Team Randomizer
   slot machine border (TeamRandomizer.jsx) — drop it in as the first
   child of any `position: relative` box and it'll trace that box's edge.
   ========================================================================= */
export default function MarqueeBulbs({ inset = 9, radius = 14, spacing = 22, size = 8 }) {
  const wrapRef = useRef(null);
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

      const count = Math.max(8, Math.round(perimeter / spacing));
      const step = perimeter / count;

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

      const points = [];
      let dist = 0;
      for (let i = 0; i < count; i++) {
        let d = dist;
        let seg = null;
        for (const s of segments) {
          if (d <= s.len || s === segments[segments.length - 1]) {
            seg = s;
            break;
          }
          d -= s.len;
        }
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
        points.push({ x, y, delay: (i % 6) * 0.18 });
        dist += step;
      }
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
