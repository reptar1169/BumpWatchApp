// ---------------------------------------------------------------------------
// Share cards for the top-5 "priority stretches" list
// ---------------------------------------------------------------------------
// Facebook and X don't run JavaScript when they unfurl a link -- they just
// read static <meta property="og:..."> tags from whatever HTML the server
// returns for that exact URL. The main site is a client-rendered SPA (see
// web/bikelanebumps-site/app.js), so every URL on it serves the same
// generic tags no matter what's in the hash/query string. This module is
// what makes a per-stretch share URL actually carry per-stretch text and
// image: index.js's shareCard function serves this module's output at
// /share/<metroSlug>/<mode>/<rank>[/image.png], a real person gets bounced
// straight into the main site with a `?highlight=` param (see app.js's
// applyHighlightFromUrl), and a crawler just reads the tags/image and
// never runs the redirect at all.
//
// Nothing here queries Firestore itself -- index.js passes in the same
// `metros` array the main site already reads from topStretches/current,
// so this stays a pure "given the data, build the response" module, same
// split as topStretchesCore.js.

const path = require("path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

const FONT_DIR = path.join(__dirname, "assets", "fonts");
let fontsRegistered = false;
function ensureFontsRegistered() {
  // Cloud Functions reuses warm instances across invocations -- registering
  // twice on the same instance is harmless but pointless work, so guard it.
  if (fontsRegistered) return;
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "BigShoulders-Bold.ttf"), "Big Shoulders Bold");
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "WorkSans-Regular.ttf"), "Work Sans");
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "WorkSans-Bold.ttf"), "Work Sans Bold");
  fontsRegistered = true;
}

// Copied from web/bikelanebumps-site/styles.css's :root custom properties --
// keep in sync by hand if the site's palette ever changes, same as the
// other constants this codebase duplicates across the client/server split
// (see RECENCY_WINDOW_DAYS's comment in topStretchesCore.js for why that's
// an accepted tradeoff here rather than a shared config file).
const COLORS = {
  pageBg: "#141311",
  surface2: "#262219",
  textPrimary: "#f7f4ec",
  textSecondary: "#b8b1a1",
  textMuted: "#837c6d",
  heat400: "#ffab3d",
  heat700: "#b0141c",
};

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630; // standard OG image size -- what FB/X/etc. expect

// ---- Slugging ----
// Must produce IDENTICAL output to web/bikelanebumps-site/app.js's own
// metroSlug -- the client builds share URLs with it, this module resolves
// those same URLs back to a metro with it. There's no shared module
// between the client bundle and the Functions runtime, so this is
// duplicated by hand; if you change one, change both.
function metroSlug(name) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents (e.g. "Boulder, CO" is unaffected; covers names with diacritics)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Given the same `metros` array the site reads from topStretches/current,
// finds the one stretch a /share/<metroSlug>/<mode>/<rank> URL refers to.
// Returns null for anything that doesn't resolve -- a stale link to a
// metro/rank that no longer exists after a recompute, a typo'd URL, etc.
// -- so the caller can fall back to a generic (still valid) share page
// rather than erroring.
function findShareTarget(metros, metroSlugParam, mode, rankParam) {
  if (mode !== "weighted" && mode !== "unweighted") return null;
  const rank = Number(rankParam);
  if (!Number.isInteger(rank) || rank < 1) return null;
  const metro = metros.find((m) => metroSlug(m.name) === metroSlugParam);
  if (!metro) return null;
  const stretch = (metro[mode] ?? [])[rank - 1];
  if (!stretch) return null;
  return { metro, stretch, rank, mode };
}

// ---- Text layout helpers ----

// Breaks on spaces AND hyphens (keeping the hyphen with the piece before
// it) -- plain space-only wrapping fails on real metro names like
// "San Francisco-Oakland-Berkeley, CA", which is one space-free run from
// "Francisco-Oakland-Berkeley," onward and would otherwise just run off
// the card with nowhere to break.
function tokenize(text) {
  const tokens = [];
  for (const word of text.split(" ")) {
    const parts = word.split(/(?<=-)/); // split after each hyphen, keep it
    parts.forEach((part, i) => tokens.push({ text: part, spaceBefore: i === 0 }));
  }
  return tokens;
}

function wrapText(ctx, text, maxWidth) {
  const tokens = tokenize(text);
  const lines = [];
  let line = "";
  for (const token of tokens) {
    const joiner = token.spaceBefore && line ? " " : "";
    const test = line + joiner + token.text;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = token.text;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Finds the largest font size (in steps down from maxSize) at which `text`
// wraps into at most maxLines lines that all fit maxWidth. Falls back to
// truncating the last line with an ellipsis at minSize if even that
// doesn't fit -- a real metro/stretch name should never be dropped
// silently, but it also can't be allowed to run off a fixed-size card.
// (Verified against a deliberately absurd 120-character stretch name and
// a real multi-hyphen metro name -- "San Francisco-Oakland-Berkeley, CA"
// -- during development; see the PR/commit this shipped in.)
function fitWrappedText(ctx, text, { fontWeight, fontFamily, maxWidth, maxSize, minSize, step, maxLines }) {
  for (let size = maxSize; size >= minSize; size -= step) {
    ctx.font = `${fontWeight} ${size}px '${fontFamily}'`;
    const lines = wrapText(ctx, text, maxWidth);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxWidth)) {
      return { size, lines };
    }
  }
  ctx.font = `${fontWeight} ${minSize}px '${fontFamily}'`;
  const lines = wrapText(ctx, text, maxWidth).slice(0, maxLines);
  let lastLine = lines[maxLines - 1] ?? "";
  while (lastLine.length > 1 && ctx.measureText(`${lastLine}…`).width > maxWidth) {
    lastLine = lastLine.slice(0, -1);
  }
  lines[maxLines - 1] = `${lastLine}…`;
  return { size: minSize, lines };
}

// Renders the actual PNG shown in the FB/X card. Pure function of its
// inputs (no I/O) so it's easy to preview/test standalone -- see
// functions/scripts/preview-share-card.js.
function renderShareImage({ rank, metroName, stretchName, bumpCount, avgSeverityG }) {
  ensureFontsRegistered();

  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = COLORS.pageBg;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // Subtle warm glow behind the rank number -- purely decorative, ties the
  // card to the site's heat-severity color language without competing
  // with the text on top of it.
  const glow = ctx.createRadialGradient(260, 300, 40, 260, 300, 520);
  glow.addColorStop(0, "rgba(255, 111, 60, 0.22)");
  glow.addColorStop(1, "rgba(255, 111, 60, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  const padX = 72;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // Kicker wordmark, manually letter-spaced (Canvas has no letter-spacing
  // property until a newer spec lands in whatever engine napi-rs/canvas
  // tracks -- drawing char-by-char is the simple, portable way to get it).
  ctx.font = "700 26px 'Work Sans Bold'";
  ctx.fillStyle = COLORS.textMuted;
  {
    const label = "BIKELANEBUMPS.ORG";
    let x = padX;
    for (const ch of label) {
      ctx.fillText(ch, x, 76);
      x += ctx.measureText(ch).width + 3;
    }
  }

  // Huge rank number, heat-gradient fill.
  const rankText = `#${rank}`;
  ctx.font = "700 260px 'Big Shoulders Bold'";
  const rankGradient = ctx.createLinearGradient(padX, 150, padX, 400);
  rankGradient.addColorStop(0, COLORS.heat400);
  rankGradient.addColorStop(1, COLORS.heat700);
  ctx.fillStyle = rankGradient;
  ctx.fillText(rankText, padX - 10, 360);
  const rankWidth = ctx.measureText(rankText).width;

  // "WORST BIKE LANE IN" + city name, to the right of the number.
  const textX = padX + rankWidth + 40;
  const maxTextWidth = CARD_WIDTH - textX - padX;

  const labelY = 175;
  ctx.font = "700 40px 'Big Shoulders Bold'";
  ctx.fillStyle = COLORS.textSecondary;
  ctx.fillText("WORST BIKE LANE IN", textX, labelY);

  ctx.fillStyle = COLORS.textPrimary;
  const cityFit = fitWrappedText(ctx, metroName.toUpperCase(), {
    fontWeight: 700,
    fontFamily: "Big Shoulders Bold",
    maxWidth: maxTextWidth,
    maxSize: 72,
    minSize: 40,
    step: 4,
    maxLines: 2,
  });
  ctx.font = `700 ${cityFit.size}px 'Big Shoulders Bold'`;
  // One font-size worth of gap from the label's own baseline clears its
  // cap-height reliably across the whole min/max size range above --
  // a fixed offset looked fine at 72px but let a 2-line city name (from a
  // long, multi-hyphen metro label) climb back up into the label once
  // fitWrappedText dropped to a smaller size for it.
  let cy = labelY + cityFit.size;
  const lineHeight = cityFit.size * 1.08;
  for (const line of cityFit.lines) {
    ctx.fillText(line, textX, cy);
    cy += lineHeight;
  }

  // Bottom chip: stretch name + stats.
  const chipY = CARD_HEIGHT - 168;
  const chipH = 96;
  const chipR = 16;
  const chipX = padX;
  const chipW = CARD_WIDTH - padX * 2;
  ctx.fillStyle = COLORS.surface2;
  ctx.beginPath();
  ctx.moveTo(chipX + chipR, chipY);
  ctx.arcTo(chipX + chipW, chipY, chipX + chipW, chipY + chipH, chipR);
  ctx.arcTo(chipX + chipW, chipY + chipH, chipX, chipY + chipH, chipR);
  ctx.arcTo(chipX, chipY + chipH, chipX, chipY, chipR);
  ctx.arcTo(chipX, chipY, chipX + chipW, chipY, chipR);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = COLORS.textPrimary;
  const nameFit = fitWrappedText(ctx, stretchName, {
    fontWeight: 600,
    fontFamily: "Work Sans Bold",
    maxWidth: chipW - 48,
    maxSize: 30,
    minSize: 20,
    step: 2,
    maxLines: 1,
  });
  ctx.font = `600 ${nameFit.size}px 'Work Sans Bold'`;
  ctx.fillText(nameFit.lines[0], chipX + 24, chipY + 40);

  ctx.font = "400 24px 'Work Sans'";
  ctx.fillStyle = COLORS.textSecondary;
  ctx.fillText(
    `${bumpCount} bumps recorded  ·  avg severity ${avgSeverityG.toFixed(2)}g`,
    chipX + 24,
    chipY + 74
  );

  ctx.font = "400 22px 'Work Sans'";
  ctx.fillStyle = COLORS.textMuted;
  ctx.textAlign = "right";
  ctx.fillText("See it on the live map →", CARD_WIDTH - padX, CARD_HEIGHT - 40);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The actual page served at /share/<metroSlug>/<mode>/<rank>. Crawlers
// (Facebook/X/etc.) read the <meta> tags and the linked image and never
// execute the redirect below; a real visitor's browser runs the redirect
// immediately and lands on the main site with the right stretch already
// highlighted (see app.js's applyHighlightFromUrl). The meta-refresh is a
// belt-and-suspenders fallback for the rare browser with JS disabled.
function buildSharePageHtml({ siteOrigin, metroSlugParam, mode, rank, metro, stretch }) {
  const title = `#${rank} Worst Bike Lane in ${metro.name}`;
  const description = `${stretch.name} — ${stretch.bumpCount} bumps recorded, avg severity ${stretch.avgSeverityG.toFixed(2)}g. See it on the live BumpWatch map.`;
  const shareUrl = `${siteOrigin}/share/${metroSlugParam}/${mode}/${rank}`;
  const imageUrl = `${shareUrl}/image.png`;
  const targetUrl = `${siteOrigin}/?highlight=${encodeURIComponent(metroSlugParam)}:${mode}:${rank}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(imageUrl)}">
<meta property="og:image:width" content="${CARD_WIDTH}">
<meta property="og:image:height" content="${CARD_HEIGHT}">
<meta property="og:url" content="${escapeHtml(shareUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(imageUrl)}">
<meta http-equiv="refresh" content="0;url=${escapeHtml(targetUrl)}">
<script>window.location.replace(${JSON.stringify(targetUrl)});</script>
</head>
<body>
<p>Redirecting to <a href="${escapeHtml(targetUrl)}">bikelanebumps.org</a>&hellip;</p>
</body>
</html>`;
}

// Used both when a /share/... URL doesn't resolve to a real stretch (stale
// link after a recompute, typo, etc.) and as the target of a bare
// /share/<slug>/<mode>/<rank> request missing /image.png -- keeps every
// path through this function returning *something* valid rather than a
// bare error page with no way back into the site.
function buildFallbackPageHtml(siteOrigin) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>BumpWatch — Bike Lane Bumps</title>
<meta http-equiv="refresh" content="0;url=${escapeHtml(siteOrigin)}/">
<script>window.location.replace(${JSON.stringify(siteOrigin + "/")});</script>
</head>
<body>
<p>That share link has expired — <a href="${escapeHtml(siteOrigin)}/">see the current priority stretches</a>.</p>
</body>
</html>`;
}

module.exports = {
  metroSlug,
  findShareTarget,
  renderShareImage,
  buildSharePageHtml,
  buildFallbackPageHtml,
  CARD_WIDTH,
  CARD_HEIGHT,
};
