/**
 * assets/config-defaults.js
 *
 * `RiteConfig.load()` fetches the LIVE app_config row via
 * `api/get_config.php` (a server-side call to Supabase using the service
 * role key — the config table itself is never exposed to the browser). The
 * admin page at /admin/ edits that row directly; anything saved there takes
 * effect for the next estimate as soon as this fetch runs again.
 *
 * DEFAULTS below is now ONLY a fallback: if the fetch fails or the DB is
 * briefly unreachable, `load()` resolves to these inlined values instead of
 * rejecting, so the public tool keeps working either way. The result is
 * cached in memory for the page's lifetime (a fresh page load re-fetches).
 *
 * Callers (formulation.js, engine.js, assets/js/app.js) are unaffected by
 * any of this — `load()` still returns a `Promise<config>` of the exact
 * same shape it always has.
 *
 * Keys match SPEC.md's seed-value list exactly, plus `years` (the engine's
 * fixed 25-year horizon).
 */
(function () {
  "use strict";

  var DEFAULTS = {
    // engine / formulation constants
    rate_per_kwp: 51000,
    gst_rate: 0.089,
    gen_per_kwp_day: 4,
    amc_rate_per_kwp: 1200,
    amc_esc: 0.01,
    deg_y1: 0.03,
    deg_yr: 0.0071,
    spares_on: true,
    spares_rate_per_kwp: 2800,
    spares_base_rate: 2000,
    discount: 0.12,
    int_surplus: 0.045,
    days: 365,
    dep_rate: 0.40,
    dep_years: 9,
    proc_fee_pct: 0.01,
    tariff_esc: 0.03,
    gsc: 1.96,
    daytime_window: "06-17",
    years: 25,

    // scenario defaults (starting slider positions on the dashboard)
    dep_default: true,
    tax_default: 25.18,
    loan_default: false,
    dp_default: 20,
    loan_rate_default: 9,
    tenure_months_default: 60,
    fd_rate_default: 7,

    // comparison rates on the "vs deposit/bond" chart
    bond_rate: 0.08,
    savings_rate: 0.035,
    equity_rate: 0.12
  };

  var _cachedPromise = null;

  window.RiteConfig = {
    /** Returns a Promise<config object> — fetched from api/get_config.php,
     *  cached in memory after the first call so repeated confirms in the
     *  same page load don't re-fetch. Falls back to DEFAULTS (merged under
     *  whatever the DB did return, if anything) on any failure. */
    load: function () {
      if (_cachedPromise) return _cachedPromise;
      _cachedPromise = fetch('api/get_config.php')
        .then(function (res) { return res.json(); })
        .then(function (json) {
          if (json && json.success && json.config && typeof json.config === 'object') {
            // Merge onto DEFAULTS, not the other way round, so a config row
            // that predates a newly-added key (like `years` was) still
            // gets a sane value instead of `undefined`.
            return Object.assign({}, DEFAULTS, json.config);
          }
          return DEFAULTS;
        })
        .catch(function () {
          return DEFAULTS;
        });
      return _cachedPromise;
    }
  };
})();
