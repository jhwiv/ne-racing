'use strict';

// v2.21.8 — Version sync contract.
//
// Locks the invariant that the baked-in app-shell constants in index.html
// match version.json exactly, so the on-load version poller does not
// trigger a reload loop between two mismatched version strings.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const VERSION_JSON = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')
);

function extractConstant(name) {
  const re = new RegExp(
    'var\\s+' + name + "\\s*=\\s*['\"]([^'\"]+)['\"]"
  );
  const m = INDEX.match(re);
  assert.ok(m, 'expected ' + name + ' assignment in index.html');
  return m[1];
}

test('version.json has a `version` field', function() {
  assert.equal(typeof VERSION_JSON.version, 'string');
  assert.ok(VERSION_JSON.version.length > 0);
});

test('NE_APP_VERSION in index.html matches version.json exactly', function() {
  const baked = extractConstant('NE_APP_VERSION');
  assert.equal(
    baked,
    VERSION_JSON.version,
    'NE_APP_VERSION (' + baked + ') must equal version.json version (' +
      VERSION_JSON.version + ') or the on-load poller will reload forever'
  );
});

test('RAILBIRD_VERSION in index.html is present and non-empty', function() {
  const tag = extractConstant('RAILBIRD_VERSION');
  assert.ok(tag.length > 0);
});

test('no stale v2.21.6 / v2.21.7 active build constant remains', function() {
  const ne = extractConstant('NE_APP_VERSION');
  const rb = extractConstant('RAILBIRD_VERSION');
  for (const stale of ['v2.21.6', 'v2.21.7']) {
    assert.ok(
      !ne.includes(stale),
      'NE_APP_VERSION still contains stale ' + stale + ': ' + ne
    );
    assert.ok(
      !rb.includes(stale),
      'RAILBIRD_VERSION still contains stale ' + stale + ': ' + rb
    );
  }
});

test('RAILBIRD_VERSION tracks the same semver as NE_APP_VERSION', function() {
  const ne = extractConstant('NE_APP_VERSION');
  const rb = extractConstant('RAILBIRD_VERSION');
  const semverRe = /v\d+\.\d+\.\d+/;
  const neSem = ne.match(semverRe);
  const rbSem = rb.match(semverRe);
  assert.ok(neSem, 'NE_APP_VERSION must contain a vX.Y.Z semver');
  assert.ok(rbSem, 'RAILBIRD_VERSION must contain a vX.Y.Z semver');
  assert.equal(neSem[0], rbSem[0]);
});
