/**
 * assets/formulation.js
 *
 * Derives the per-customer engine inputs from the CONFIRMED extraction JSON
 * (the object the confirm screen hands off), using exactly the formulas in
 * SPEC.md's "Formulas" section. Pure functions — no DOM, no fetch.
 *
 * Two categories, two independent derivations:
 *   - deriveIndustrial() — MSEDCL industrial bills, ToD-slot sizing. This
 *     was the ORIGINAL derive() body, untouched byte-for-byte apart from
 *     two additive changes: the three new return keys (rate_per_kwp/
 *     gst_rate/category), and a pure rename of demand_charge_per_unit ->
 *     wheeling_per_unit (real-bill testing found that field was actually
 *     the bill's Wheeling Charges rate under the wrong label — same MATH,
 *     value flows into effective_tariff exactly as before, just a renamed
 *     input/output key; verified bit-identical against SPEC.md's reference
 *     example, see that section's Owner notes).
 *   - deriveCommercial() — MSEDCL commercial bills, which split
 *     wheeling/duty/ToD-rebate/GSC as their own line items instead of a
 *     per-slot ToD table, and size against a solar-hour-share assumption
 *     capped by sanctioned load rather than a measured daytime fraction.
 * derive() dispatches on confirmed.tariff_category — that's the only new
 * code industrial's call path runs through.
 */
(function () {
  "use strict";

  var INCONSISTENT_MESSAGE =
    "Your bill values look inconsistent, please recheck total units and TOD slots.";
  var INCONSISTENT_MESSAGE_COMMERCIAL =
    "Your bill values look inconsistent, please recheck consumption units, sanctioned load, and the charge components.";

  // Output sanity guard, shared by both categories: no real MSEDCL C&I
  // tariff sits outside this band, so a derived effective_tariff beyond it
  // means some per-unit field is actually holding a monthly total (or
  // similar extraction slip) that individually-plausible per-field range
  // checks didn't catch — cheap insurance against ANY future extraction
  // mistake, not just the electricity-duty one that motivated it. Thrown as
  // a distinct error type (not a plain Error) so app.js can specifically
  // catch it and re-flag the per-unit fields, rather than just show the
  // message like the generic INCONSISTENT_MESSAGE cases above.
  var TARIFF_SANITY_LO = 3;
  var TARIFF_SANITY_HI = 25;

  function TariffSanityError(tariff, fields) {
    this.name = "TariffSanityError";
    this.message = "These values produce an unrealistic tariff of ₹" + tariff.toFixed(2) +
      "/unit — please re-check the highlighted fields.";
    this.tariff = tariff;
    this.fields = fields; // dotted-paths of the per-unit fields to re-flag
  }
  TariffSanityError.prototype = Object.create(Error.prototype);
  TariffSanityError.prototype.constructor = TariffSanityError;

  function checkTariffSanity(effectiveTariff, fields) {
    if (!isFinite(effectiveTariff) || effectiveTariff < TARIFF_SANITY_LO || effectiveTariff > TARIFF_SANITY_HI) {
      throw new TariffSanityError(effectiveTariff, fields);
    }
  }

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

  function sumUnits(history) {
    return history.reduce(function (sum, v) {
      return sum + (typeof v === "number" && isFinite(v) ? v : 0);
    }, 0);
  }

  /**
   * @param {object} confirmed - the confirmed extraction JSON (SPEC.md schema)
   * @param {object} config - resolved app_config (see config-defaults.js)
   * @returns {object} derived inputs: effective_tariff, daytime_fraction,
   *   daytime_window, annual_units, months_used, required_kwp_exact,
   *   offered_kwp, annual_generation, gross_cost, gst_amount,
   *   net_cost_inc_gst, ex_gst_capital, rate_per_kwp, gst_rate, category,
   *   tariff_breakdown
   * @throws {Error} INCONSISTENT_MESSAGE if the bill values can't produce a
   *   sane system size or tariff (total_units missing/zero, any tariff-rate
   *   component or the ToD units/rate this needs are missing,
   *   daytime_fraction > 1, or required_kwp_exact non-finite/<= 0) — almost
   *   always means a field is still blank after manual entry, or total_units
   *   / a TOD slot's units are wrong. Never silently treats a missing value
   *   as zero and produces a garbage size or tariff.
   */
  function deriveIndustrial(confirmed, config) {
    var cm = confirmed.current_month;

    if (isMissing(cm.total_units) || cm.total_units <= 0) {
      throw new Error(INCONSISTENT_MESSAGE);
    }

    // Legacy read-side fallback: rows extracted/confirmed before the
    // demand_charge_per_unit -> wheeling_per_unit rename used the old key
    // for the same bill line (the "Wheeling Charges" rate) under the wrong
    // label — same value, same treatment, just renamed.
    var wheelingPerUnit = !isMissing(cm.wheeling_per_unit) ? cm.wheeling_per_unit : cm.demand_charge_per_unit;

    // Every one of these feeds effective_tariff or daytime_fraction below
    // via plain `+`/`-` arithmetic, where a missing (null) operand would
    // silently coerce to zero in JS rather than fail — guard explicitly so
    // an incomplete manual entry produces a clear error, not a wrong number.
    var rateFields = ["energy_rate", "fac", "electricity_duty", "tax_on_sale"];
    for (var i = 0; i < rateFields.length; i++) {
      if (isMissing(cm[rateFields[i]])) throw new Error(INCONSISTENT_MESSAGE);
    }
    if (isMissing(wheelingPerUnit)) throw new Error(INCONSISTENT_MESSAGE);
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
      cm.energy_rate + wheelingPerUnit + cm.fac + cm.electricity_duty +
      cm.tax_on_sale - config.gsc + tod.t09_17.rate;

    checkTariffSanity(effectiveTariff, [
      "current_month.energy_rate", "current_month.wheeling_per_unit", "current_month.fac",
      "current_month.electricity_duty", "current_month.tax_on_sale", "current_month.tod.t09_17.rate"
    ]);

    var history = Array.isArray(confirmed.billing_history_units) ? confirmed.billing_history_units : [];
    var annualUnits = sumUnits(history);
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
      // Per-customer rate/GST the engine multiplies size by — for industrial
      // this is just the flat global constant, made explicit here so
      // engine.js can read it off `lock` the same way for every category
      // instead of special-casing industrial vs. commercial.
      rate_per_kwp: config.rate_per_kwp,
      gst_rate: config.gst_rate,
      category: "Industrial",
      // itemised build-up for the narrative — same numbers, kept alongside
      // effective_tariff so the confirm/dashboard prose can show its math.
      tariff_breakdown: {
        energy_rate: cm.energy_rate,
        wheeling_per_unit: wheelingPerUnit,
        fac: cm.fac,
        electricity_duty: cm.electricity_duty,
        tax_on_sale: cm.tax_on_sale,
        gsc: config.gsc,
        daytime_tod_rate: tod.t09_17.rate
      }
    };
  }

  /** Floor lookup: the highest table entry whose kwp threshold is <= size.
   *  Table is a code-default fallback (see config-defaults.js) — always
   *  sorted ascending by kwp before searching, so an admin-edited table
   *  pasted out of order still resolves correctly. */
  function lookupCommercialRatePerKwp(sizeKwp, table) {
    var rows = (Array.isArray(table) ? table.slice() : []).filter(function (r) {
      return r && typeof r.kwp === "number" && typeof r.rate === "number";
    });
    rows.sort(function (a, b) { return a.kwp - b.kwp; });
    var rate = rows.length ? rows[0].rate : null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].kwp <= sizeKwp) rate = rows[i].rate;
      else break;
    }
    return rate;
  }

  /**
   * @param {object} confirmed - confirmed extraction JSON; commercial
   *   fields live under confirmed.commercial (see SPEC.md's extraction
   *   schema — parallel to industrial's confirmed.current_month).
   * @param {object} config - resolved app_config, incl. solar_hour_share_pct,
   *   gst_pct_commercial, commercial_rate_table (see config-defaults.js)
   * @throws {Error} INCONSISTENT_MESSAGE_COMMERCIAL on the same
   *   "missing field would silently coerce to zero" class of gap
   *   deriveIndustrial() guards against, plus a missing/zero sanctioned
   *   load (the sizing cap has nothing to cap against without it).
   */
  function deriveCommercial(confirmed, config) {
    var c = confirmed.commercial || {};

    // Legacy read-side fallback: rows extracted/confirmed before the
    // wheeling/demand_charge fix used demand_charge (Rs/month, divided by
    // units) for what is actually the bill's wheeling line (already
    // Rs/unit). Nothing in this codebase currently re-feeds an archived
    // submissions.extracted row back into deriveCommercial() (the admin
    // Leads view only reads the flattened `computed` summary, never raw
    // extracted fields), but this keeps that path graceful rather than
    // silently wrong if it's ever added.
    var wheeling = !isMissing(c.wheeling) ? c.wheeling : c.demand_charge;

    var requiredFields = [
      "current_month_units", "energy_rate", "fac",
      "electricity_duty_pct", "tax_on_sale", "tod_rebate_pct", "grid_support_charge"
    ];
    for (var i = 0; i < requiredFields.length; i++) {
      if (isMissing(c[requiredFields[i]])) throw new Error(INCONSISTENT_MESSAGE_COMMERCIAL);
    }
    if (isMissing(wheeling)) throw new Error(INCONSISTENT_MESSAGE_COMMERCIAL);
    if (isMissing(c.current_month_units) || c.current_month_units <= 0) {
      throw new Error(INCONSISTENT_MESSAGE_COMMERCIAL);
    }
    var sanctionedLoadKw = confirmed.sanctioned_load_kw;
    if (isMissing(sanctionedLoadKw) || sanctionedLoadKw <= 0) {
      throw new Error(INCONSISTENT_MESSAGE_COMMERCIAL);
    }

    // wheeling is ALREADY Rs/unit (unlike the old demand_charge, which was a
    // Rs/month total that had to be divided by current_month_units) — used
    // directly, no per-unit conversion.
    var dutyPerUnit = (c.electricity_duty_pct / 100) * (c.energy_rate + wheeling + c.fac);
    var todRebatePerUnit = (c.tod_rebate_pct / 100) * c.energy_rate;
    var effectiveTariff =
      c.energy_rate + wheeling + c.fac + dutyPerUnit + c.tax_on_sale -
      todRebatePerUnit - c.grid_support_charge;

    checkTariffSanity(effectiveTariff, [
      "commercial.energy_rate", "commercial.wheeling", "commercial.fac",
      "commercial.electricity_duty_pct", "commercial.tax_on_sale",
      "commercial.tod_rebate_pct", "commercial.grid_support_charge"
    ]);

    var history = Array.isArray(confirmed.billing_history_units) ? confirmed.billing_history_units : [];
    var annualUnits = sumUnits(history);
    var monthsUsed = history.length;

    var solarHourSharePct = (config && typeof config.solar_hour_share_pct === "number") ? config.solar_hour_share_pct : 75;
    var requiredKwpExact = (annualUnits * (solarHourSharePct / 100)) / (config.gen_per_kwp_day * config.days);

    if (!isFinite(requiredKwpExact) || requiredKwpExact <= 0) {
      throw new Error(INCONSISTENT_MESSAGE_COMMERCIAL);
    }

    // MIN(required, sanctioned) decides which constraint binds; only when
    // consumption is the binding constraint do we round UP like industrial
    // — a sanctioned-load cap is used exactly as printed on the bill, decimal
    // and all (there's no "round up" a fixed grid connection limit).
    var sizedBySanctionedLoad = sanctionedLoadKw <= requiredKwpExact;
    var offeredKwp = sizedBySanctionedLoad ? sanctionedLoadKw : Math.ceil(requiredKwpExact);

    var ratePerKwpTable = (config && Array.isArray(config.commercial_rate_table)) ? config.commercial_rate_table : null;
    var ratePerKwp = lookupCommercialRatePerKwp(offeredKwp, ratePerKwpTable);
    if (ratePerKwp === null || !isFinite(ratePerKwp)) {
      throw new Error(INCONSISTENT_MESSAGE_COMMERCIAL);
    }

    var gstPctCommercial = (config && typeof config.gst_pct_commercial === "number") ? config.gst_pct_commercial : 8.9;
    var gstRate = gstPctCommercial / 100;

    var annualGeneration = offeredKwp * config.gen_per_kwp_day * config.days;
    var grossCost = offeredKwp * ratePerKwp;
    var gstAmount = grossCost * gstRate;
    var netCostIncGst = grossCost + gstAmount;
    var exGstCapital = grossCost;

    return {
      effective_tariff: effectiveTariff,
      annual_units: annualUnits,
      months_used: monthsUsed,
      required_kwp_exact: requiredKwpExact,
      offered_kwp: offeredKwp,
      annual_generation: annualGeneration,
      gross_cost: grossCost,
      gst_amount: gstAmount,
      net_cost_inc_gst: netCostIncGst,
      ex_gst_capital: exGstCapital,
      rate_per_kwp: ratePerKwp,
      gst_rate: gstRate,
      category: "Commercial",
      sized_by_sanctioned_load: sizedBySanctionedLoad,
      solar_hour_share_pct: solarHourSharePct,
      sanctioned_load_kw: sanctionedLoadKw,
      // itemised build-up for the narrative — commercial's own shape,
      // parallel to deriveIndustrial()'s tariff_breakdown.
      tariff_breakdown: {
        current_month_units: c.current_month_units,
        energy_rate: c.energy_rate,
        wheeling: wheeling,
        fac: c.fac,
        electricity_duty_pct: c.electricity_duty_pct,
        duty_per_unit: dutyPerUnit,
        tax_on_sale: c.tax_on_sale,
        tod_rebate_pct: c.tod_rebate_pct,
        tod_rebate_per_unit: todRebatePerUnit,
        grid_support_charge: c.grid_support_charge
      }
    };
  }

  function derive(confirmed, config) {
    return confirmed.tariff_category === "Commercial"
      ? deriveCommercial(confirmed, config)
      : deriveIndustrial(confirmed, config);
  }

  window.RiteFormulation = {
    derive: derive,
    deriveIndustrial: deriveIndustrial,
    deriveCommercial: deriveCommercial,
    lookupCommercialRatePerKwp: lookupCommercialRatePerKwp,
    INCONSISTENT_MESSAGE: INCONSISTENT_MESSAGE,
    INCONSISTENT_MESSAGE_COMMERCIAL: INCONSISTENT_MESSAGE_COMMERCIAL,
    TariffSanityError: TariffSanityError,
    TARIFF_SANITY_LO: TARIFF_SANITY_LO,
    TARIFF_SANITY_HI: TARIFF_SANITY_HI
  };
})();
