/**
 * assets/formulation.js
 *
 * Derives the per-customer engine inputs from the CONFIRMED extraction JSON
 * (the object the confirm screen hands off), using exactly the formulas in
 * SPEC.md's "Formulas" section. Pure function — no DOM, no fetch.
 */
(function () {
  "use strict";

  var INCONSISTENT_MESSAGE =
    "Your bill values look inconsistent, please recheck total units and TOD slots.";

  function isMissing(v) { return v === null || v === undefined; }

  /** DAYTIME_FRACTION per SPEC.md's DAYTIME_WINDOW flag. Default "06-17"
   *  uses (t06_09.units + t09_17.units) / total_units; "09-17" uses
   *  t09_17.units alone. */
  function daytimeFraction(cm, daytimeWindow) {
    var tod = cm.tod;
    if (daytimeWindow === "09-17") {
      return tod.t09_17.units / cm.total_units;
    }
    return (tod.t06_09.units + tod.t09_17.units) / cm.total_units;
  }

  /**
   * @param {object} confirmed - the confirmed extraction JSON (SPEC.md schema)
   * @param {object} config - resolved app_config (see config-defaults.js)
   * @returns {object} derived inputs: effective_tariff, daytime_fraction,
   *   daytime_window, annual_units, months_used, required_kwp_exact,
   *   offered_kwp, annual_generation, gross_cost, gst_amount,
   *   net_cost_inc_gst, ex_gst_capital, tariff_breakdown
   * @throws {Error} INCONSISTENT_MESSAGE if the bill values can't produce a
   *   sane system size or tariff (total_units missing/zero, any tariff-rate
   *   component or the ToD units/rate this needs are missing,
   *   daytime_fraction > 1, or required_kwp_exact non-finite/<= 0) — almost
   *   always means a field is still blank after manual entry, or total_units
   *   / a TOD slot's units are wrong. Never silently treats a missing value
   *   as zero and produces a garbage size or tariff.
   */
  function derive(confirmed, config) {
    var cm = confirmed.current_month;

    if (isMissing(cm.total_units) || cm.total_units <= 0) {
      throw new Error(INCONSISTENT_MESSAGE);
    }

    // Every one of these feeds effective_tariff or daytime_fraction below
    // via plain `+`/`-` arithmetic, where a missing (null) operand would
    // silently coerce to zero in JS rather than fail — guard explicitly so
    // an incomplete manual entry produces a clear error, not a wrong number.
    var rateFields = ["energy_rate", "demand_charge_per_unit", "fac", "electricity_duty", "tax_on_sale"];
    for (var i = 0; i < rateFields.length; i++) {
      if (isMissing(cm[rateFields[i]])) throw new Error(INCONSISTENT_MESSAGE);
    }
    if (isMissing(cm.tod.t09_17.rate) || isMissing(cm.tod.t09_17.units)) {
      throw new Error(INCONSISTENT_MESSAGE);
    }

    var daytimeWindow = (config && config.daytime_window) || "06-17";
    if (daytimeWindow !== "09-17" && isMissing(cm.tod.t06_09.units)) {
      throw new Error(INCONSISTENT_MESSAGE);
    }

    var dtFraction = daytimeFraction(cm, daytimeWindow);

    if (!isFinite(dtFraction) || dtFraction > 1) {
      throw new Error(INCONSISTENT_MESSAGE);
    }

    var tod = cm.tod;
    var effectiveTariff =
      cm.energy_rate + cm.demand_charge_per_unit + cm.fac + cm.electricity_duty +
      cm.tax_on_sale - config.gsc + tod.t09_17.rate;

    var history = Array.isArray(confirmed.billing_history_units) ? confirmed.billing_history_units : [];
    var annualUnits = history.reduce(function (sum, v) {
      return sum + (typeof v === "number" && isFinite(v) ? v : 0);
    }, 0);
    var monthsUsed = history.length;

    var requiredKwpExact = (annualUnits * dtFraction) / (config.gen_per_kwp_day * config.days);

    if (!isFinite(requiredKwpExact) || requiredKwpExact <= 0) {
      throw new Error(INCONSISTENT_MESSAGE);
    }

    var offeredKwp = Math.ceil(requiredKwpExact);
    var annualGeneration = offeredKwp * config.gen_per_kwp_day * config.days;
    var grossCost = offeredKwp * config.rate_per_kwp;
    var gstAmount = grossCost * config.gst_rate;
    var netCostIncGst = grossCost + gstAmount;
    var exGstCapital = grossCost;

    return {
      effective_tariff: effectiveTariff,
      daytime_fraction: dtFraction,
      daytime_window: daytimeWindow,
      annual_units: annualUnits,
      months_used: monthsUsed,
      required_kwp_exact: requiredKwpExact,
      offered_kwp: offeredKwp,
      annual_generation: annualGeneration,
      gross_cost: grossCost,
      gst_amount: gstAmount,
      net_cost_inc_gst: netCostIncGst,
      ex_gst_capital: exGstCapital,
      // itemised build-up for the narrative — same numbers, kept alongside
      // effective_tariff so the confirm/dashboard prose can show its math.
      tariff_breakdown: {
        energy_rate: cm.energy_rate,
        demand_charge_per_unit: cm.demand_charge_per_unit,
        fac: cm.fac,
        electricity_duty: cm.electricity_duty,
        tax_on_sale: cm.tax_on_sale,
        gsc: config.gsc,
        daytime_tod_rate: tod.t09_17.rate
      }
    };
  }

  window.RiteFormulation = {
    derive: derive,
    INCONSISTENT_MESSAGE: INCONSISTENT_MESSAGE
  };
})();
