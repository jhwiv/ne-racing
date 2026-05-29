#!/usr/bin/env node
/**
 * inline_scoring.js — Generates a browser-compatible IIFE bundle from
 * scripts/lib/scoring.js for inclusion in index.html.
 *
 * The PWA is a single-file HTML app (no module loader), so the scoring engine
 * has to live as a <script> block inside index.html. This tool produces that
 * block from the canonical Node module so the live PWA and the offline backtest
 * always run identical scoring code.
 *
 * Usage:
 *   node scripts/build/inline_scoring.js
 *
 * Output:
 *   scripts/build/_inlined_scoring.js  (the IIFE block — copy into index.html)
 *
 * Verify drift between source and inlined block:
 *   node scripts/build/inline_scoring.js --check
 *   (exit code 1 if index.html block is out of date)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT       = path.resolve(__dirname, '..', '..');
const SOURCE     = path.join(ROOT, 'scripts', 'lib', 'scoring.js');
const OUT        = path.join(ROOT, 'scripts', 'build', '_inlined_scoring.js');
const INDEX_HTML = path.join(ROOT, 'index.html');

const BEGIN_MARKER = '/* RAILBIRD_SCORING_INLINE_BEGIN */';
const END_MARKER   = '/* RAILBIRD_SCORING_INLINE_END */';

function generate() {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const lines = src.split('\n');
  const exportsStart = lines.findIndex((l) => l.startsWith('module.exports'));
  if (exportsStart === -1) {
    throw new Error('Could not find module.exports in scoring.js');
  }
  // Drop "use strict" header and everything from module.exports onward.
  const body = lines.slice(1, exportsStart).join('\n').replace(/\s+$/, '');
  const exportBlock = lines.slice(exportsStart).join('\n');
  const names = Array.from(
    exportBlock.matchAll(/^\s*(\w+),?\s*(?:\/\/.*)?$/gm)
  ).map((m) => m[1]).filter((n) => n !== 'module' && n !== 'exports');

  const out = [
    BEGIN_MARKER,
    '/* RailbirdScoring — inlined from scripts/lib/scoring.js',
    ' * DO NOT EDIT THIS BLOCK BY HAND. Regenerate with:',
    ' *   node scripts/build/inline_scoring.js',
    ' */',
    '(function(global) {',
    '  "use strict";',
    body,
    '  global.RailbirdScoring = {',
    ...names.map((n) => `    ${n}: ${n},`),
    '  };',
    '})(typeof window !== "undefined" ? window : globalThis);',
    END_MARKER,
    '',
  ].join('\n');
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const block = generate();

  if (args.includes('--check')) {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const i = html.indexOf(BEGIN_MARKER);
    const j = html.indexOf(END_MARKER);
    if (i === -1 || j === -1) {
      console.error('index.html does not contain a RailbirdScoring inline block.');
      process.exit(1);
    }
    const existing = html.slice(i, j + END_MARKER.length);
    if (existing.trim() !== block.trim()) {
      console.error('Inlined block in index.html is out of date with scripts/lib/scoring.js.');
      console.error('Run: node scripts/build/inline_scoring.js');
      process.exit(1);
    }
    console.log('OK — index.html scoring block matches scripts/lib/scoring.js.');
    return;
  }

  fs.writeFileSync(OUT, block);
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${block.length} bytes)`);

  // Auto-update index.html if it contains the markers.
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const i = html.indexOf(BEGIN_MARKER);
  const j = html.indexOf(END_MARKER);
  if (i !== -1 && j !== -1) {
    const updated = html.slice(0, i) + block + html.slice(j + END_MARKER.length);
    if (updated !== html) {
      fs.writeFileSync(INDEX_HTML, updated);
      console.log('Updated index.html scoring block in place.');
    } else {
      console.log('index.html scoring block already current.');
    }
  } else {
    console.log('No scoring block in index.html yet — insert it manually using the markers.');
  }
}

main();
