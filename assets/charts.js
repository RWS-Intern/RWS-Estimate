/**
 * assets/charts.js
 *
 * Chart.js builders + the 25-year table renderer, lifted out of
 * reference/estimate.html. Each builder destroys the previous Chart
 * instance it's handed (same pattern as the original's module-level
 * chCmp/chLump/chLev + destroy-then-recreate on every render()) and returns
 * the new one so the caller can hold onto it for next time.
 */
(function () {
  "use strict";

  // Same fallback as reference/estimate.html: if the Chart.js CDN is
  // blocked/slow, don't hard-crash the whole dashboard — charts become
  // no-op stubs and every text metric/table still renders.
  if (typeof Chart === "undefined") {
    window.Chart = function () {
      return { destroy: function () {}, resize: function () {}, update: function () {} };
    };
  }

  var fmtAxis = function (v) {
    return "₹" + (Math.abs(v) >= 1e7 ? (v / 1e7).toFixed(1) + "Cr" : Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(0) + "L" : v);
  };

  var barLabels = {
    id: "barLabels",
    afterDatasetsDraw: function (chart) {
      var ctx = chart.ctx;
      var ds = chart.data.datasets[0];
      if (!ds) return;
      var meta = chart.getDatasetMeta(0);
      meta.data.forEach(function (bar, i) {
        var val = ds.data[i];
        ctx.save();
        ctx.fillStyle = "#012438";
        ctx.font = "bold 13px Arial";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(val + "%", bar.x + 8, bar.y);
        ctx.restore();
      });
    }
  };

  function lineCfg(labels, datasets, inr) {
    return {
      type: "line",
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "top", labels: { font: { family: "Arial" } } },
          tooltip: { callbacks: { label: function (c) { return c.dataset.label + ": " + inr(c.parsed.y); } } }
        },
        scales: {
          y: { ticks: { callback: fmtAxis, font: { family: "Arial" } }, grid: { color: "#eee" } },
          x: { title: { display: true, text: "Year" }, grid: { display: false } }
        }
      }
    };
  }

  /** opts: {irrV, bondRate, fdRate, savingsRate} */
  function renderCompareChart(canvasEl, prevChart, opts) {
    if (prevChart) prevChart.destroy();
    return new Chart(canvasEl, {
      type: "bar", plugins: [barLabels],
      data: {
        labels: ["This Solar Investment", "Corporate Bond", "Bank FD", "Savings A/c"],
        datasets: [{
          label: "Annual return (% p.a.)",
          data: [
            opts.irrV != null ? Math.round(opts.irrV * 1000) / 10 : 0,
            Math.round(opts.bondRate * 1000) / 10,
            opts.fdRate,
            Math.round(opts.savingsRate * 1000) / 10
          ],
          backgroundColor: ["#1a9e57", "#00AFEF", "#7fb1c9", "#c4ccd1"]
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, indexAxis: "y",
        layout: { padding: { right: 46 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return c.parsed.x + "% p.a."; } } }
        },
        scales: {
          x: {
            ticks: { callback: function (v) { return v + "%"; }, font: { family: "Arial" } },
            grid: { color: "#eee" }, title: { display: true, text: "Annual return (%)" }
          },
          y: { grid: { display: false }, ticks: { font: { family: "Arial", weight: "bold" } } }
        }
      }
    });
  }

  /** opts: {labels, solarCum, fdCum, fdLabel, inr} */
  function renderLumpChart(canvasEl, prevChart, opts) {
    if (prevChart) prevChart.destroy();
    return new Chart(canvasEl, lineCfg(opts.labels, [
      { label: "Solar — cumulative cash position", data: opts.solarCum, borderColor: "#1a9e57", backgroundColor: "#1a9e5722", fill: true, tension: .25, pointRadius: 0, borderWidth: 3 },
      { label: opts.fdLabel, data: opts.fdCum, borderColor: "#7fb1c9", backgroundColor: "transparent", borderDash: [6, 4], tension: .25, pointRadius: 0, borderWidth: 2 }
    ], opts.inr));
  }

  /** opts: {labels, financedCum, inr} */
  function renderLevChart(canvasEl, prevChart, opts) {
    if (prevChart) prevChart.destroy();
    return new Chart(canvasEl, lineCfg(opts.labels, [
      { label: "Cumulative cash position (financed)", data: opts.financedCum, borderColor: "#003A5C", backgroundColor: "#003A5C18", fill: true, tension: .25, pointRadius: 0, borderWidth: 3 }
    ], opts.inr));
  }

  function drawTable(tableEl, rows, inr) {
    var z = function (x) { return x ? inr(x) : "—"; };
    var h = "<thead><tr><th>Year</th><th>Per-unit Rate</th><th>Generation (units)</th><th>Gross Savings</th>" +
      "<th>AMC</th><th>Depreciation Tax Benefit</th><th>Short-Term Finance Cost</th><th>Spares &amp; Replacements</th>" +
      "<th>Interest Earned</th><th>Yearly Cash Flow</th><th>Cumulative Cash Flow</th></tr></thead><tbody>";
    rows.forEach(function (r) {
      h += "<tr><td>" + r.y + "</td><td>₹" + r.rate.toFixed(2) + "</td><td>" + Math.round(r.gen).toLocaleString("en-IN") +
        "</td><td>" + inr(r.gross) + "</td><td>" + inr(r.amc) + "</td><td>" + inr(r.depBen) + "</td><td>" + z(r.fin) +
        "</td><td>" + z(r.spares) + "</td><td>" + z(r.interest) + "</td><td>" + inr(r.net) + "</td><td>" + inr(r.cum) + "</td></tr>";
    });
    tableEl.innerHTML = h + "</tbody>";
  }

  window.RiteCharts = {
    renderCompareChart: renderCompareChart,
    renderLumpChart: renderLumpChart,
    renderLevChart: renderLevChart,
    drawTable: drawTable
  };
})();
