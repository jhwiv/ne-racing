// adapter_base.js — common interface every ingestion adapter must implement.
// An adapter is a data-source client that returns records conforming to
// data/schema/*.json. The central ingester (scripts/ingest/run.js) calls
// these methods and writes normalized output to data/normalized/...

'use strict';

const crypto = require('crypto');

class AdapterBase {
  constructor(opts) {
    opts = opts || {};
    this.id = opts.id || 'unknown';
    this.name = opts.name || 'Unknown Adapter';
    this.sourceUrl = opts.sourceUrl || '';
    this.licenseTier = opts.licenseTier || 'unknown';
    this.licenseNotes = opts.licenseNotes || '';
    this.trainingEligible = opts.trainingEligible === true;
    this.displayEligible = opts.displayEligible === true;
    this.enabled = opts.enabled === true; // default off
  }

  provenanceEnvelope(rawPayload) {
    return {
      source_id: this.id,
      source_name: this.name,
      source_url: this.sourceUrl,
      license_tier: this.licenseTier,
      license_notes: this.licenseNotes,
      training_eligible: this.trainingEligible,
      display_eligible: this.displayEligible,
      fetched_at: new Date().toISOString(),
      confidence: 1,
      raw_payload_hash: rawPayload != null ? this._hash(rawPayload) : undefined,
    };
  }

  _hash(v) {
    try {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return crypto.createHash('sha256').update(s).digest('hex');
    } catch (_e) {
      return undefined;
    }
  }

  // Interface — override in subclasses.
  async fetchMeet(_year, _trackCode) { throw new Error(this.id + ': fetchMeet not implemented'); }
  async fetchCard(_dateStr, _trackCode) { throw new Error(this.id + ': fetchCard not implemented'); }
  async fetchResults(_dateStr, _trackCode) { throw new Error(this.id + ': fetchResults not implemented'); }
  async fetchWorks(_range, _trackCode) { throw new Error(this.id + ': fetchWorks not implemented'); }
}

module.exports = { AdapterBase };
