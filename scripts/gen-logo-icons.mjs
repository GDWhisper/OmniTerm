#!/usr/bin/env node
/**
 * Generate the OmniTerm logo assets from the single source of truth.
 *
 * Source:  frontend/src/components/PixelUI/omnitermSprite.ts
 * Outputs: frontend/public/favicon.svg
 *          frontend/public/icon-192.png
 *          frontend/public/icon-512.png
 *
 * Usage:
 *   node scripts/gen-logo-icons.mjs          # regenerate the committed assets
 *   node scripts/gen-logo-icons.mjs --check  # verify assets match the source (CI)
 *
 * Zero external dependencies: the PNGs are encoded by hand with node:zlib
 * (`deflateSync` + `crc32`). Importing the `.ts` source relies on Node's type
 * stripping (default since Node 22.18 / 23.6; behind `--experimental-strip-types`
 * from 22.6).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import zlib from 'node:zlib'

import { OMNITERM_SPRITE, SPRITE_SIZE } from '../frontend/src/components/PixelUI/omnitermSprite.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = path.join(ROOT, 'frontend', 'public')

/** favicon.svg — one <rect> per sprite entry, same 2-space indent as before. */
function renderSvg() {
  const rects = OMNITERM_SPRITE.map(
    (r) => `  <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill}"/>`,
  ).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SPRITE_SIZE} ${SPRITE_SIZE}" shape-rendering="crispEdges">\n${rects}\n</svg>\n`
}

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`invalid color: ${hex}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** One PNG chunk: length + type + data + CRC32(type + data). */
function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 8 + data.length)
  return out
}

/** Minimal 8-bit RGBA PNG encoder (no filtering, no interlacing). */
function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour + alpha
  // bytes 10-12 (compression/filter/interlace) stay 0
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Scale the 16×16 sprite to `size`×`size`, nearest-neighbour, transparent bg. */
function rasterize(size) {
  if (size % SPRITE_SIZE !== 0) throw new Error(`size ${size} is not a multiple of ${SPRITE_SIZE}`)
  const scale = size / SPRITE_SIZE
  const rgba = Buffer.alloc(size * size * 4) // fully transparent
  for (const r of OMNITERM_SPRITE) {
    const [red, green, blue] = hexToRgb(r.fill)
    for (let y = r.y * scale; y < (r.y + r.h) * scale; y++) {
      for (let x = r.x * scale; x < (r.x + r.w) * scale; x++) {
        const i = (y * size + x) * 4
        rgba[i] = red
        rgba[i + 1] = green
        rgba[i + 2] = blue
        rgba[i + 3] = 0xff
      }
    }
  }
  return rgba
}

const ARTIFACTS = [
  { rel: 'frontend/public/favicon.svg', data: Buffer.from(renderSvg(), 'utf8') },
  { rel: 'frontend/public/icon-192.png', data: encodePng(192, rasterize(192)) },
  { rel: 'frontend/public/icon-512.png', data: encodePng(512, rasterize(512)) },
]

const check = process.argv.includes('--check')
let drift = false
for (const a of ARTIFACTS) {
  const abs = path.join(ROOT, a.rel)
  let existing = null
  try {
    existing = readFileSync(abs)
  } catch {
    existing = null
  }
  if (check) {
    if (existing === null) {
      drift = true
      console.error(`✗ ${a.rel} is missing`)
    } else if (!existing.equals(a.data)) {
      drift = true
      console.error(`✗ ${a.rel} differs from omnitermSprite.ts`)
    } else {
      console.log(`✓ ${a.rel}`)
    }
  } else {
    writeFileSync(abs, a.data)
    console.log(`wrote ${a.rel} (${a.data.length} bytes)`)
  }
}

if (check && drift) {
  console.error('\nDerived logo assets are stale. Run: node scripts/gen-logo-icons.mjs')
  process.exit(1)
}
