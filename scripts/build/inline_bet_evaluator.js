#!/usr/bin/env node
/**
 * inline_bet_evaluator.js — Generates a browser-compatible IIFE bundle from
 * scripts/lib/bet_evaluator.js for inclusion in index.html.
 *
 * Same pattern as inline_scoring.js: the PWA has no module loader, so the
 * evaluator must live as a <script> block inside index.html. This tool
 * produces that block from the canonical Node module so the live PWA and
 * the test/backtest harness always run identical evaluator code.
 *
 * Usage:
 *   node scripts/build/inline_bet_evaluator.js
 *
 * Output:
 *   scripts/build/_inlined_bet_evaluator.js   (the IIFE block)
 *   index.html is auto-updated between markers.
 *
 * Verify drift between source and inlined block:
 *   node scripts/build/inline_bet_evaluator.js --check
 *   (exit code 1 if index.html block is out of date)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT       = path.resolve(__dirname, '..', '..');
const SOURCE     = path.join(ROOT, 'scripts', 'lib', 'bet_evaluator.js');
const OUT        = path.join(ROOT, 'scripts', 'build', '_inlined_bet_evaluator.js');
const INDEX_HTML = path.join(ROOT, 'index.html');

const BEGIN_MARKER = '/* RAILBIRD_BET_EVALUATOR_INLINE_BEGIN */';
const END_MARKER   = '/* RAILBIRD_BET_EVALUATOR_INLINE_END */';

function generate() {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const lines = src.split('\n');
  const exportsStart = lines.findIndex((l) => l.startsWith('module.exports'));
  if (exportsStart === -1) {
    throw new Error('Could not find module.exports in bet_evaluator.js');
  }
  // Drop "use strict" header (if present) and everything from module.exports onward.
  let bodyStart = 0;
  if (lines[0] && /^['"]use strict['"]/.test(lines[0].trim())) bodyStart = 1;
  const body = lines.slice(bodyStart, exportsStart).join('\n').replace(/\s+$/, '');
  const exportBlock = lines.slice(exportsStart).join('\n');
  const names = Array.from(
    exportBlock.matchAll(/^\s*(\w+),?\s*(?:\/\/.*)?$/gm)
  ).map((m) => m[1]).filter((n) => n !== 'module' && n !== 'exports');

  const out = [
    BEGIN_MARKER,
    '/* RailbirdBetEvaluator — inlined from scripts/lib/bet_evaluator.js',
    ' * DO NOT EDIT THIS BLOCK BY HAND. Regenerate with:',
    ' *   node scripts/build/inline_bet_evaluator.js',
    ' */',
    '(function(global) {',
    '  "use strict";',
    body,
    '  global.RailbirdBetEvaluator = {',
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
      console.error('index.html does not contain a RailbirdBetEvaluator inline block.');
      process.exit(1);
    }
    const existing = html.slice(i, j + END_MARKER.length);
    if (existing.trim() !== block.trim()) {
      console.error('Inlined block in index.html is out of date with scripts/lib/bet_evaluator.js.');
      console.error('Run: node scripts/build/inline_bet_evaluator.js');
      process.exit(1);
    }
    console.log('OK — index.html bet-evaluator block matches scripts/lib/bet_evaluator.js.');
    return;
  }

  fs.writeFileSync(OUT, block);
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${block.length} bytes)`);

  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const i = html.indexOf(BEGIN_MARKER);
  const j = html.indexOf(END_MARKER);
  if (i !== -1 && j !== -1) {
    const updated = html.slice(0, i) + block + html.slice(j + END_MARKER.length);
    if (updated !== html) {
      fs.writeFileSync(INDEX_HTML, updated);
      console.log('Updated index.html bet-evaluator block in place.');
    } else {
      console.log('index.html bet-evaluator block already current.');
    }
  } else {
    console.log('No bet-evaluator block in index.html yet — insert markers first.');
  }
}

main();
