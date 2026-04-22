// sample_saratoga_adapter.js — reads the hand-curated SAR 2025 sample fixtures.
// This is the ONLY data adapter that is default-ON, because it doesn't hit the
// network, doesn't violate any ToS, and is labeled `sample_manual_review` so
// the data never flows into training output.

'use strict';

const fs = require('fs');
const path = require('path');
const { AdapterBase } = require('./adapter_base');

const FIXTURE_PATH = path.join(__dirname, '..', '..', 'data', 'fixtures', 'saratoga_2025_sample.json');

class SampleSaratogaAdapter extends AdapterBase {
  constructor(opts) {
    super(Object.assign({
      id: 'sample_manual',
      name: 'Hand-curated Saratoga 2025 sample',
      sourceUrl: 'internal:data/fixtures/saratoga_2025_sample.json',
      licenseTier: 'sample_manual_review',
      licenseNotes: 'Small hand-curated sample of publicly known 2025 SAR races. For UI dev only. NOT training-eligible.',
      trainingEligible: false,
      displayEligible: true,
      enabled: true,
    }, opts || {}));
  }

  _load() {
    if (this._cache) return this._cache;
    const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
    this._cache = JSON.parse(raw);
    return this._cache;
  }

  async fetchMeet(_year, trackCode) {
    if (trackCode !== 'SAR') return null;
    const doc = this._load();
    return Object.assign({}, doc.meet, { source_provenance: this.provenanceEnvelope(doc.meet) });
  }

  async fetchCard(dateStr, trackCode) {
    if (trackCode !== 'SAR') return [];
    const doc = this._load();
    const prov = this.provenanceEnvelope(null);
    return (doc.races || [])
      .filter(r => r.date === dateStr)
      .map(r => Object.assign({}, r, { source_provenance: prov }));
  }

  async fetchResults(dateStr, trackCode) {
    if (trackCode !== 'SAR') return [];
    const doc = this._load();
    const prov = this.provenanceEnvelope(null);
    return (doc.races || [])
      .filter(r => r.date === dateStr && r.results)
      .map(r => Object.assign({}, r, { source_provenance: prov }));
  }
}

module.exports = { SampleSaratogaAdapter };
