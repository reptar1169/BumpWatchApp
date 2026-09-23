#!/usr/bin/env node
// Standalone preview for shareCard.js's generated image -- run this after
// touching any layout/color code in shareCard.js rather than trusting it
// blind, since there's no automated visual test for a canvas render.
//
// Usage: node scripts/preview-share-card.js
// Writes ./share-card-preview.png -- open it to check the result.

const fs = require("fs");
const path = require("path");
const { renderShareImage } = require("../shareCard.js");

const SAMPLES = [
  { rank: 3, metroName: "Chicago, IL", stretchName: "Milwaukee Ave between Damen and North", bumpCount: 42, avgSeverityG: 1.83 },
  // A real, genuinely long/hyphenated metro label -- the case that broke
  // naive space-only text wrapping during development.
  { rank: 1, metroName: "San Francisco-Oakland-Berkeley, CA", stretchName: "Martin Luther King Jr. Way between Alcatraz Ave and Woolsey St", bumpCount: 187, avgSeverityG: 2.4 },
];

for (const [i, sample] of SAMPLES.entries()) {
  const buf = renderShareImage(sample);
  const outPath = path.join(__dirname, "..", `share-card-preview-${i + 1}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`wrote ${outPath}`);
}
