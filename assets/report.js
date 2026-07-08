/**
 * assets/report.js
 *
 * Builds the branded, client-ready 25-year estimate PDF ("Investment Ka
 * Dhurandhar" memorandum layout — see reference/Rite_Solar_Investment_Safal_50kw.pdf)
 * and triggers its download. Built up with jsPDF + jspdf-autotable primitives
 * (text/tables/embedded chart images) rather than a screenshot of the live
 * page — the dashboard's sliders/toggles/buttons never appear here.
 *
 * Reuses the SAME derived values already on screen (formulation, config,
 * lock, the engine's compute() function) — nothing here changes the
 * underlying math, only how it's laid out. Two scenarios are computed
 * fresh, independent of whatever the customer's live dashboard sliders
 * happen to be set to, so the memorandum reads the same regardless of
 * what the customer was fiddling with when they hit download:
 *   - "all-cash": ctx.scenario with loan forced off — the headline IRR/
 *     LCOE/earnings/multiple/payback and the page-1/2 charts are always
 *     this unlevered case, matching the reference's framing.
 *   - "standard financed": config's own *_default loan terms (dp/rate/
 *     tenure), loan forced ON — the page-2 "Financed option" panel. This
 *     is a fixed illustration, not tied to the live loan-slider position.
 * Tax rate / depreciation toggle / FD comparison rate DO still come from
 * ctx.scenario — those are genuine customer inputs worth respecting.
 *
 * Font: jsPDF's built-in "helvetica" has no ₹ glyph (renders as garbage —
 * ¹, stray quote marks, etc). assets/fonts/NotoSans-{Regular,Bold}.ttf are
 * bundled locally (not loaded from a CDN, so this works offline and on
 * Hostinger) and embedded into the PDF via addFileToVFS/addFont, then set
 * as the document's only font before any text is drawn — see
 * loadFontBase64()/registerFonts() below. Every minus sign uses a plain
 * ASCII hyphen (U+002D), not U+2212, which this font doesn't contain.
 */
(function () {
  "use strict";

  var LOGO_URL = "assets/img/rite-solar-logo.png";
  var ADVISOR_URL = "assets/img/advisor.png";
  var FONT_REGULAR_URL = "assets/fonts/NotoSans-Regular.ttf";
  var FONT_BOLD_URL = "assets/fonts/NotoSans-Bold.ttf";
  var FONT_FAMILY = "NotoSans";
  var MARGIN = 40;
  var HERO_H = 320;       // total height of page 1's dark-navy hero band (headline + KPI chips)
  var HERO_CHIP_Y = HERO_H - 76; // chip row sits inside the last 76pt of the hero band

  // Palette per the "Investment Ka Dhurandhar" design spec.
  var NAVY = [11, 58, 83];        // #0B3A53
  var DEEP = [7, 42, 61];         // #072A3D
  var YELLOW = [245, 168, 0];     // #F5A800 — headline/KPI numbers/dividers
  var GOLD = [247, 148, 29];      // #F7941D — smaller text accents
  var GREEN = [30, 158, 79];      // #1E9E4F
  var SKY = [41, 171, 226];       // #29ABE2
  var GRAY = [245, 245, 245];     // light grey panels
  var MUTED = [107, 119, 128];
  var TEXT = [42, 51, 56];
  var WHITE = [255, 255, 255];
  var HERO_TEXT = [214, 230, 240];
  var RED = [237, 50, 55];

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("image failed to load: " + url)); };
      img.src = url;
    });
  }

  /** Chunked to avoid "Maximum call stack size exceeded" from spreading a
   *  few-hundred-KB font file into String.fromCharCode.apply in one go. */
  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = "";
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function loadFontBase64(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("font fetch failed (" + res.status + "): " + url);
      return res.arrayBuffer();
    }).then(arrayBufferToBase64);
  }

  /** Embeds both weights under one family name and makes it the document's
   *  active font. Must run before any doc.text()/autoTable() call. */
  function registerFonts(doc, regularB64, boldB64) {
    doc.addFileToVFS("NotoSans-Regular.ttf", regularB64);
    doc.addFont("NotoSans-Regular.ttf", FONT_FAMILY, "normal");
    doc.addFileToVFS("NotoSans-Bold.ttf", boldB64);
    doc.addFont("NotoSans-Bold.ttf", FONT_FAMILY, "bold");
    doc.setFont(FONT_FAMILY, "normal");
  }

  /** Downscales an already-loaded image via canvas so a multi-hundred-KB
   *  source photo doesn't bloat the PDF — pixel count (not compression) is
   *  what drives size here, so a plain re-encode at a smaller size is
   *  enough. Preserves alpha (PNG) since the advisor photo is transparent. */
  function downscaleToDataUrl(img, maxDim) {
    var scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    var w = Math.max(1, Math.round(img.naturalWidth * scale));
    var h = Math.max(1, Math.round(img.naturalHeight * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL("image/png"), w: w, h: h };
  }

  function slug(s) {
    var cleaned = (s || "").trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return cleaned || "Customer";
  }

  function setColor(doc, rgb) { doc.setTextColor(rgb[0], rgb[1], rgb[2]); }
  function setFill(doc, rgb) { doc.setFillColor(rgb[0], rgb[1], rgb[2]); }

  function pageW(doc) { return doc.internal.pageSize.getWidth(); }
  function pageH(doc) { return doc.internal.pageSize.getHeight(); }
  function contentW(doc) { return pageW(doc) - 2 * MARGIN; }

  /** Adds a new page if `needed` vertical space would overflow this one. */
  function ensureSpace(doc, y, needed) {
    if (y + needed > pageH(doc) - MARGIN) {
      doc.addPage();
      return MARGIN;
    }
    return y;
  }

  /** Bold navy sentence-case heading, matching the reference's section
   *  titles ("Technical snapshot", "Your capital, compounding..."). */
  function heading(doc, y, text, size) {
    y = ensureSpace(doc, y, (size || 14) + 6);
    doc.setFont(FONT_FAMILY, "bold");
    doc.setFontSize(size || 14);
    setColor(doc, NAVY);
    doc.text(text, MARGIN, y);
    return y + (size || 14) + 4;
  }

  // --------------------------------------------------------------- charts
  // Both charts are rendered on a detached, never-DOM-attached canvas with
  // `responsive:false, animation:false` — deliberately NOT reusing the live
  // dashboard's Chart.js instances (assets/charts.js), because those may
  // reflect whatever loan/scenario toggle the customer happened to leave on
  // screen, and this report always frames its numbers around the freshly
  // -computed all-cash / standard-financed scenarios instead (see file
  // header). `animation:false` matters: without it, toBase64Image() called
  // immediately after construction could capture a blank first frame.

  function renderCompareChartImage(irrV, bondRate, fdRate, savingsRate) {
    try {
      var canvas = document.createElement("canvas");
      canvas.width = 1000; canvas.height = 420;
      var barLabelsPlugin = {
        id: "pdfBarLabels",
        afterDatasetsDraw: function (chart) {
          var c2 = chart.ctx, ds = chart.data.datasets[0], meta = chart.getDatasetMeta(0);
          meta.data.forEach(function (bar, i) {
            c2.save();
            c2.fillStyle = "#0B3A53";
            c2.font = "bold 20px Arial";
            c2.textBaseline = "middle";
            c2.textAlign = "left";
            c2.fillText(ds.data[i] + "%", bar.x + 10, bar.y);
            c2.restore();
          });
        }
      };
      var chart = new window.Chart(canvas, {
        type: "bar",
        plugins: [barLabelsPlugin],
        data: {
          labels: ["This Solar Investment", "Corporate Bond", "Bank FD", "Savings A/c"],
          datasets: [{
            data: [
              irrV != null ? Math.round(irrV * 1000) / 10 : 0,
              Math.round(bondRate * 1000) / 10,
              fdRate,
              Math.round(savingsRate * 1000) / 10
            ],
            backgroundColor: ["#1E9E4F", "#29ABE2", "#7fb1c9", "#c4ccd1"]
          }]
        },
        options: {
          responsive: false, animation: false, indexAxis: "y",
          layout: { padding: { right: 60 } },
          plugins: { legend: { display: false } },
          scales: {
            x: {
              ticks: { callback: function (v) { return v + "%"; }, font: { family: "Arial", size: 13 } },
              grid: { color: "#eee" },
              title: { display: true, text: "Annual return (% p.a.)", font: { family: "Arial", size: 13 } }
            },
            y: { grid: { display: false }, ticks: { font: { family: "Arial", size: 14, weight: "bold" } } }
          }
        }
      });
      var dataUrl = chart.toBase64Image();
      chart.destroy();
      return { dataUrl: dataUrl, w: canvas.width, h: canvas.height };
    } catch (e) {
      return null;
    }
  }

  function renderCumulativeChartImage(rows) {
    try {
      var canvas = document.createElement("canvas");
      canvas.width = 1000; canvas.height = 420;
      var points = rows.map(function (r) { return { x: r.y, y: r.cum / 1e5 }; });
      var chart = new window.Chart(canvas, {
        type: "line",
        data: {
          datasets: [{
            data: points, borderColor: "#1E9E4F", backgroundColor: "rgba(30,158,79,0.14)",
            fill: true, tension: 0.25, pointRadius: 0, borderWidth: 3
          }]
        },
        options: {
          responsive: false, animation: false,
          plugins: { legend: { display: false } },
          scales: {
            x: {
              type: "linear", min: 1, max: rows.length,
              ticks: { stepSize: 5, font: { family: "Arial", size: 13 } },
              grid: { color: "#eee" },
              title: { display: true, text: "Year", font: { family: "Arial", size: 13 } }
            },
            y: {
              ticks: { font: { family: "Arial", size: 13 } },
              grid: { color: "#eee" },
              title: { display: true, text: "Cumulative cash flow (₹ lakh)", font: { family: "Arial", size: 13 } }
            }
          }
        }
      });
      var dataUrl = chart.toBase64Image();
      chart.destroy();
      return { dataUrl: dataUrl, w: canvas.width, h: canvas.height };
    } catch (e) {
      return null;
    }
  }

  /** Draws a pre-rendered chart image (see above), scaled to content width
   *  and capped at maxH. Skips silently (no space consumed) if chartResult
   *  is null — e.g. the real Chart.js never loaded (blocked CDN). */
  function drawChartImage(doc, y, chartResult, maxH) {
    if (!chartResult) return y;
    var w = contentW(doc);
    var h = w * (chartResult.h / chartResult.w);
    if (h > maxH) { w = w * (maxH / h); h = maxH; }
    y = ensureSpace(doc, y, h + 10);
    var x = MARGIN + (contentW(doc) - w) / 2;
    doc.addImage(chartResult.dataUrl, "PNG", x, y, w, h);
    return y + h + 16;
  }

  // ---------------------------------------------------------------- page 1
  function drawHeroBand(doc, ctx, logoImg, advisorData, allCashM, lock) {
    var pw = pageW(doc);
    setFill(doc, DEEP);
    doc.rect(0, 0, pw, HERO_H, "F");

    var chipW = 110, chipH = 52, chipX = MARGIN, chipY = 14, pad = 8;
    setFill(doc, WHITE);
    doc.roundedRect(chipX, chipY, chipW, chipH, 6, 6, "F");
    var maxW = chipW - pad * 2, maxH = chipH - pad * 2;
    var ratio = Math.min(maxW / logoImg.naturalWidth, maxH / logoImg.naturalHeight);
    var lw = logoImg.naturalWidth * ratio, lh = logoImg.naturalHeight * ratio;
    doc.addImage(logoImg, "PNG", chipX + (chipW - lw) / 2, chipY + (chipH - lh) / 2, lw, lh);

    doc.setFont(FONT_FAMILY, "bold");
    doc.setFontSize(11.5);
    setColor(doc, GOLD);
    doc.text("SOLAR INVESTMENT MEMORANDUM", pw - MARGIN, 38, { align: "right" });

    doc.setFontSize(30);
    setColor(doc, WHITE);
    doc.text("INVESTMENT KA", MARGIN, 112);
    setColor(doc, YELLOW);
    doc.text("DHURANDHAR", MARGIN, 146);

    var prepY = 172;
    doc.setFont(FONT_FAMILY, "bold");
    doc.setFontSize(13);
    setColor(doc, GOLD);
    doc.text("Prepared for ", MARGIN, prepY);
    var preparedForW = doc.getTextWidth("Prepared for ");
    setColor(doc, WHITE);
    doc.text(String(ctx.companyName || "Customer").toUpperCase(), MARGIN + preparedForW, prepY);

    var dispW = 0;
    if (advisorData) {
      dispW = 160;
      var dispH = dispW * (advisorData.h / advisorData.w);
      doc.addImage(advisorData.dataUrl, "PNG", pw - dispW - 10, 46, dispW, dispH);
    }

    var summaryW = pw - MARGIN - (dispW > 0 ? dispW + 30 : MARGIN);
    var irrPct = allCashM.irrV != null ? (allCashM.irrV * 100).toFixed(1) : "—";
    var summary = "An estimated " + irrPct + "% IRR — a 25-year, asset-backed, inflation-protected " +
      "return on a " + lock.size + " kWp rooftop solar plant. A return no FD or bond can match.";
    doc.setFont(FONT_FAMILY, "normal");
    doc.setFontSize(10);
    setColor(doc, HERO_TEXT);
    doc.text(doc.splitTextToSize(summary, summaryW), MARGIN, 192);

    return HERO_H;
  }

  function drawKpiChips(doc, y, stats) {
    var boxH = 60;
    var n = stats.length, gap = 8;
    var boxWidth = (contentW(doc) - gap * (n - 1)) / n;
    stats.forEach(function (s, i) {
      var x = MARGIN + i * (boxWidth + gap);
      setFill(doc, NAVY);
      doc.roundedRect(x, y, boxWidth, boxH, 5, 5, "F");
      doc.setFont(FONT_FAMILY, "bold");
      doc.setFontSize(15);
      setColor(doc, YELLOW);
      doc.text(String(s.value), x + boxWidth / 2, y + 24, { align: "center" });
      doc.setFont(FONT_FAMILY, "normal");
      doc.setFontSize(7.5);
      setColor(doc, HERO_TEXT);
      doc.text(s.label, x + boxWidth / 2, y + 40, { align: "center", maxWidth: boxWidth - 10 });
    });
    return y + boxH;
  }

  function drawCompareSection(doc, y, allCashM, config, scenarioFd) {
    var netCap = allCashM.exGst;
    var inrShort = window.RiteEngine.inrShort;
    y = heading(doc, y, "Where else does " + inrShort(netCap) + " work this hard?", 15);
    doc.setFont(FONT_FAMILY, "normal");
    doc.setFontSize(10);
    setColor(doc, MUTED);
    doc.text("Your net capital (ex-GST) vs the same money in capital-protected instruments — annual return.", MARGIN, y);
    y += 20;

    var chartResult = renderCompareChartImage(allCashM.irrV, config.bond_rate, scenarioFd, config.savings_rate);
    y = drawChartImage(doc, y, chartResult, 210);

    var panelH = 60;
    y = ensureSpace(doc, y, panelH + 10);
    setFill(doc, [232, 247, 238]);
    doc.roundedRect(MARGIN, y, contentW(doc), panelH, 5, 5, "F");
    doc.setFont(FONT_FAMILY, "normal");
    doc.setFontSize(10.5);
    setColor(doc, TEXT);
    doc.text("Value back on " + inrShort(netCap) + " over 25 years", MARGIN + 16, y + 22);
    doc.setFont(FONT_FAMILY, "bold");
    doc.setFontSize(16);
    setColor(doc, TEXT);
    doc.text("Solar:  ", MARGIN + 16, y + 44);
    var solarLabelW = doc.getTextWidth("Solar:  ");
    setColor(doc, GREEN);
    doc.text(inrShort(allCashM.totalOper), MARGIN + 16 + solarLabelW, y + 44);

    return y + panelH;
  }

  // ---------------------------------------------------------------- pages 2/3
  function drawTopBand(doc, logoImg, title) {
    var pw = pageW(doc);
    var bandH = 60;
    setFill(doc, DEEP);
    doc.rect(0, 0, pw, bandH, "F");

    var chipW = 92, chipH = 40, chipX = MARGIN, chipY = (bandH - chipH) / 2, pad = 6;
    setFill(doc, WHITE);
    doc.roundedRect(chipX, chipY, chipW, chipH, 5, 5, "F");
    var maxW = chipW - pad * 2, maxH = chipH - pad * 2;
    var ratio = Math.min(maxW / logoImg.naturalWidth, maxH / logoImg.naturalHeight);
    var lw = logoImg.naturalWidth * ratio, lh = logoImg.naturalHeight * ratio;
    doc.addImage(logoImg, "PNG", chipX + (chipW - lw) / 2, chipY + (chipH - lh) / 2, lw, lh);

    doc.setFont(FONT_FAMILY, "bold");
    doc.setFontSize(13);
    setColor(doc, WHITE);
    doc.text(title, pw - MARGIN, bandH / 2 + 4, { align: "right" });

    setFill(doc, YELLOW);
    doc.rect(0, bandH, pw, 4, "F");

    return bandH + 4 + 26;
  }

  function drawExplainerCards(doc, y, cardA, cardB) {
    var gap = 16;
    var colW = (contentW(doc) - gap) / 2;
    var innerW = colW - 24;

    doc.setFont(FONT_FAMILY, "normal");
    doc.setFontSize(9);
    var linesA = doc.splitTextToSize(cardA.body, innerW);
    var linesB = doc.splitTextToSize(cardB.body, innerW);
    var maxLines = Math.max(linesA.length, linesB.length);
    var cardH = 34 + maxLines * 11.5 + 14;

    y = ensureSpace(doc, y, cardH + 10);

    [{ x: MARGIN, title: cardA.title, lines: linesA }, { x: MARGIN + colW + gap, title: cardB.title, lines: linesB }]
      .forEach(function (card) {
        setFill(doc, WHITE);
        doc.roundedRect(card.x, y, colW, cardH, 3, 3, "F");
        doc.setDrawColor(226, 232, 236);
        doc.roundedRect(card.x, y, colW, cardH, 3, 3, "S");
        setFill(doc, SKY);
        doc.rect(card.x, y + 2, 4, cardH - 4, "F");

        doc.setFont(FONT_FAMILY, "bold");
        doc.setFontSize(11);
        setColor(doc, NAVY);
        doc.text(card.title, card.x + 16, y + 20, { maxWidth: innerW });

        doc.setFont(FONT_FAMILY, "normal");
        doc.setFontSize(9);
        setColor(doc, TEXT);
        doc.text(card.lines, card.x + 16, y + 36);
      });

    return y + cardH;
  }

  /** Plain-text (no HTML) equivalents of app.js's renderIndustrialNarrative()/
   *  renderCommercialNarrative() — same duplicated-prose convention this
   *  file already follows for the industrial case, extended to commercial. */
  function narrativeCards(formulation) {
    var monthsNote = formulation.months_used < 12
      ? (" (based on " + formulation.months_used + " month" + (formulation.months_used === 1 ? "" : "s") + " of billing history)")
      : "";

    if (formulation.category === "Commercial") {
      var tb = formulation.tariff_breakdown;
      var sizeReason = formulation.sized_by_sanctioned_load
        ? ("capped at your sanctioned load of " + formulation.sanctioned_load_kw + " kW — your annual usage alone would " +
           "support a larger system, but your grid connection is the limiting factor.")
        : ("we round up to " + formulation.offered_kwp + " kWp so the system fully covers that usage, within your " +
           "sanctioned load of " + formulation.sanctioned_load_kw + " kW.");
      return {
        cardA: {
          title: "1 · System size -> " + formulation.offered_kwp + " kWp",
          body: "Commercial meters usually don't split usage by time of day, so we assume about " +
            formulation.solar_hour_share_pct + "% of your annual usage" + monthsNote +
            " happens when solar can supply it. That works out to " + formulation.required_kwp_exact.toFixed(2) +
            " kWp of load; " + sizeReason
        },
        cardB: {
          title: "2 · Per-unit value -> ₹" + formulation.effective_tariff.toFixed(2) + "/unit",
          body: "Built bottom-up from your tariff: base energy ₹" + tb.energy_rate.toFixed(2) +
            " + wheeling ₹" + tb.wheeling.toFixed(2) + " + FAC ₹" + tb.fac.toFixed(2) +
            " + duty " + tb.electricity_duty_pct +
            "% (₹" + tb.duty_per_unit.toFixed(2) + ") + tax-on-sale ₹" + tb.tax_on_sale.toFixed(2) +
            " - ToD rebate " + tb.tod_rebate_pct + "% (₹" + tb.tod_rebate_per_unit.toFixed(2) +
            ") - Grid Support Charge ₹" + tb.grid_support_charge.toFixed(2) + " = ₹" +
            formulation.effective_tariff.toFixed(2) + "/unit — the real value each solar unit offsets."
        }
      };
    }

    var itb = formulation.tariff_breakdown;
    var windowLabel = formulation.daytime_window === "09-17" ? "09:00-17:00" : "06:00-17:00";
    var pct = Math.round(formulation.daytime_fraction * 100);
    var todTerm = itb.daytime_tod_rate < 0
      ? ("- daytime ToD rebate ₹" + Math.abs(itb.daytime_tod_rate).toFixed(2))
      : ("+ daytime ToD charge ₹" + itb.daytime_tod_rate.toFixed(2));
    return {
      cardA: {
        title: "1 · System size -> " + formulation.offered_kwp + " kWp",
        body: "Solar only produces during the " + windowLabel + " window — about " + pct +
          "% of your annual usage" + monthsNote + ". Your load needs " +
          formulation.required_kwp_exact.toFixed(2) + " kWp for full daytime cover; we round up to " +
          formulation.offered_kwp + " kWp so the system fully meets daytime demand, with a little headroom."
      },
      cardB: {
        title: "2 · Per-unit value -> ₹" + formulation.effective_tariff.toFixed(2) + "/unit",
        body: "Built bottom-up from your tariff: base energy ₹" + itb.energy_rate.toFixed(2) +
          " + wheeling ₹" + itb.wheeling_per_unit.toFixed(2) + " + FAC ₹" + itb.fac.toFixed(2) +
          " + duty ₹" + itb.electricity_duty.toFixed(2) + " + tax-on-sale ₹" + itb.tax_on_sale.toFixed(2) +
          " " + todTerm + " - Grid Support Charge ₹" + itb.gsc.toFixed(2) + " = ₹" +
          formulation.effective_tariff.toFixed(2) + "/unit — the real value each solar unit offsets, net of the ToD rebate and the GSC."
      }
    };
  }

  function drawTechnicalSnapshotTable(doc, y, lock, config, m) {
    var inr = window.RiteEngine.inr;
    var rows = [
      ["Plant capacity", lock.size + " kWp (DC)"],
      ["Modules", "Bifacial, ~580 Wp (~" + Math.round(lock.size * 1000 / 580) + " panels)"],
      ["Inverter", "String inverter, " + Math.round(lock.size) + " kW class"],
      ["Annual generation", "~" + Math.round(lock.size * lock.gen * config.days).toLocaleString("en-IN") + " units"],
      ["Capital outlay (incl. GST)", inr(m.netCost)],
      ["Net capital (ex-GST, ITC)", inr(m.exGst)],
      ["Metering", "Net metering (bidirectional)"],
      ["Warranty", "Modules 25-yr perf. / Inverter 5-10 yr"]
    ];
    doc.autoTable({
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      theme: "striped",
      alternateRowStyles: { fillColor: GRAY },
      styles: { font: FONT_FAMILY, fontSize: 9.5, cellPadding: 4 },
      columnStyles: {
        0: { textColor: MUTED },
        1: { halign: "right", fontStyle: "bold", textColor: NAVY }
      },
      body: rows
    });
    return doc.lastAutoTable.finalY + 20;
  }

  function drawFinancedPanel(doc, y, stdScenario, stdM) {
    var inr = window.RiteEngine.inr, inrShort = window.RiteEngine.inrShort;
    var netEarnFin = stdM.rows.reduce(function (a, r) { return a + r.finNet; }, 0);
    var stats = [
      { label: "Your cash in (" + stdScenario.dp + "% down + fees)", value: inrShort(stdM.downPay + stdM.procFee) },
      { label: "Bank loan @ " + stdScenario.rate + "% / " + stdScenario.ten + " months", value: inrShort(stdM.loanAmt) },
      { label: "Monthly EMI", value: inr(stdM.emi) },
      { label: "Monthly solar saving (Yr 1)", value: inr(stdM.rows[0].oper / 12) },
      { label: "Return on your cash (levered IRR)", value: stdM.finIrr != null ? (stdM.finIrr * 100).toFixed(1) + "%" : "—", highlight: true },
      { label: "Net earnings / 25 yrs (financed)", value: inrShort(netEarnFin) }
    ];

    var tenureYears = Math.round(stdScenario.ten / 12);
    var monthlySaving = stdM.rows[0].oper / 12;
    var coversPhrase = monthlySaving >= stdM.emi
      ? ("covers the EMI (" + inr(stdM.emi) + "/mo) with cash to spare")
      : ("covers most of the EMI (" + inr(stdM.emi) + "/mo)");
    var finIrrRounded = stdM.finIrr != null ? Math.round(stdM.finIrr * 100) : null;
    var paraText = "A small down payment, with the loan serviced by your solar savings. In Year 1 the saving (" +
      inr(monthlySaving) + "/mo) " + coversPhrase + "; the loan clears in Year " + tenureYears +
      ", after which the full savings stream is yours." +
      (finIrrRounded != null ? (" Return on your own capital is about " + finIrrRounded + "%.") : "");

    var padX = 16, padTop = 18, rowGap = 32;
    var colW = contentW(doc) / 3;
    doc.setFont(FONT_FAMILY, "normal");
    doc.setFontSize(8.5);
    var lines = doc.splitTextToSize(paraText, contentW(doc) - padX * 2);
    var statsH = 2 * rowGap;
    var panelH = padTop + statsH + 14 + lines.length * 11 + 14;

    y = ensureSpace(doc, y, panelH + 10);

    setFill(doc, GRAY);
    doc.roundedRect(MARGIN, y, contentW(doc), panelH, 4, 4, "F");
    setFill(doc, GREEN);
    doc.rect(MARGIN, y + 2, 4, panelH - 4, "F");

    stats.forEach(function (s, i) {
      var col = i % 3, row = Math.floor(i / 3);
      var sx = MARGIN + padX + col * colW;
      var sy = y + padTop + row * rowGap + 12;
      doc.setFont(FONT_FAMILY, "bold");
      doc.setFontSize(13);
      setColor(doc, s.highlight ? GREEN : NAVY);
      doc.text(s.value, sx, sy);
      doc.setFont(FONT_FAMILY, "normal");
      doc.setFontSize(7.5);
      setColor(doc, MUTED);
      doc.text(s.label, sx, sy + 12, { maxWidth: colW - 10 });
    });

    var py = y + padTop + statsH + 16;
    doc.setFont(FONT_FAMILY, "normal");
    doc.setFontSize(8.5);
    setColor(doc, TEXT);
    doc.text(lines, MARGIN + padX, py);

    return y + panelH;
  }

  // ---------------------------------------------------------------- page 3
  function build25YearRowsAllCash(rows) {
    var fmt = function (x) { return Math.round(x).toLocaleString("en-US"); };
    var body = [], raw = [];
    rows.forEach(function (r) {
      body.push([
        r.y, r.rate.toFixed(2), Math.round(r.gen).toLocaleString("en-US"),
        fmt(r.gross), fmt(r.amc), fmt(r.depBen), fmt(r.net), fmt(r.cum)
      ]);
      raw.push({ net: r.net, cum: r.cum });
    });
    return { body: body, raw: raw };
  }

  function drawCashFlowTable(doc, y, allCashM) {
    var schedule = build25YearRowsAllCash(allCashM.rows);
    doc.autoTable({
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      theme: "striped",
      alternateRowStyles: { fillColor: GRAY },
      head: [["Yr", "Rate", "Units", "Gross Saving", "AMC", "Dep. Benefit", "Net Cash Flow", "Cumulative"]],
      body: schedule.body,
      styles: { font: FONT_FAMILY, fontSize: 9, cellPadding: 4, halign: "right" },
      headStyles: { font: FONT_FAMILY, fillColor: NAVY, textColor: WHITE, fontSize: 9.5, halign: "right" },
      columnStyles: { 0: { halign: "center" } },
      didParseCell: function (data) {
        if (data.section !== "body") return;
        var raw = schedule.raw[data.row.index];
        if (!raw) return;
        if (data.column.index === 6) {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.textColor = raw.net < 0 ? RED : GREEN;
        } else if (data.column.index === 7 && raw.cum < 0) {
          data.cell.styles.textColor = RED;
        }
      }
    });
    return doc.lastAutoTable.finalY + 18;
  }

  function stampFooters(doc, companyName) {
    var pageCount = doc.internal.getNumberOfPages();
    var bandH = 26;
    for (var i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      var pw = pageW(doc), ph = pageH(doc);
      setFill(doc, DEEP);
      doc.rect(0, ph - bandH, pw, bandH, "F");
      doc.setFont(FONT_FAMILY, "normal");
      doc.setFontSize(8);
      setColor(doc, WHITE);
      doc.text("Rite Solar · Powering Homes the Right Way", MARGIN, ph - bandH / 2 + 3);
      doc.text("Investment Memorandum · " + companyName + " · Page " + i, pw - MARGIN, ph - bandH / 2 + 3, { align: "right" });
    }
  }

  /**
   * @param {object} ctx
   *   companyName, category, consumerNumber (nullable),
   *   formulation, config, lock, scenario, m (unused by this layout — kept
   *   for backward compatibility with the caller), scenarioKey/charts
   *   (also unused by this layout — see file header for why)
   * @returns {Promise<Blob>} resolves with the PDF's bytes as a Blob, AFTER
   *   the browser download has already been triggered.
   */
  function buildAndDownload(ctx) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      return Promise.reject(new Error("the PDF library didn't load — check your connection and try again"));
    }

    return Promise.all([
      loadImage(LOGO_URL),
      loadImage(ADVISOR_URL).catch(function () { return null; }),
      loadFontBase64(FONT_REGULAR_URL),
      loadFontBase64(FONT_BOLD_URL)
    ]).then(function (loaded) {
      var logoImg = loaded[0], advisorImg = loaded[1], regularB64 = loaded[2], boldB64 = loaded[3];
      var advisorData = advisorImg ? downscaleToDataUrl(advisorImg, 480) : null;

      var doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
      registerFonts(doc, regularB64, boldB64);

      var lock = ctx.lock, config = ctx.config, scenario = ctx.scenario, formulation = ctx.formulation;
      var RiteEngine = window.RiteEngine;

      var allCashScenario = Object.assign({}, scenario, { loan: false });
      var allCashM = RiteEngine.compute(lock, config, allCashScenario);

      var depDefault = formulation.category === "Commercial" ? config.dep_default_commercial : config.dep_default;
      var stdFinScenario = {
        dep: depDefault, tax: config.tax_default, loan: true,
        dp: config.dp_default, rate: config.loan_rate_default,
        ten: config.tenure_months_default, fd: config.fd_rate_default
      };
      var stdFinM = RiteEngine.compute(lock, config, stdFinScenario);

      // ---------------------------------------------------------- page 1
      drawHeroBand(doc, ctx, logoImg, advisorData, allCashM, lock);
      var y = drawKpiChips(doc, HERO_CHIP_Y, [
        { label: "Annual Return (IRR)", value: allCashM.irrV != null ? (allCashM.irrV * 100).toFixed(1) + "%" : "—" },
        { label: "Solar Cost / Unit", value: "₹" + allCashM.lcoe.toFixed(2) },
        { label: "Net Earnings / 25 yrs", value: RiteEngine.inrShort(allCashM.profit) },
        { label: "Money Multiple", value: allCashM.multiple.toFixed(1) + "x" },
        { label: "Capital Recovered", value: (allCashM.payback != null ? allCashM.payback.toFixed(1) : "—") + " yrs" }
      ]);
      y += 8;
      setFill(doc, YELLOW);
      doc.rect(0, y, pageW(doc), 5, "F");
      y += 5 + 24;

      y = drawCompareSection(doc, y, allCashM, config, scenario.fd);

      // ---------------------------------------------------------- page 2
      doc.addPage();
      y = drawTopBand(doc, logoImg, "The numbers behind the return");
      y = heading(doc, y, "Your capital, compounding for 25 years", 14);
      var cumulativeChart = renderCumulativeChartImage(allCashM.rows);
      y = drawChartImage(doc, y, cumulativeChart, 165);

      var cards = narrativeCards(formulation);
      y = drawExplainerCards(doc, y, cards.cardA, cards.cardB);
      y += 16;

      y = heading(doc, y, "Technical snapshot", 14);
      y = drawTechnicalSnapshotTable(doc, y, lock, config, allCashM);

      y = heading(doc, y, "Financed option — " + stdFinScenario.dp + "% down payment (standard scenario)", 14);
      y = drawFinancedPanel(doc, y, stdFinScenario, stdFinM);

      // ---------------------------------------------------------- page 3
      doc.addPage();
      y = drawTopBand(doc, logoImg, "25-year cash-flow schedule");
      doc.setFont(FONT_FAMILY, "normal");
      doc.setFontSize(9.5);
      setColor(doc, MUTED);
      doc.text("All-cash (no-loan) case — the financed " + stdFinScenario.dp +
        "% down-payment scenario is on page 2.", MARGIN, y);
      y += 18;
      y = drawCashFlowTable(doc, y, allCashM);

      doc.setFont(FONT_FAMILY, "normal");
      doc.setFontSize(8);
      setColor(doc, MUTED);
      doc.text(doc.splitTextToSize(
        "This tool gives an illustrative estimate only and is not a binding quotation.",
        contentW(doc)
      ), MARGIN, y);

      stampFooters(doc, ctx.companyName || "Customer");

      var filename = "Rite-Solar-Estimate-" + slug(ctx.companyName) + ".pdf";
      doc.save(filename);
      return doc.output("blob");
    });
  }

  window.RiteReport = { buildAndDownload: buildAndDownload };
})();
