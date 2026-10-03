// GitHub contribution heatmap for AWTRIX NG.
//
// GET /?user=<github_username>[&rainbow=0][&split=1][&avatar=1]
//
// Returns a flat JSON array of 256 packed 0xRRGGBB integers (32x8, row-major)
// ready for the Berry app to paint pixel-by-pixel.
//
// The worker holds no state between requests.  Caching is left to the caller
// (the Berry app fetches at most once per configured interval).

import { decode as decodeJpegLib } from "jpeg-js";
import UPNG from "upng-js";

const GITHUB_GRAPHQL = "https://api.github.com/graphql";

const LEVEL_COLORS = [
  0x161b22, // level 0 – no contributions (GitHub dark bg)
  0x0e4429, // level 1
  0x006d32, // level 2
  0x26a641, // level 3
  0x39d353, // level 4
];

const LEVEL_MAP = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

const PANEL_W = 32;
const PANEL_H = 8;
const MONTH_MARKER = 0x666666;

export default {
  async fetch(request, env) {
    let out;
    try {
      out = await handle(request, env);
    } catch (err) {
      out = json(
        { error: "internal", detail: String(err && err.message) },
        500,
      );
    }
    return out;
  },
};

async function handle(request, env) {
  const q = new URL(request.url).searchParams;
  const user = request.headers.get("X-User") || q.get("user");
  const rainbow =
    (request.headers.get("X-Rainbow") || q.get("rainbow") || "1") !== "0";
  const split =
    (request.headers.get("X-Split") || q.get("split") || "0") === "1";
  const avatar =
    (request.headers.get("X-Avatar") || q.get("avatar") || "0") === "1";

  console.log("request", { user, avatar, rainbow, split });

  if (!user) return json({ error: "missing user" }, 400);

  // env.GITHUB_TOKEN: set via .dev.vars (local) or wrangler secret (deployed)
  const token = env && env.GITHUB_TOKEN;
  if (!token) return json({ error: "GITHUB_TOKEN not configured" }, 500);

  // --- fetch contribution data from GitHub -----------------------------------

  const query = `query($user: String!) {
    user(login: $user) {
      contributionsCollection {
        contributionCalendar {
          weeks {
            contributionDays {
              date
              contributionLevel
            }
          }
        }
      }
      avatarUrl
    }
  }`;

  const gh = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "awtrixng-github-heatmap-worker",
    },
    body: JSON.stringify({ query, variables: { user } }),
  });

  if (!gh.ok) {
    const text = await gh.text();
    return json(
      { error: "github api", status: gh.status, detail: text.slice(0, 200) },
      502,
    );
  }

  const data = await gh.json();
  const cal =
    data &&
    data.data &&
    data.data.user &&
    data.data.user.contributionsCollection &&
    data.data.user.contributionsCollection.contributionCalendar;

  if (!cal || !cal.weeks) {
    return json({ error: "unexpected github response" }, 502);
  }

  // --- flatten days ---------------------------------------------------------

  const days = [];
  for (const week of cal.weeks) {
    for (const d of week.contributionDays) {
      days.push({
        date: d.date,
        level: LEVEL_MAP[d.contributionLevel] ?? 0,
      });
    }
  }

  if (days.length === 0) {
    return json({ error: "no contribution data" }, 502);
  }

  const avatarUrl = data.data.user.avatarUrl || null;
  console.log("github response", {
    user,
    days: days.length,
    hasAvatarUrl: Boolean(avatarUrl),
  });
  let avatarPixels =
    avatar && avatarUrl ? await fetchAvatarPixels(avatarUrl) : null;
  console.log("avatar result", {
    requested: avatar,
    fetched: Boolean(avatarPixels),
    pixelCount: avatarPixels ? avatarPixels.length : 0,
  });
  return json(buildGrid(days, { rainbow, split, avatarPixels }));
}

// ---------------------------------------------------------------------------
// Pure computation — exported for testing.
// ---------------------------------------------------------------------------

// Rainbow months: each month's marker gets a fixed hue on the color wheel,
// so adjacent months are visually distinct at a glance.
export function monthHue(month) {
  return ((month - 1) / 12) * 360;
}

export function hsvToPacked(h, s, v) {
  s /= 100;
  v /= 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }
  return (
    (Math.round((r + m) * 255) << 16) |
    (Math.round((g + m) * 255) << 8) |
    Math.round((b + m) * 255)
  );
}

export function buildColumn(dayList, rainbow) {
  const col = new Array(PANEL_H).fill(0);
  let markerSet = false;
  for (const d of dayList) {
    const dt =
      typeof d.date === "string" ? new Date(d.date + "T00:00:00Z") : d.date;
    // row: Sun=1 Mon=2 ... Sat=7
    const row = dt.getUTCDay() + 1;
    if (row >= 1 && row < PANEL_H) {
      col[row] = LEVEL_COLORS[d.level] ?? LEVEL_COLORS[4];
    }
    if (!markerSet && dt.getUTCDate() === 1) {
      col[0] = rainbow
        ? hsvToPacked(monthHue(dt.getUTCMonth() + 1), 70, 70)
        : MONTH_MARKER;
      markerSet = true;
    }
  }
  return col;
}

export function buildGrid(
  days,
  { rainbow = true, split = false, avatarPixels = null } = {},
) {
  const lastDate = new Date(days[days.length - 1].date + "T00:00:00Z");
  const lastDow = lastDate.getUTCDay();
  const daysFromSat = (6 - lastDow + 7) % 7;
  const anchorDate = new Date(lastDate);
  anchorDate.setUTCDate(anchorDate.getUTCDate() + daysFromSat);

  // group days by week index (0 = most recent week, counting back)
  const weekMap = new Map();
  for (const d of days) {
    const dt = new Date(d.date + "T00:00:00Z");
    const diffDays = Math.round((anchorDate - dt) / 86400000);
    const weekIdx = Math.floor(diffDays / 7);
    if (!weekMap.has(weekIdx)) weekMap.set(weekIdx, []);
    weekMap.get(weekIdx).push({ date: dt, level: d.level });
  }

  const maxWeek = Math.max(...weekMap.keys());
  const columns = [];
  for (let wi = 0; wi <= maxWeek; wi++) {
    const daysInWeek = weekMap.get(wi);
    if (!daysInWeek || daysInWeek.length === 0) {
      columns.push(new Array(PANEL_H).fill(0));
      continue;
    }
    if (split) {
      // A week straddling a month boundary becomes one column per month,
      // newest first to match the right-to-left panel layout.
      const monthGroups = new Map();
      for (const d of daysInWeek) {
        const key = `${d.date.getUTCFullYear()}-${d.date.getUTCMonth()}`;
        if (!monthGroups.has(key)) monthGroups.set(key, []);
        monthGroups.get(key).push(d);
      }
      const groups = [...monthGroups.values()].sort(
        (a, b) =>
          Math.max(...b.map((d) => d.date.getTime())) -
          Math.max(...a.map((d) => d.date.getTime())),
      );
      for (const g of groups) columns.push(buildColumn(g, rainbow));
    } else {
      columns.push(buildColumn(daysInWeek, rainbow));
    }
  }

  // flatten to 256 pixels (row-major, right-aligned); the avatar, when
  // present, occupies the leftmost 8 columns, followed by one blank
  // separator column before the heatmap
  const leftOffset =
    avatarPixels && avatarPixels.length === PANEL_H * PANEL_H ? PANEL_H + 1 : 0;
  const pixels = new Array(PANEL_W * PANEL_H).fill(0);
  const colCount = Math.min(columns.length, PANEL_W - leftOffset);

  for (let c = 0; c < colCount; c++) {
    const targetCol = PANEL_W - 1 - c;
    const col = columns[c];
    for (let row = 0; row < PANEL_H; row++) {
      pixels[targetCol * PANEL_H + row] = col[row];
    }
  }

  if (leftOffset > 0) {
    // The panel index space is column-major (col*8+row, same as the heatmap),
    // while avatar pixels arrive row-major (y*8+x).  Writing them transposed
    // keeps the avatar upright; a direct copy drew it reflected across the
    // main diagonal, putting the top-right corner where the bottom-left
    // belongs and vice versa.
    for (let y = 0; y < PANEL_H; y++) {
      for (let x = 0; x < PANEL_H; x++) {
        pixels[x * PANEL_H + y] = avatarPixels[y * PANEL_H + x];
      }
    }
  }

  return pixels;
}

async function fetchAvatarPixels(url) {
  const sized = new URL(url);
  sized.searchParams.set("s", "8");
  const response = await fetch(sized, {
    headers: { "User-Agent": "awtrixng-github-heatmap-worker" },
  });
  const contentType = response.headers.get("content-type");
  console.log("avatar fetch", {
    status: response.status,
    ok: response.ok,
    contentType,
  });
  if (!response.ok) return null;
  const body = await response.arrayBuffer();
  console.log("avatar body", { bytes: body.byteLength });
  try {
    const bytes = new Uint8Array(body);
    const pixels =
      bytes[0] === 0x89 && bytes[1] === 0x50
        ? decodePng(bytes)
        : bytes[0] === 0xff && bytes[1] === 0xd8
          ? decodeJpeg(bytes)
          : (() => {
              throw new Error("unsupported avatar format");
            })();
    console.log("avatar decode ok", { pixelCount: pixels.length });
    return pixels;
  } catch (err) {
    console.error("avatar decode failed", {
      error: String(err && err.message),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Avatar decoding — jpeg-js and upng-js do the heavy lifting.  Both are pure
// JS with no dependencies and no node builtins, so they bundle cleanly for the
// Worker.  (pngjs was considered but its sync path requires node:zlib, i.e.
// the nodejs_compat flag; upng-js ships its own inflate.)
// ---------------------------------------------------------------------------

export function decodePng(buffer) {
  const img = UPNG.decode(new Uint8Array(buffer));
  const rgba = new Uint8Array(UPNG.toRGBA8(img)[0]);
  return packRgba(downscale(rgba, img.width, img.height));
}

export function decodeJpeg(buffer) {
  const { width, height, data } = decodeJpegLib(new Uint8Array(buffer), {
    formatAsRGBA: true,
  });
  return packRgba(downscale(data, width, height));
}

// Most avatars arrive already 8x8 (GitHub honors ?s=8 for user-uploaded
// photos), but auto-generated identicons ignore the size param and always
// come back 420x420.  Box-average whatever we get down to 8x8; for an 8x8
// source this is the identity (one pixel per cell) so the verified path is
// unchanged.
function downscale(rgba, w, h) {
  const out = new Uint8Array(64 * 4);
  for (let y = 0; y < 8; y++) {
    const y0 = Math.floor((y * h) / 8);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / 8));
    for (let x = 0; x < 8; x++) {
      const x0 = Math.floor((x * w) / 8);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / 8));
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * w + xx) * 4;
          r += rgba[o];
          g += rgba[o + 1];
          b += rgba[o + 2];
          n++;
        }
      }
      const o = (y * 8 + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

// Pack a 64-pixel RGBA buffer into 256 packed 0xRRGGBB values (row-major).
function packRgba(rgba) {
  const pixels = new Array(64);
  for (let i = 0; i < 64; i++) {
    const o = i * 4;
    pixels[i] = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
  }
  return pixels;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
