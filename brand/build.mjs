// Builds the Tripwire brand kit: SVGs with outlined text, plus PNG renders.
// Run: npm install && npm run build   (inside brand/)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { C, F, feedRow, grain, lines, mark, measure, runs, seismo, svg, text, wireRule, wrap } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = { svg: resolve(here, 'svg'), png: resolve(here, 'png'), posts: resolve(here, 'posts') };
Object.values(OUT).forEach((d) => mkdirSync(d, { recursive: true }));

const SITE = 'tripwire.top';
const WORD = 'TRIPWIRE';
const WORD_SPACING = 0.06; // em

// ---------------------------------------------------------------- marks and lockups

const wordmark = (x, y, size, fill) => text(F.wide, WORD, x, y, size, fill, { spacing: size * WORD_SPACING });
const wordWidth = (size) => measure(F.wide, WORD, size, size * WORD_SPACING);

function lockup(fg, bg, markOpts = {}) {
  const H = 200;
  const m = 140;
  const size = 92;
  const tx = 30 + m + 44;
  const W = Math.round(tx + wordWidth(size) + 40);
  const body = mark(30, (H - m) / 2, m, markOpts) + wordmark(tx, H / 2 + size * 0.36, size, fg);
  return svg(W, H, body, bg);
}


// Ink-on-paper is primary; on ink the tile flips to paper so the mark still reads.
const paperTile = { bg: C.paper, wire: C.ink };

const assets = {
  mark: svg(100, 100, mark(0, 0, 100)),
  'mark-on-paper': svg(100, 100, mark(0, 0, 100, paperTile)),
  'lockup-on-paper': lockup(C.ink, C.paper),
  'lockup-on-ink': lockup(C.paper, C.ink, paperTile),
  'lockup-transparent': lockup(C.ink, null),
  'x-profile': svg(400, 400, mark(50, 41, 300, { tile: false }), C.ink), // wire centred inside X's circle crop
};

// ---------------------------------------------------------------- X header (1500×500)
// X lays the avatar over the bottom-left corner, so that corner stays empty.
{
  const W = 1500;
  const H = 500;
  const head = 104;
  const body =
    grain(W, H) +
    lines(F.cond, ['CONTRACTS THAT JUST', ['CHANGED THEIR RULES.', C.high]], 80, 168, head, C.ink, { leading: 0.94 }).svg +
    seismo(420, 312, W - 500, 112, { buckets: 88, seed: 11 }) +
    text(F.monoSemi, 'CODE SWAPS · ADMIN MOVES · OWNER HANDOFFS · PAUSES', W - 80, 462, 19, C.ink2, { anchor: 'end', spacing: 1.5 });
  assets['x-banner'] = svg(W, H, body, C.paper);
}

// ---------------------------------------------------------------- link preview (1200×630)
function masthead(x, y, w, s = 1) {
  const m = 52 * s;
  const size = 26 * s;
  const tx = x + m + 18 * s;
  const ww = wordWidth(size);
  const liveW = measure(F.mono, 'LIVE', 18 * s) + 22 * s;
  return (
    mark(x, y, m) +
    wordmark(tx, y + m / 2 + size * 0.36, size, C.ink) +
    wireRule(tx + ww + 22 * s, y + m / 2 - 1.5 * s, w - (tx - x) - ww - 44 * s - liveW, 3 * s) +
    `<circle cx="${x + w - liveW + 6 * s}" cy="${y + m / 2}" r="${6 * s}" fill="${C.low}"/>` +
    text(F.mono, 'LIVE', x + w, y + m / 2 + 6 * s, 18 * s, C.ink2, { anchor: 'end' })
  );
}

{
  const W = 1200;
  const H = 630;
  const size = Math.min(104, (104 * (W - 128)) / measure(F.cond, 'CONTRACTS ON ROBINHOOD CHAIN', 104));
  const body =
    grain(W, H) +
    masthead(64, 52, W - 128) +
    text(F.cond, 'CONTRACTS ON ROBINHOOD CHAIN', 64, 250, size, C.ink) +
    runs(F.cond, [['THAT JUST ', C.ink], ['CHANGED', C.high]], 64, 250 + size * 0.92, size) +
    text(F.cond, 'THEIR RULES.', 64, 250 + size * 1.84, size, C.high) +
    seismo(64, 488, W - 128, 92, { buckets: 80, seed: 3 });
  assets['og-image'] = svg(W, H, body, C.paper);
}

// ---------------------------------------------------------------- posts (1600×900)
const PW = 1600;
const PH = 900;

function footer() {
  return (
    `<rect x="0" y="${PH - 84}" width="${PW}" height="84" fill="${C.ink}"/>` +
    mark(80, PH - 66, 48, paperTile) +
    wordmark(146, PH - 32, 24, C.paper) +
    text(F.mono, SITE, PW - 80, PH - 34, 22, C.paper, { anchor: 'end' })
  );
}

const post = (body) => svg(PW, PH, grain(PW, PH) + body + footer(), C.paper);

// 1. Launch
{
  const sub = wrap(F.body, 'A live feed of Robinhood Chain contracts whose code, admin, owner or pause state just changed. Read straight from the chain.', 34, 900);
  const rows = [
    { level: 'high', tag: 'Code swapped', who: '0x1b66…4335', line: 'Implementation replaced with 0x6864…00c2', when: '30m ago' },
    { level: 'high', tag: 'Paused', who: '0x27db…f132', line: 'Contract paused by 0x0ed8…41d4', when: '49m ago' },
    { level: 'mid', tag: 'Owner changed', who: '6 contracts', line: 'Ownership handed from 0x7d66…5581 to 0x30e8…918e', when: '54m ago' },
  ];
  assets['post-1-live'] =
    post(
      runs(F.cond, [['TRIPWIRE IS ', C.ink], ['LIVE.', C.high]], 80, 230, 168) +
      lines(F.body, sub, 84, 310, 34, C.ink2, { leading: 1.35 }).svg +
      rows.map((r, i) => feedRow(80, 470 + i * 106, PW - 160, r)).join(''),
    );
}

// 2. What trips the wire
{
  const cards = [
    ['high', 'CODE SWAPPED', 'Upgraded(address)', 'A proxy now runs different code than the one you bought.'],
    ['high', 'ADMIN MOVED', 'AdminChanged(address,address)', 'Someone new holds the key that can replace the code.'],
    ['mid', 'OWNER CHANGED', 'OwnershipTransferred(address,address)', 'Control handed to another wallet. Renounces show in green.'],
    ['high', 'PAUSED', 'Paused(address)', 'Transfers or trading switched off by the contract owner.'],
  ];
  const col = { high: C.high, mid: C.mid };
  const cw = (PW - 160 - 40) / 2;
  const ch = 250;
  const grid = cards
    .map(([lvl, tag, sig, desc], i) => {
      const x = 80 + (i % 2) * (cw + 40);
      const y = 250 + Math.floor(i / 2) * (ch + 34);
      return (
        `<rect x="${x + 8}" y="${y + 8}" width="${cw}" height="${ch}" rx="6" fill="${C.ink}"/>` +
        `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="6" fill="${C.card}" stroke="${C.ink}" stroke-width="3"/>` +
        `<rect x="${x}" y="${y}" width="12" height="${ch}" rx="3" fill="${col[lvl]}"/>` +
        text(F.cond, tag, x + 44, y + 78, 64, col[lvl]) +
        text(F.mono, sig, x + 46, y + 120, 21, C.muted) +
        lines(F.body, wrap(F.body, desc, 30, cw - 90), x + 46, y + 172, 30, C.ink, { leading: 1.3 }).svg
      );
    })
    .join('');
  assets['post-2-what-trips-it'] = post(
    text(F.monoSemi, 'TRIPWIRE WATCHES EVERY CONTRACT ON ROBINHOOD CHAIN FOR', 82, 116, 22, C.ink2, { spacing: 1.5 }) +
      runs(F.cond, [['FOUR WAYS THE ', C.ink], ['RULES CHANGE.', C.high]], 80, 200, 96) +
      grid,
  );
}

// 3. Check any token (a real lookup, token name withheld)
{
  const x = 80;
  const y = 330;
  const w = PW - 160;
  const h = 450;
  const verdict = (vx, vy, label, detail, c, t) => {
    const vw = Math.max(measure(F.bodySemi, label, 26), measure(F.mono, detail, 20)) + 52;
    return (
      `<rect x="${vx}" y="${vy}" width="${vw}" height="82" fill="${t}"/><rect x="${vx}" y="${vy}" width="6" height="82" fill="${c}"/>` +
      text(F.bodySemi, label, vx + 26, vy + 36, 26, C.ink) +
      text(F.mono, detail, vx + 26, vy + 66, 20, C.ink2)
    );
  };
  const tl = [
    [C.high, 'CODE SWAPPED', 'Implementation replaced with 0x4476…1187'],
    [C.muted, 'LAUNCHED', 'Launched with owner 0x3947…66f9, running code from 0x012a…6181'],
  ];
  const card =
    `<rect x="${x + 10}" y="${y + 10}" width="${w}" height="${h}" rx="6" fill="${C.ink}"/>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${C.card}" stroke="${C.ink}" stroke-width="3"/>` +
    text(F.monoSemi, 'REAL LOOKUP · NAME HIDDEN', x + 40, y + 56, 20, C.high, { spacing: 2 }) +
    text(F.cond, 'A $270K TOKEN', x + 40, y + 122, 64, C.ink) +
    text(F.mono, '$270K mcap   $52K liquidity   1 rule change since launch', x + w - 40, y + 118, 22, C.ink2, { anchor: 'end' }) +
    `<rect x="${x + 40}" y="${y + 150}" width="${w - 80}" height="72" rx="4" fill="${C.high}"/>` +
    runs(F.cond, [['RULES FIRST CHANGED ', C.paper], ['8s', C.paper], [' AFTER LAUNCH.', C.paper]], x + 66, y + 202, 40) +
    verdict(x + 40, y + 246, 'Upgradeable: its code can be replaced.', 'Runs code from 0x4476…1187', C.high, C.highTint) +
    verdict(x + 640, y + 246, 'Has an owner.', '0x3947…66f9', C.mid, C.midTint) +
    tl.map(([c, tag, line], i) =>
      text(F.cond, tag, x + 40, y + 378 + i * 46, 28, c) + text(F.body, line, x + 260, y + 378 + i * 46, 24, C.ink2),
    ).join('');
  assets['post-3-check-any-token'] = post(
    runs(F.cond, [['PASTE ANY TOKEN. ', C.ink]], 80, 150, 112) +
      runs(F.cond, [['SEE ', C.ink], ['WHO CAN CHANGE IT.', C.high]], 80, 262, 112) +
      card,
  );
}

// 4. 24h numbers (live scan, 16 Oct 2026)
{
  const stats = [
    ['Code swaps', 100, C.high],
    ['Owner changes', 42, C.mid],
    ['Pauses', 13, C.high],
    ['Renounces', 8, C.low],
    ['Unpauses', 6, C.mid],
  ];
  const max = 100;
  const bx = 820;
  const bw = PW - 80 - bx - 120;
  const bars = stats
    .map(([label, n, c], i) => {
      const y = 286 + i * 92;
      return (
        text(F.bodySemi, label, bx, y, 28, C.ink) +
        `<rect x="${bx}" y="${y + 18}" width="${Math.max(8, (n / max) * bw)}" height="34" rx="3" fill="${c}"/>` +
        text(F.monoSemi, String(n), bx + Math.max(8, (n / max) * bw) + 16, y + 46, 28, C.ink)
      );
    })
    .join('');
  assets['post-4-24h'] = post(
    text(F.monoSemi, 'ROBINHOOD CHAIN · LAST 24 HOURS', 82, 136, 22, C.ink2, { spacing: 2 }) +
      text(F.cond, '169', 70, 420, 330, C.high) +
      lines(F.cond, ['RULE CHANGES', 'ON LIVE', 'CONTRACTS.'], 84, 520, 74, C.ink, { leading: 0.95 }).svg +
      bars +
      text(F.mono, '+121 smart-wallet upgrades filtered out', bx, 766, 22, C.muted),
  );
}

// ---------------------------------------------------------------- write
const PNG_SIZES = {
  mark: [512, 1024],
  'mark-on-paper': [512],
  'lockup-on-paper': [null],
  'lockup-on-ink': [null],
  'lockup-transparent': [null],
  'x-profile': [400],
  'x-banner': [1500, 3000],
  'og-image': [1200],
};

for (const [name, content] of Object.entries(assets)) {
  const isPost = name.startsWith('post-');
  writeFileSync(resolve(isPost ? OUT.posts : OUT.svg, `${name}.svg`), content);
  for (const width of isPost ? [PW] : PNG_SIZES[name]) {
    const opts = width ? { fitTo: { mode: 'width', value: width } } : {};
    const png = new Resvg(content, opts).render().asPng();
    const suffix = isPost || !width || PNG_SIZES[name].length === 1 ? '' : `-${width}`;
    writeFileSync(resolve(isPost ? OUT.posts : OUT.png, `${name}${suffix}.png`), png);
  }
}
console.log(`built ${Object.keys(assets).length} assets`);
