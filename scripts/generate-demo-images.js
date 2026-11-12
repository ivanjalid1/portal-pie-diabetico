#!/usr/bin/env node
'use strict';

/**
 * Genera imágenes SINTÉTICAS de demostración (no son de pacientes reales):
 *  - termografia-NN.png: termograma plantar de ambos pies (320×240, paleta
 *    ironbow, barra de color a la derecha), imitando una Fluke TiS75.
 *  - visible-NN.png: imagen "visible" en tonos piel desaturados de la misma toma.
 *
 * Uso: npm run generate:images
 */
const fs = require('node:fs');
const path = require('node:path');
const { encodePng } = require('./lib/png');
const { ironbow } = require('../src/utils/thermal');
const { seededRandom } = require('../src/utils/random');

const OUT = path.join(__dirname, '..', 'public', 'demo');
const VARIANTS = 6;

/** Forma del pie (coordenadas locales en px, el lado medial es +x). */
function footField(x, y) {
  const ell = (cx, cy, rx, ry) => 1 - ((x - cx) / rx) ** 2 - ((y - cy) / ry) ** 2;
  let f = Math.max(
    ell(0, 62, 30, 34), // talón
    ell(-6, 15, 28, 56), // mediopié
    ell(2, -40, 40, 31), // antepié
  );
  const arch = ell(33, 20, 16, 38);
  if (arch > 0) f = Math.min(f, -arch * 0.6);
  const toes = Math.max(
    ell(25, -76, 13, 17),
    ell(5, -82, 9, 10),
    ell(-10, -78, 8, 9),
    ell(-23, -71, 7.5, 8),
    ell(-33, -61, 6.5, 7),
  );
  return { body: f, toes, inside: Math.max(f, toes) };
}

function smoothNoise(rnd) {
  const waves = Array.from({ length: 6 }, () => ({
    fx: 0.02 + rnd() * 0.08,
    fy: 0.02 + rnd() * 0.08,
    p: rnd() * Math.PI * 2,
    a: 0.08 + rnd() * 0.12,
  }));
  return (x, y) => waves.reduce((s, w) => s + w.a * Math.sin(w.fx * x + w.fy * y + w.p), 0);
}

function render(variant) {
  const W = 320;
  const H = 240;
  const rnd = seededRandom(`demo-image-${variant}`);
  const noise = smoothNoise(rnd);
  const tMin = 22;
  const tMax = 35;
  const base = 27.6 + rnd() * 2.2;
  const affected = rnd() < 0.5 ? 'der' : 'izq';
  const hotAmp = [0.4, 2.4, 1.2, 2.8, 0.8, 1.7][variant - 1];
  const hotAtToe = rnd() < 0.6;
  const scale = 0.98;

  const feet = [
    { side: 'der', cx: 104, cy: 122, mirror: 1 },
    { side: 'izq', cx: 214, cy: 122, mirror: -1 },
  ];

  const thermal = Buffer.alloc(W * H * 3);
  const visible = Buffer.alloc(W * H * 3);

  for (let py = 0; py < H; py += 1) {
    for (let px = 0; px < W; px += 1) {
      let t = 23 + noise(px, py) * 0.6 + (py / H) * 0.5; // fondo (tela/cartulina)
      let lum = 34 + noise(px * 1.3, py) * 18;
      let inside = false;
      for (const foot of feet) {
        const lx = ((px - foot.cx) * foot.mirror) / scale;
        const ly = (py - foot.cy) / scale;
        const { body, toes, inside: f } = footField(lx, ly);
        if (f <= 0) continue;
        inside = true;
        const edge = Math.min(1, f * 2.4); // enfriamiento en el borde
        let temp = base + 0.5 * noise(px * 2, py * 2);
        temp += 1.5 * Math.exp(-((lx - 18) ** 2) / 500 - (ly - 12) ** 2 / 1800); // arco interno más cálido
        temp += 0.7 * Math.exp(-(lx ** 2) / 900 - (ly + 40) ** 2 / 500); // metatarso
        if (toes > body) temp -= 1.3; // dedos más fríos
        temp -= 0.4 * Math.max(0, (ly - 60) / 40); // talón levemente más frío
        if (foot.side === affected) {
          const [hx, hy] = hotAtToe ? [25, -76] : [4, -42];
          temp += hotAmp * Math.exp(-((lx - hx) ** 2 + (ly - hy) ** 2) / (hotAtToe ? 220 : 520));
        }
        t = 23.5 + (temp - 23.5) * (0.35 + 0.65 * edge);
        const shade = 0.75 + 0.25 * edge;
        lum = (150 + 40 * shade + 12 * noise(px * 3, py * 3)) * (toes > body ? 0.96 : 1);
      }

      const i = (py * W + px) * 3;
      const [r, g, b] = ironbow((t - tMin) / (tMax - tMin));
      thermal[i] = r;
      thermal[i + 1] = g;
      thermal[i + 2] = b;

      const grain = (rnd() - 0.5) * 6;
      const L = Math.max(0, Math.min(255, lum + grain));
      visible[i] = inside ? Math.min(255, L * 1.02) : L;
      visible[i + 1] = inside ? L * 0.93 : L;
      visible[i + 2] = inside ? L * 0.86 : L * 1.02;
    }
  }

  // Barra de color (como en la pantalla de la cámara).
  for (let py = 24; py < 216; py += 1) {
    const [r, g, b] = ironbow(1 - (py - 24) / 192);
    for (let px = 296; px < 306; px += 1) {
      const i = (py * W + px) * 3;
      thermal[i] = r;
      thermal[i + 1] = g;
      thermal[i + 2] = b;
    }
    if ((py - 24) % 48 === 0) {
      for (let px = 290; px < 295; px += 1) {
        const i = (py * W + px) * 3;
        thermal[i] = thermal[i + 1] = thermal[i + 2] = 230;
      }
    }
  }

  return { thermal: encodePng(W, H, thermal), visible: encodePng(W, H, visible) };
}

fs.mkdirSync(OUT, { recursive: true });
for (let v = 1; v <= VARIANTS; v += 1) {
  const n = String(v).padStart(2, '0');
  const { thermal, visible } = render(v);
  fs.writeFileSync(path.join(OUT, `termografia-${n}.png`), thermal);
  fs.writeFileSync(path.join(OUT, `visible-${n}.png`), visible);
  console.log(`demo ${n}: termografía ${thermal.length} B, visible ${visible.length} B`);
}
