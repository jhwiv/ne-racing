// Tiny assertion + reporter. Each layer instantiates a Report, calls
// .check(name, condition, detail?) and finally .finish() which prints a
// human-readable summary and exits non-zero on any failure.

class Report {
  constructor(layerName) {
    this.layer = layerName;
    this.checks = [];
    this.t0 = Date.now();
  }
  check(name, condition, detail) {
    const ok = !!condition;
    this.checks.push({ name, ok, detail: ok ? null : (detail || null) });
    const tag = ok ? 'PASS' : 'FAIL';
    const line = `  [${tag}] ${name}` + (!ok && detail ? `  →  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '');
    console.log(line);
    return ok;
  }
  note(msg) { console.log(`  · ${msg}`); }
  finish() {
    const passed = this.checks.filter(c => c.ok).length;
    const failed = this.checks.length - passed;
    const ms = Date.now() - this.t0;
    console.log(`\n[${this.layer}] ${passed}/${this.checks.length} passed in ${ms}ms`);
    if (failed > 0) {
      console.log(`[${this.layer}] FAILURES:`);
      this.checks.filter(c => !c.ok).forEach(c => {
        console.log(`  - ${c.name}: ${c.detail ? (typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)) : '(no detail)'}`);
      });
    }
    return { layer: this.layer, passed, failed, total: this.checks.length, ms, checks: this.checks };
  }
}

module.exports = { Report };
