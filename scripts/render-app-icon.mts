/*
 * Draws the app's icon (owner's decision, 2026-11-23: a simple geometric icon from the
 * app's own colors) and writes packaging/windows/icon.ico, which electron-builder puts in
 * the Windows app and its installer (electron-builder.yml, win.icon), and
 * packaging/macos/icon.icns, the same drawing for the Mac app, its Dock icon and Finder
 * (mac.icon).
 *
 *   node scripts/render-app-icon.mts           writes both files
 *   node scripts/render-app-icon.mts --check   fails if a committed file draws anything else
 *
 * The icon: the sidebar's dark slate tile (--color-nav), with three lines of a page on
 * it: the first in the sidebar's light text color, the second in its amber (the section
 * being drafted, --color-focus-on-nav), the third muted. Each size is drawn on its own
 * (not scaled down from the largest), so the small ones stay sharp, and every pixel is
 * the average of 8 x 8 samples. Plain Node.js: no image library, the same bytes on
 * every machine. tests/windows-installer.test.ts and tests/mac-installer.test.ts check the
 * committed files match, pixel for pixel (compared after decoding, so another zlib build
 * cannot fail them).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";

export const ICON_FILE = path.join(import.meta.dirname, "..", "packaging", "windows", "icon.ico");
export const ICNS_FILE = path.join(import.meta.dirname, "..", "packaging", "macos", "icon.icns");

/** The sizes Windows asks an .ico for: the taskbar, the Start menu, Explorer's views, the installer. */
export const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256] as const;

type Rgb = readonly [number, number, number];
const TILE: Rgb = [0x1b, 0x25, 0x30]; // --color-nav
const LINE: Rgb = [0xf3, 0xf5, 0xf7]; // --color-fg-on-nav
const DRAFT: Rgb = [0xff, 0xc4, 0x6b]; // --color-focus-on-nav
const MUTED: Rgb = [0xc7, 0xd0, 0xd9]; // --color-fg-on-nav-muted

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/** Whether (px, py) is inside the rounded rectangle. */
function inside(b: Box, px: number, py: number): boolean {
  if (px < b.x || py < b.y || px > b.x + b.w || py > b.y + b.h) return false;
  const cx = Math.min(Math.max(px, b.x + b.r), b.x + b.w - b.r);
  const cy = Math.min(Math.max(py, b.y + b.r), b.y + b.h - b.r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= b.r ** 2;
}

/** The shapes, in a 1 x 1 square: the tile, then the three lines, left-aligned. */
function shapes(): { tile: Box; lines: Array<{ box: Box; color: Rgb }> } {
  const tile = { x: 0.03, y: 0.03, w: 0.94, h: 0.94, r: 0.2 };
  const thick = 0.13;
  const left = 0.2;
  const line = (top: number, width: number, color: Rgb) => ({ box: { x: left, y: top, w: width, h: thick, r: thick / 2 }, color });
  return { tile, lines: [line(0.245, 0.6, LINE), line(0.435, 0.44, DRAFT), line(0.625, 0.52, MUTED)] };
}

/** RGBA pixels of the icon at `size` x `size`. */
export function drawIcon(size: number): Buffer {
  const { tile, lines } = shapes();
  const samples = 8;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) / size;
          const py = (y + (sy + 0.5) / samples) / size;
          if (!inside(tile, px, py)) continue;
          const color = lines.find((item) => inside(item.box, px, py))?.color ?? TILE;
          r += color[0];
          g += color[1];
          b += color[2];
          a += 1;
        }
      }
      const offset = (y * size + x) * 4;
      if (a > 0) {
        pixels[offset] = Math.round(r / a);
        pixels[offset + 1] = Math.round(g / a);
        pixels[offset + 2] = Math.round(b / a);
      }
      pixels[offset + 3] = Math.round((a / (samples * samples)) * 255);
    }
  }
  return pixels;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG of RGBA pixels (8 bits per channel, no filtering). */
export function encodePng(size: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An .ico holding one PNG per size (Windows Vista and later read PNG entries at every size). */
export function renderIco(sizes: readonly number[] = ICON_SIZES): Buffer {
  const images = sizes.map((size) => encodePng(size, drawIcon(size)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((size, index) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(images[index].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += images[index].length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

/**
 * The images of a macOS .icns, by type: each a PNG, which macOS reads for every one of
 * these types (OS X 10.7 and later). The @2x types are the Retina images of the size
 * before them (ic11 is 16 points at 2x, so 32 pixels). The set iconutil makes from an
 * .iconset: 16, 32, 128, 256 and 512 points, each at 1x and 2x.
 */
export const ICNS_IMAGES = [
  { type: "icp4", size: 16 },
  { type: "ic11", size: 32 },
  { type: "icp5", size: 32 },
  { type: "ic12", size: 64 },
  { type: "ic07", size: 128 },
  { type: "ic13", size: 256 },
  { type: "ic08", size: 256 },
  { type: "ic14", size: 512 },
  { type: "ic09", size: 512 },
  { type: "ic10", size: 1024 },
] as const;

/** An .icns holding one PNG per type in ICNS_IMAGES; each size is drawn once. */
export function renderIcns(): Buffer {
  const pngs = new Map<number, Buffer>();
  const entries = ICNS_IMAGES.map(({ type, size }) => {
    let png = pngs.get(size);
    if (!png) {
      png = encodePng(size, drawIcon(size));
      pngs.set(size, png);
    }
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0), 4);
  return Buffer.concat([header, ...entries]);
}

/** The RGBA pixels and size of a PNG written by encodePng (unfiltered rows). */
function decodePng(png: Buffer): { size: number; rgba: Buffer } {
  const size = png.readUInt32BE(16);
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) rows.copy(rgba, y * size * 4, y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1));
  return { size, rgba };
}

/** Each image in an .icns written by renderIcns: its type, its size and its RGBA pixels. */
export function decodeIcns(icns: Buffer): Array<{ type: string; size: number; rgba: Buffer }> {
  if (icns.toString("ascii", 0, 4) !== "icns" || icns.readUInt32BE(4) !== icns.length) throw new Error("not an .icns file");
  const images: Array<{ type: string; size: number; rgba: Buffer }> = [];
  for (let at = 8; at < icns.length; ) {
    const type = icns.toString("ascii", at, at + 4);
    const length = icns.readUInt32BE(at + 4);
    images.push({ type, ...decodePng(icns.subarray(at + 8, at + length)) });
    at += length;
  }
  return images;
}

/** Whether `icns` holds exactly the images renderIcns draws. */
export function icnsMatches(icns: Buffer): boolean {
  const images = decodeIcns(icns);
  const drawn = new Map<number, Buffer>();
  const draw = (size: number) => drawn.get(size) ?? drawn.set(size, drawIcon(size)).get(size)!;
  return (
    images.length === ICNS_IMAGES.length &&
    images.every((image, index) => image.type === ICNS_IMAGES[index].type && image.size === ICNS_IMAGES[index].size && image.rgba.equals(draw(image.size)))
  );
}

/** Each image in an .ico written by renderIco: its size and its RGBA pixels. */
export function decodeIco(ico: Buffer): Array<{ size: number; rgba: Buffer }> {
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + 16 * index;
    const size = ico.readUInt8(entry) || 256;
    const png = ico.subarray(ico.readUInt32LE(entry + 12), ico.readUInt32LE(entry + 12) + ico.readUInt32LE(entry + 8));
    const idat: Buffer[] = [];
    for (let at = 8; at < png.length; ) {
      const length = png.readUInt32BE(at);
      if (png.toString("ascii", at + 4, at + 8) === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
      at += 12 + length;
    }
    const rows = inflateSync(Buffer.concat(idat));
    const rgba = Buffer.alloc(size * size * 4);
    // renderIco writes every row unfiltered (filter byte 0).
    for (let y = 0; y < size; y++) rows.copy(rgba, y * size * 4, y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1));
    return { size, rgba };
  });
}

/** Whether `ico` holds exactly the images renderIco draws. */
export function icoMatches(ico: Buffer): boolean {
  const images = decodeIco(ico);
  return images.length === ICON_SIZES.length && images.every((image, index) => image.size === ICON_SIZES[index] && image.rgba.equals(drawIcon(image.size)));
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    let differs = false;
    for (const [file, matches] of [
      [ICON_FILE, icoMatches],
      [ICNS_FILE, icnsMatches],
    ] as const) {
      if (!matches(readFileSync(file))) {
        console.error(`${file} differs from what scripts/render-app-icon.mts draws. Run it to rewrite the file.`);
        differs = true;
      }
    }
    if (differs) process.exit(1);
    console.log("Both icons match.");
  } else {
    const ico = renderIco();
    writeFileSync(ICON_FILE, ico);
    console.log(`Wrote ${ICON_FILE} (${ico.length} bytes, sizes ${ICON_SIZES.join(", ")}).`);
    const icns = renderIcns();
    writeFileSync(ICNS_FILE, icns);
    console.log(`Wrote ${ICNS_FILE} (${icns.length} bytes, sizes ${[...new Set(ICNS_IMAGES.map((image) => image.size))].join(", ")}).`);
  }
}
