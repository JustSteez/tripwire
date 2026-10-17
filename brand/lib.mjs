// Drawing helpers for the Tripwire brand kit: outlined text, the wire mark, the seismograph.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const here = dirname(fileURLToPath(import.meta.url));
const font = (file) => opentype.loadSync(resolve(here, 'fonts', file));

export const F = {
  cond: font('Archivo-Cond-ExtraBold.ttf'), // headlines (site h1: wdth 68, wght 800)
  wide: font('Archivo-Wide-Black.ttf'), // wordmark (site: wdth 125, wght 900)
  body: font('Archivo-Regular.ttf'),
  bodySemi: font('Archivo-SemiBold.ttf'),
  mono: font('IBMPlexMono-Regular.ttf'),
  monoSemi: font('IBMPlexMono-SemiBold.ttf'),
};

// Same tokens as style.css
export const C = {
  paper: '#f2ede3',
  paper2: '#e9e2d4',
  card: '#fbf8f2',
  ink: '#16140f',
  ink2: '#4a453c',
  muted: '#8a8274',
  rule: '#d6cdbb',
  high: '#e0401f',
  highTint: '#fbe2d9',
  mid: '#c98a0c',
  midTint: '#f6ead0',
  low: '#2e7a50',
  lowTint: '#dcecdf',
};

export function measure(f, str, size, spacing = 0) {
  return [...str].reduce((w, ch) => w + f.getAdvanceWidth(ch, size) + spacing, 0) - spacing;
}

/** Text as outlined paths, so SVGs and PNGs render identically everywhere. */
export function text(f, str, x, y, size, fill, { anchor = 'start', spacing = 0 } = {}) {
  const width = measure(f, str, size, spacing);
  let cx = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  let d = '';
  for (const ch of str) {
    d += f.getPath(ch, cx, y, size).toPathData(2);
    cx += f.getAdvanceWidth(ch, size) + spacing;
  }
  return `<path d="${d}" fill="${fill}"/>`;
}

/** Several lines of text; each item is a string or [string, fill]. Returns { svg, bottom }. */
export function lines(f, list, x, y, size, fill, { leading = 1.3, anchor, spacing } = {}) {
  let out = '';
  list.forEach((item, i) => {
    const [str, color] = Array.isArray(item) ? item : [item, fill];
    out += text(f, str, x, y + i * size * leading, size, color, { anchor, spacing });
  });
  return { svg: out, bottom: y + (list.length - 1) * size * leading };
}

/** Greedy word wrap to a max width. */
export function wrap(f, str, size, maxW) {
  const out = [];
  let line = '';
  for (const word of str.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(f, next, size) > maxW) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/** A run of differently coloured words on one baseline: [[str, fill], ...]. */
export function runs(f, parts, x, y, size, { spacing = 0 } = {}) {
  let cx = x;
  let out = '';
  for (const [str, fill] of parts) {
    out += text(f, str, cx, y, size, fill, { spacing });
    cx += measure(f, str, size, spacing);
  }
  return out;
}

export function svg(w, h, body, bg) {
  const fill = bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${fill}${body}</svg>\n`;
}

/** The site's paper texture: a fine dot grid. */
export function grain(w, h, id = 'grain') {
  return `<defs><pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="1.1" fill="${C.ink}" opacity="0.07"/></pattern></defs><rect width="${w}" height="${h}" fill="url(#${id})"/>`;
}

/**
 * The mark: a taut wire on an ink tile, tripped into one sharp spike.
 * Drawn on a 100×100 grid, placed at (x, y) with side `s`.
 */
export function mark(x, y, s, { tile = true, wire = C.paper, spike = C.high, bg = C.ink } = {}) {
  const k = s / 100;
  const body =
    (tile ? `<rect width="100" height="100" rx="22" fill="${bg}"/>` : '') +
    `<path d="M14 58 H36" stroke="${wire}" stroke-width="7" stroke-linecap="round" fill="none"/>` +
    `<path d="M64 58 H86" stroke="${wire}" stroke-width="7" stroke-linecap="round" fill="none"/>` +
    `<path d="M36 58 L44 24 L54 82 L64 58" stroke="${spike}" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  return `<g transform="translate(${x} ${y}) scale(${k})">${body}</g>`;
}

/** The dashed ink/red wire rule from the site masthead. */
export function wireRule(x, y, w, h = 3) {
  let out = '';
  for (let cx = x; cx < x + w; cx += 22) {
    out += `<rect x="${cx}" y="${y}" width="${Math.min(14, x + w - cx)}" height="${h}" fill="${C.ink}"/>`;
    if (cx + 14 < x + w) out += `<rect x="${cx + 14}" y="${y}" width="${Math.min(8, x + w - cx - 14)}" height="${h}" fill="${C.high}"/>`;
  }
  return out;
}

/** Deterministic pseudo-random numbers so the art is identical on every build. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Seismograph strip: a dashed wire with bars whose colour is the worst event in that slot. */
export function seismo(x, y, w, h, { buckets = 96, seed = 7, density = 0.62 } = {}) {
  const rnd = seeded(seed);
  const bw = w / buckets;
  let out = `<line x1="${x}" x2="${x + w}" y1="${y + h / 2}" y2="${y + h / 2}" stroke="${C.ink}" stroke-width="2" stroke-dasharray="8 6" opacity="0.4"/>`;
  for (let i = 0; i < buckets; i++) {
    if (rnd() > density) continue;
    const r = rnd();
    const level = r < 0.5 ? C.high : r < 0.88 ? C.mid : C.low;
    const amp = Math.max(0.12, rnd() ** 1.7) * (h / 2 - 2);
    out += `<rect x="${(x + i * bw + bw * 0.15).toFixed(1)}" y="${(y + h / 2 - amp).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${(amp * 2).toFixed(1)}" rx="1.5" fill="${level}"/>`;
  }
  return out;
}

/** A feed row as on the site: level border, tag, label, sentence. */
export function feedRow(x, y, w, { level, tag, who, line, when }) {
  const col = { high: [C.high, C.highTint], mid: [C.mid, C.midTint], low: [C.low, C.lowTint] }[level];
  const h = 104;
  return (
    `<defs><linearGradient id="g${y}" x1="0" x2="1"><stop offset="0" stop-color="${col[1]}"/><stop offset="0.45" stop-color="${col[1]}" stop-opacity="0"/></linearGradient></defs>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#g${y})"/>` +
    `<rect x="${x}" y="${y}" width="6" height="${h}" fill="${col[0]}"/>` +
    `<rect x="${x}" y="${y + h - 1.5}" width="${w}" height="1.5" fill="${C.rule}"/>` +
    text(F.mono, when, x + 30, y + 44, 20, C.muted) +
    text(F.cond, tag.toUpperCase(), x + 170, y + 46, 30, col[0], { spacing: 0.5 }) +
    text(F.monoSemi, who, x + 430, y + 44, 24, C.ink) +
    text(F.body, line, x + 430, y + 80, 22, C.ink2)
  );
}
