// unofficial_nyra_adapter.js — the old NYRA.com scraper, kept as reference ONLY.
//
// Status: DISABLED. Do not re-enable without a written data agreement with NYRA.
// The existing scraper lives at scripts/build-entries.js. That script is also
// no longer run by CI in this branch (cron scheduling removed, workflow_dispatch
// only). Any records this adapter would produce are license_tier: "red" and
// training_eligible: false — they would never enter a training output anyway.

'use strict';

const { AdapterBase } = require('./adapter_base');

class UnofficialNyraAdapter extends AdapterBase {
  constructor(opts) {
    super(Object.assign({
      id: 'unofficial_nyra',
      name: 'Unofficial NYRA scraper (DISABLED)',
      sourceUrl: 'https://www.nyra.com',
      licenseTier: 'red',
      licenseNotes: 'NYRA.com ToS almost certainly prohibits automated access. Do not enable.',
      trainingEligible: false,
      displayEligible: false,
      enabled: false,
    }, opts || {}));
  }

  _refuse() {
    throw new Error('unofficial_nyra_adapter is DISABLED by policy. See docs/DATA_WISHLIST.md.');
  }

  async fetchMeet() { this._refuse(); }
  async fetchCard() { this._refuse(); }
  async fetchResults() { this._refuse(); }
  async fetchWorks() { this._refuse(); }
}

module.exports = { UnofficialNyraAdapter };
