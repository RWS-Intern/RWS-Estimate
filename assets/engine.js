/**
 * assets/engine.js
 *
 * The 25-year cash-flow engine, lifted out of reference/estimate.html. Pure
 * computation — no DOM access. Reads every constant from `config` (see
 * assets/config-defaults.js) instead of an inlined `K` object, and takes the
 * per-customer LOCK values (`size`, `gen`, `flatRate`) as an argument instead
 * of hardcoding them — those now come from assets/formulation.js.
 *
 * Two genuinely dead fields from the original compute() were dropped on the
 * way over (verified against reference/estimate.html — neither is read by
 * any UI): `co2PerUnit`/`ppaEsc`/`LOCK.ppa` (fed an `opexArr`/`opexTotal`
 * that nothing displays) and the `gsc:0` placeholder on each row. The
 * `fin:0` placeholder WAS kept — the 25-year table's "Short-Term Finance
 * Cost" column reads it (always renders as "—", same as the original).
 */
(function () {
  "use strict";

  function inr(x) {
    return "₹" + Math.round(x).toLocaleString("en-IN");
  }

  function inrShort(x) {
    var a = Math.abs(x), s = x < 0 ? "-" : "";
    if (a >= 1e7) return s + "₹" + (a / 1e7).toFixed(2) + " Cr";
    if (a >= 1e5) return s + "₹" + (a / 1e5).toFixed(2) + " L";
    return s + "₹" + Math.round(a).toLocaleString("en-IN");
  }

  function pmt(r, n, pv) {
    if (n <= 0) return 0;
    if (r === 0) return pv / n;
    return pv * r / (1 - Math.pow(1 + r, -n));
  }

  function npv(r, cf) {
    var s = 0;
    for (var i = 0; i < cf.length; i++) s += cf[i] / Math.pow(1 + r, i + 1);
    return s;
  }

  function irr(cf) {
    var lo = -0.95, hi = 20;
    function f(r) {
      var s = 0;
      for (var i = 0; i < cf.length; i++) s += cf[i] / Math.pow(1 + r, i);
      return s;
    }
    var a = f(lo), b = f(hi);
    if (a * b > 0) return null;
    for (var k = 0; k < 300; k++) {
      var mid = (lo + hi) / 2, fm = f(mid);
      if (Math.abs(fm) < 1) return mid;
      if (a * fm < 0) { hi = mid; } else { lo = mid; a = fm; }
    }
    return (lo + hi) / 2;
  }

  /**
   * @param {object} lock - {size: offered_kwp, gen: units/kWp/day, flatRate: effective_tariff}
   * @param {object} config - resolved app_config (see config-defaults.js)
   * @param {object} scenario - {dep, tax, loan, dp, rate, ten, fd} (S in the original)
   */
  function compute(lock, config, scenario) {
    var grossCost = lock.size * config.rate_per_kwp, gstAmt = grossCost * config.gst_rate,
      netCost = grossCost + gstAmt, exGst = grossCost;
    var amc1 = lock.size * config.amc_rate_per_kwp, sparesEvt = lock.size * config.spares_rate_per_kwp,
      tax = scenario.tax / 100;
    var loanAmt = scenario.loan ? (1 - scenario.dp / 100) * exGst : 0,
      downPay = scenario.loan ? (scenario.dp / 100) * exGst : exGst;
    var emi = (scenario.loan && loanAmt > 0) ? pmt(scenario.rate / 100 / 12, scenario.ten, loanAmt) : 0,
      procFee = scenario.loan ? config.proc_fee_pct * loanAmt : 0;
    var bal = loanAmt, totalInterest = 0, emiYear = {};
    if (scenario.loan && loanAmt > 0) {
      for (var m = 1; m <= scenario.ten; m++) {
        var it = bal * (scenario.rate / 100 / 12), pr = emi - it;
        if (pr > bal) pr = bal;
        bal -= pr; totalInterest += it;
        var yy = Math.ceil(m / 12);
        emiYear[yy] = (emiYear[yy] || 0) + (it + pr);
      }
    }

    var rows = [], openWDV = exGst, P = 0;
    for (var y = 1; y <= config.years; y++) {
      var rate = y === 1 ? lock.flatRate : rows[y - 2].rate * (1 + config.tariff_esc);
      var gen;
      if (y === 1) gen = lock.size * lock.gen * config.days;
      else if (y === 2) gen = rows[y - 2].gen * (1 - config.deg_y1);
      else gen = rows[y - 2].gen * (1 - config.deg_yr);
      var gross = rate * gen;
      var amc = y === 1 ? amc1 : rows[y - 2].amc * (1 + config.amc_esc);
      var dep = openWDV * config.dep_rate, depBen = (scenario.dep && y <= config.dep_years) ? dep * tax : 0;
      openWDV -= dep;
      var isSp = (config.spares_on && (y === 6 || y === 11 || y === 16 || y === 21));
      var spares = isSp ? sparesEvt : 0;
      var sparesCM = isSp ? lock.size * config.spares_base_rate : 0;
      var oper = gross - amc + depBen - spares;
      var operCM = gross - amc + depBen - sparesCM;
      var prevP = P; P = (y === 1 ? -exGst : prevP) + operCM;
      var interest = (y === 1) ? 0 : (P >= 1 ? P * config.int_surplus : 0);
      var net = (y === 1 ? -exGst : 0) + oper + interest;
      var emiPaid = emiYear[y] || 0, upfront = (y === 1) ? (downPay + procFee) : 0, finNet = oper - emiPaid - upfront;
      rows.push({
        y: y, rate: rate, gen: gen, gross: gross, amc: amc, fin: 0, depBen: depBen,
        spares: spares, interest: interest, oper: oper, net: net, emiPaid: emiPaid, finNet: finNet
      });
    }

    var c = 0, fc = 0;
    rows.forEach(function (r) { c += r.net; r.cum = c; fc += r.finNet; r.fcum = fc; });
    var netArr = rows.map(function (r) { return r.net; }), finArr = rows.map(function (r) { return r.finNet; });
    var profit = netArr.reduce(function (a, b) { return a + b; }, 0);
    var totalOper = profit + exGst;
    var avgOper = profit / config.years;
    var irrV = irr(netArr), finIrr = irr(finArr), npvV = npv(config.discount, netArr);
    var energy = rows.reduce(function (a, r) { return a + r.gen; }, 0),
      sumAMC = rows.reduce(function (a, r) { return a + r.amc; }, 0),
      sumSp = rows.reduce(function (a, r) { return a + r.spares; }, 0);
    var lcoe = (netCost + sumAMC + sumSp) / energy;

    var payback = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].cum >= 0) { var p = i === 0 ? -exGst : rows[i - 1].cum; payback = i + (-p / rows[i].net); break; }
    }
    var finPay = null;
    for (var i2 = 0; i2 < rows.length; i2++) {
      if (rows[i2].fcum >= 0) { var p2 = i2 === 0 ? 0 : rows[i2 - 1].fcum; finPay = i2 + (-p2 / rows[i2].finNet); break; }
    }

    return {
      grossCost: grossCost, netCost: netCost, exGst: exGst, loanAmt: loanAmt, downPay: downPay,
      emi: emi, procFee: procFee, totalInterest: totalInterest, rows: rows,
      profit: profit, totalOper: totalOper, avgOper: avgOper, irrV: irrV, finIrr: finIrr, npvV: npvV,
      energy: energy, lcoe: lcoe, payback: payback, finPay: finPay,
      multiple: totalOper / exGst
    };
  }

  window.RiteEngine = {
    compute: compute,
    irr: irr,
    npv: npv,
    pmt: pmt,
    inr: inr,
    inrShort: inrShort
  };
})();
