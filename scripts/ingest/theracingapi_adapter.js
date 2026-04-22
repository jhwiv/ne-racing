// theracingapi_adapter.js — primary LICENSED path (default OFF until the user subscribes).
//
// Requires env: THERACINGAPI_USER, THERACINGAPI_PASS (basic auth).
// Requires North America add-on on the subscription for NYRA/Saratoga coverage.
// Docs: https://api.theracingapi.com/documentation
// ToS:  https://www.theracingapi.com/terms-of-service
//       -> permits "data analysis" + apps/websites
//       -> forbids resale of raw data
//       -> ML training not explicitly named — EMAIL support@theracingapi.com
//          FOR WRITTEN APPROVAL BEFORE flipping trainingEligible to true.

'use strict';

const { AdapterBase } = require('./adapter_base');

class TheRacingApiAdapter extends AdapterBase {
  constructor(opts) {
    super(Object.assign({
      id: 'theracingapi',
      name: 'The Racing API',
      sourceUrl: 'https://www.theracingapi.com',
      licenseTier: 'yellow',
      licenseNotes: 'ToS permits data analysis + apps/websites; resale forbidden; ML training pending written approval.',
      trainingEligible: false, // flip only after written approval on file
      displayEligible: true,
      enabled: false,          // flip only when subscription is paid and key is set
    }, opts || {}));
    this.user = (opts && opts.user) || process.env.THERACINGAPI_USER || '';
    this.pass = (opts && opts.pass) || process.env.THERACINGAPI_PASS || '';
    this.baseUrl = 'https://api.theracingapi.com/v1';
  }

  _assertReady() {
    if (!this.enabled) {
      throw new Error('theracingapi adapter is disabled. Set enabled=true and provide THERACINGAPI_USER/PASS.');
    }
    if (!this.user || !this.pass) {
      throw new Error('theracingapi adapter missing credentials (THERACINGAPI_USER / THERACINGAPI_PASS).');
    }
  }

  async _get(path, query) {
    this._assertReady();
    const qs = query ? ('?' + new URLSearchParams(query).toString()) : '';
    const auth = 'Basic ' + Buffer.from(this.user + ':' + this.pass).toString('base64');
    const res = await fetch(this.baseUrl + path + qs, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error('theracingapi ' + path + ' -> HTTP ' + res.status);
    return await res.json();
  }

  async fetchCard(dateStr, trackCode) {
    // Real implementation — wired up but NOT called until enabled=true.
    const data = await this._get('/racecards/pro', { date: dateStr });
    const prov = this.provenanceEnvelope(data);
    const races = (data.racecards || [])
      .filter(r => this._matchesTrack(r, trackCode))
      .map(r => this._normalizeCard(r, trackCode, dateStr, prov));
    return races;
  }

  async fetchResults(dateStr, trackCode) {
    const data = await this._get('/results', { date: dateStr });
    const prov = this.provenanceEnvelope(data);
    return (data.results || [])
      .filter(r => this._matchesTrack(r, trackCode))
      .map(r => this._normalizeResult(r, trackCode, dateStr, prov));
  }

  _matchesTrack(r, trackCode) {
    // The Racing API uses course names; map NYRA codes to names.
    const map = { SAR: /saratoga/i, BEL: /belmont/i, AQU: /aqueduct/i };
    const re = map[trackCode];
    if (!re) return false;
    return re.test(r.course || r.track || '');
  }

  _normalizeCard(r, trackCode, dateStr, prov) {
    const num = Number(r.race_number || r.number || 0);
    return {
      id: trackCode + '-' + dateStr.replace(/-/g, '') + '-R' + num,
      track: trackCode,
      date: dateStr,
      num: num,
      postTime: r.off_time || r.post_time || '',
      distance: r.distance_f || r.distance || '',
      surface: r.surface || 'Unknown',
      purse: Number(r.prize || r.purse || 0) || 0,
      conditions: r.type || r.race_class || '',
      status: 'Scheduled',
      horses: (r.runners || []).map(runner => ({
        id: String(runner.horse_id || runner.number || runner.horse),
        pp: Number(runner.number || runner.draw || 0) || 0,
        name: runner.horse || '',
        jockey: runner.jockey || '',
        trainer: runner.trainer || '',
        owner: runner.owner || '',
        ml: runner.sp || runner.odds || '',
        age: Number(runner.age || 0) || undefined,
        sex: runner.sex || '',
        weight: Number(runner.lbs || runner.weight || 0) || undefined,
        equipment: runner.headgear || '',
        scratched: false,
      })),
      updated: new Date().toISOString(),
      source_provenance: prov,
    };
  }

  _normalizeResult(r, trackCode, dateStr, prov) {
    const num = Number(r.race_number || 0);
    return {
      id: trackCode + '-' + dateStr.replace(/-/g, '') + '-R' + num + '-RESULT',
      track: trackCode,
      date: dateStr,
      num: num,
      status: 'Final',
      horses: [], // results go in the results block below
      results: {
        official_order: (r.runners || []).sort((a, b) => a.position - b.position).map(x => x.horse),
        finish_positions: (r.runners || []).map(x => ({
          pp: Number(x.number || 0),
          horseName: x.horse || '',
          position: Number(x.position || 0),
          beaten_lengths: Number(x.btn || 0) || 0,
        })),
      },
      source_provenance: prov,
    };
  }
}

module.exports = { TheRacingApiAdapter };
