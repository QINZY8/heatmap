// Offline tests for the pure computation functions.  Run with `node test.mjs`
// (after `npm install` — the avatar decoders bring jpeg-js and upng-js).
//
// Imports directly from src/index.js — no drift risk.
//
// What is NOT covered here (needs a live GitHub token + wrangler dev):
//   - The GraphQL fetch and error paths
//   - Real contribution data → grid correctness

import UPNG from "upng-js";

const mod = await import(new URL("./src/index.js", import.meta.url));
const { monthHue, hsvToPacked, buildColumn, buildGrid, decodeJpeg, decodePng } =
  mod;

let failed = 0;
function eq(name, got, want) {
  if (String(got) !== String(want)) {
    failed++;
    console.log(`  FAIL ${name}: got ${got}, want ${want}`);
  } else {
    console.log(`  ok   ${name}`);
  }
}

// --- monthHue --------------------------------------------------------------

console.log("monthHue");
eq("jan=0", monthHue(1), 0);
eq("apr=90", monthHue(4), 90);
eq("jul=180", monthHue(7), 180);
eq("oct=270", monthHue(10), 270);
eq("dec=330", monthHue(12), 330);

// --- hsvToPacked -----------------------------------------------------------

console.log("hsvToPacked");
eq("red", hsvToPacked(0, 100, 100), 0xff0000);
eq("green", hsvToPacked(120, 100, 100), 0x00ff00);
eq("blue", hsvToPacked(240, 100, 100), 0x0000ff);
eq("black", hsvToPacked(0, 0, 0), 0x000000);
eq("white", hsvToPacked(0, 0, 100), 0xffffff);

// --- buildColumn -----------------------------------------------------------

console.log("buildColumn");
// A single day at level 2 (2026-08-26 is a Wednesday → row 4)
const col1 = buildColumn([{ date: "2026-08-26", level: 2 }]);
eq("col length", col1.length, 8);
eq("row 0 empty", col1[0], 0);
eq("wednesday set", col1[4], 0x006d32);
eq("other row", col1[1], 0);

// Month marker: 2026-08-01 is a Saturday → row 7, marker at row 0, grey
const col2 = buildColumn([{ date: "2026-08-01", level: 1 }]);
eq("marker row 0", col2[0], 0x666666);
eq("saturday level kept", col2[7], 0x0e4429);

// Rainbow month marker: row 0 gets the month's hue instead of grey
const col3 = buildColumn([{ date: "2026-08-01", level: 1 }], true);
eq("rainbow marker row 0", col3[0] !== 0, true);
eq("rainbow marker is not grey", col3[0] !== 0x666666, true);
eq(
  "rainbow off is grey",
  buildColumn([{ date: "2026-08-01", level: 1 }], false)[0],
  0x666666,
);

// --- buildGrid -------------------------------------------------------------

console.log("buildGrid");
// Minimal: 7 days in one week
const days7 = [];
for (let i = 0; i < 7; i++) {
  const d = new Date("2026-08-20T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + i);
  days7.push({ date: d.toISOString().slice(0, 10), level: i % 5 });
}
const g7 = buildGrid(days7);
eq("grid length", g7.length, 256);
eq(
  "has pixels",
  g7.some((v) => v !== 0),
  true,
);

// The newest week is column 31, matching the legacy Python renderer.
const daysTwoWeeks = [
  { date: "2026-08-08", level: 1 },
  { date: "2026-08-10", level: 4 },
];
const gTwoWeeks = buildGrid(daysTwoWeeks);
eq("old week is left of newest", gTwoWeeks[30 * 8 + 7], 0x0e4429);
eq("newest week is rightmost", gTwoWeeks[31 * 8 + 2], 0x39d353);

// Full year: 365 days → should still produce 256 pixels
const days365 = [];
for (let i = 0; i < 365; i++) {
  const d = new Date("2025-08-27T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + i);
  days365.push({ date: d.toISOString().slice(0, 10), level: i % 5 });
}
const g365 = buildGrid(days365);
eq("365-day grid length", g365.length, 256);
eq(
  "365-day has pixels",
  g365.some((v) => v !== 0),
  true,
);

// Rainbow months: the painted 32 weeks span several month starts, so at
// least one pixel must be neither background, level green, nor grey marker
const isPalette = (v) =>
  v === 0 ||
  v === 0x666666 ||
  [0x161b22, 0x0e4429, 0x006d32, 0x26a641, 0x39d353].includes(v);
const g365r = buildGrid(days365, { rainbow: true });
eq("rainbow grid length", g365r.length, 256);
eq(
  "rainbow marker present",
  g365r.some((v) => !isPalette(v)),
  true,
);
eq(
  "rainbow off stays palette",
  buildGrid(days365, { rainbow: false }).every(isPalette),
  true,
);

// Split by month: 2026-08-31 is a Monday, 2026-09-01 a Tuesday — one week
// straddling a boundary. Without split both share the newest column; with
// split they become two columns, newest month rightmost.
const straddle = [
  { date: "2026-08-31", level: 1 },
  { date: "2026-09-01", level: 4 },
];
const gNoSplit = buildGrid(straddle, { split: false, rainbow: false });
eq(
  "no split: same column",
  [gNoSplit[31 * 8 + 2], gNoSplit[31 * 8 + 3]],
  [0x0e4429, 0x39d353],
);
const gSplitWeek = buildGrid(straddle, { split: true, rainbow: false });
eq("split: aug column left of sep", gSplitWeek[30 * 8 + 2], 0x0e4429);
eq("split: sep column rightmost", gSplitWeek[31 * 8 + 3], 0x39d353);
eq("split: aug day out of sep column", gSplitWeek[31 * 8 + 2], 0);
eq("split: sep day out of aug column", gSplitWeek[30 * 8 + 3], 0);
eq("split: sep marker in sep column", gSplitWeek[31 * 8 + 0], 0x666666);
eq("split: no marker in aug column", gSplitWeek[30 * 8 + 0], 0);

const gSplit = buildGrid(days365, { split: true });
eq("split grid length", gSplit.length, 256);
eq(
  "split has pixels",
  gSplit.some((v) => v !== 0),
  true,
);

// Avatar layout: a full 64-pixel avatar occupies the leftmost 8 columns,
// the next column is a blank separator, and the heatmap shrinks to the
// remaining 23
const avatar = new Array(64).fill(0x123456);
const gWithAvatar = buildGrid(days7, { avatarPixels: avatar });
eq("avatar occupies left 8 columns", gWithAvatar[7 * 8 + 7], 0x123456);
eq("avatar leaves heatmap on right", gWithAvatar[31 * 8 + 4], 0x0e4429);
eq("separator column is empty", gWithAvatar[8 * 8 + 4], 0);

// On a full year the separator is visible: column 9 (0-indexed 8) stays
// blank while the 23-week heatmap starts immediately right of it
const gAvGap = buildGrid(days365, { avatarPixels: avatar });
eq(
  "separator column stays blank",
  gAvGap.slice(8 * 8, 9 * 8).every((v) => v === 0),
  true,
);
eq(
  "heatmap starts right of separator",
  gAvGap.slice(9 * 8, 10 * 8).some((v) => v !== 0),
  true,
);

// Avatar orientation: pixels arrive row-major (y*8+x) but the panel index
// space is column-major (col*8+row).  Top-right source pixel (x=7,y=0) lands
// at output index 7*8+0, not 0*8+7 (which would draw it bottom-left).
const oAvatar = new Array(64).fill(0);
oAvatar[0 * 8 + 7] = 0x112233; // source top-right
oAvatar[7 * 8 + 0] = 0x445566; // source bottom-left
const gOriented = buildGrid(days7, { avatarPixels: oAvatar });
eq("top-right stays top-right", gOriented[7 * 8 + 0], 0x112233);
eq("bottom-left stays bottom-left", gOriented[0 * 8 + 7], 0x445566);
eq("no transpose leak", gOriented[0 * 8 + 0], 0);

// --- avatar decode regression (library-backed decoders) ----------------------
// Real GitHub avatar bytes inlined as base64 (torvalds8.jpg = 4:2:0 baseline,
// av8.bin = Golevka2001 PNG).  Expected pixels from magick (libjpeg).  The JPEG
// tolerance is per-channel <= 5: jpeg-js's float IDCT and libjpeg differ by a
// few LSBs on an 4:2:0 image even when both are correct.  PNG identity is exact.

const JPG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD//gA7Q1JFQVRPUjogZ2QtanBlZyB2MS4wICh1c2luZyBJSkcgSlBFRyB2NjIpLCBxdWFsaXR5ID0gOTAK/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSU1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8A5Hxn+yjeLBbJp2mSpaw6fPdT3OdvnZ+6GBOCBjIIHr68lFFcUFa52VbSa06I/9k=";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAA2ElEQVR4nADIADf/BIyc2gwFBwcFBAUEAvHty+nm1w8WOAcJFAQSCQsLCAIJBgX///bp8toFA/Hx6rr38/MEDAn/DwkIAQMB6OnTCg4HA/0F/QEBAP4HAgMC9NvQqrebUwcF9BshLAkPGBIYIBIRDwL8/PDr49AlN0IsOEgBBAohLDkyPkwMEBsC9ffsIztQ/gsX8e7p497bGRsZDw0NOURRBPr69/wC+c7Gwf38AObezdbPwWNugP4DBAL5+fn+//9LVWMZGx8DChgmLTzGwr77+voBAAD//6EqU9ags5poAAAAAElFTkSuQmCC";

const JPG_EXPECT = [
  3749161, 3550242, 4666154, 4204833, 4995630, 4735281, 3355686, 1843987,
  4669749, 4997688, 5915451, 7033419, 2429703, 3879459, 3882030, 2830882,
  5721924, 6444364, 9994617, 10257276, 5126703, 3352345, 5197120, 3159077,
  8353644, 8549483, 9862518, 8743523, 5652533, 5588796, 6775639, 4540217,
  9734784, 10523273, 11638415, 7953494, 6375489, 7759195, 8156778, 5066304,
  10392714, 11181203, 11703954, 9400940, 6375489, 9272434, 8880501, 6710359,
  11379867, 11641754, 13151400, 11177353, 11375757, 12298912, 12301737, 8486771,
  11445660, 14667977, 15389132, 13282729, 12955302, 14206909, 13419963, 9210494,
];

const PNG_EXPECT = [
  9215194, 10002913, 10462949, 10791655, 9803698, 8289673, 9278401, 9739477,
  10397157, 11120103, 11711468, 11645666, 9275788, 8618106, 8289659, 7696494,
  11185892, 12171247, 12237552, 10658741, 9934739, 9471615, 9275264, 8289141,
  11383000, 9734041, 7427395, 11118761, 11712703, 10065303, 10461088, 9473156,
  11119816, 8350313, 9866373, 14016753, 11779273, 12239312, 13753836, 10263711,
  10396596, 10659257, 9738140, 13029082, 9869988, 13884649, 14740217, 14016752,
  10001835, 10133421, 6446429, 9540508, 7827817, 7104869, 13621221, 13490921,
  9541284, 10002092, 11383488, 11185851, 8027009, 9606817, 9804195, 13161699,
];

function decodeB64(b64, fn) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return fn(bytes);
}

console.log("avatar decode");
{
  const got = decodeB64(JPG_B64, decodeJpeg);
  let maxDiff = 0;
  for (let i = 0; i < 64; i++) {
    const dr = Math.abs(
      ((got[i] >> 16) & 0xff) - ((JPG_EXPECT[i] >> 16) & 0xff),
    );
    const dg = Math.abs(((got[i] >> 8) & 0xff) - ((JPG_EXPECT[i] >> 8) & 0xff));
    const db = Math.abs((got[i] & 0xff) - (JPG_EXPECT[i] & 0xff));
    maxDiff = Math.max(maxDiff, dr, dg, db);
  }
  eq("jpeg-js decodes github 4:2:0 within 5 LSB/channel", maxDiff <= 5, true);
  eq("jpeg length", got.length, 64);
}
{
  const got = decodeB64(PNG_B64, decodePng);
  eq("png matches magick exactly", String(got), String(PNG_EXPECT));
}
{
  // Oversized avatar (GitHub identicons ignore ?s=8 and return 420x420):
  // build a 16x16 PNG (left half red, right half green) and expect the 8x8
  // box-average to keep each original 2x2 cell's color.  Real avatars are
  // truecolor, so forbidPlte keeps the encoder on the same ctype.
  const w = 16,
    h = 16;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (x < w / 2) {
        rgba[o] = 255;
      } else {
        rgba[o + 1] = 255;
      }
      rgba[o + 3] = 255;
    }
  }
  const png = new Uint8Array(UPNG.encode([rgba], w, h, 0, null, true));
  const got = decodePng(png);
  const row0 = got.slice(0, 8);
  eq(
    "identicon downscale is box-averaged",
    String(row0),
    String([
      0xff0000, 0xff0000, 0xff0000, 0xff0000, 0x00ff00, 0x00ff00, 0x00ff00,
      0x00ff00,
    ]),
  );
  eq("identicon all rows uniform", String(got.slice(8, 16)), String(row0));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
