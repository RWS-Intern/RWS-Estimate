(function () {
  "use strict";

  // Field metadata drives building the form, populating it from the loaded
  // config, validating it, and collecting it back into a config object —
  // one source of truth instead of four places to keep in sync. Grouping
  // and field list match backend_and_admin.md's admin-page spec exactly
  // (plus `years`, added to the seed set during the engine-integration
  // task — see SPEC.md).
  var FIELD_GROUPS = [
    {
      title: "Pricing & tax",
      fields: [
        { key: "rate_per_kwp", label: "Price per kWp", hint: "Rs per kWp, ex-GST", type: "number", min: 0 },
        { key: "gst_rate", label: "GST rate", hint: "fraction, e.g. 0.089 = 8.9%", type: "fraction" },
        { key: "proc_fee_pct", label: "Loan processing fee", hint: "fraction of loan amount, e.g. 0.01 = 1%", type: "fraction" }
      ]
    },
    {
      title: "Generation & sizing",
      fields: [
        { key: "gen_per_kwp_day", label: "Generation per kWp", hint: "units/kWp/day, Year 1 before degradation", type: "number", min: 0 },
        { key: "days", label: "Days per year", hint: "used in the annual generation math", type: "number", min: 1, integer: true },
        { key: "daytime_window", label: "Daytime window", hint: "the ToD window used to size every plant — must match the confirm-screen prose", type: "select", options: ["06-17", "09-17"] },
        { key: "years", label: "Projection horizon", hint: "years — length of the 25-year cash-flow table", type: "number", min: 1, integer: true }
      ]
    },
    {
      title: "Degradation & O&M",
      fields: [
        { key: "deg_y1", label: "Year-1 degradation", hint: "fraction, e.g. 0.03 = 3% first-year output drop", type: "fraction" },
        { key: "deg_yr", label: "Annual degradation (Year 2+)", hint: "fraction per year, e.g. 0.0071 = 0.71%/yr", type: "fraction" },
        { key: "amc_rate_per_kwp", label: "AMC rate", hint: "Rs per kWp per year", type: "number", min: 0 },
        { key: "amc_esc", label: "AMC escalation", hint: "fraction per year, e.g. 0.01 = 1%/yr", type: "fraction" },
        { key: "spares_on", label: "Spares & replacements included", hint: "turns the spares cost line in the 25-year table on/off", type: "bool" },
        { key: "spares_rate_per_kwp", label: "Spares rate", hint: "Rs per kWp", type: "number", min: 0 },
        { key: "spares_base_rate", label: "Spares base rate", hint: "Rs, flat component of the spares cost", type: "number", min: 0 }
      ]
    },
    {
      title: "Tariff & finance",
      fields: [
        { key: "gsc", label: "Grid Support Charge (GSC)", hint: "Rs/unit — fixed value, not read off the customer's bill", type: "number" },
        { key: "tariff_esc", label: "Tariff escalation", hint: "fraction per year, e.g. 0.03 = 3%/yr", type: "fraction" },
        { key: "discount", label: "Discount rate", hint: "fraction, used for NPV, e.g. 0.12 = 12%", type: "fraction" },
        { key: "int_surplus", label: "Surplus interest rate", hint: "fraction, interest earned on surplus cash, e.g. 0.045 = 4.5%", type: "fraction" },
        { key: "dep_rate", label: "Depreciation rate (WDV)", hint: "fraction, e.g. 0.40 = 40% written-down-value", type: "fraction" },
        { key: "dep_years", label: "Depreciation years", hint: "years the WDV schedule runs for", type: "number", min: 1, integer: true }
      ]
    },
    {
      title: "Dashboard slider defaults",
      fields: [
        { key: "dep_default", label: "Depreciation benefit ON by default", hint: "starting position of the dashboard's depreciation toggle", type: "bool" },
        { key: "tax_default", label: "Default tax rate", hint: "%, starting position of the tax-rate slider", type: "number", min: 0, max: 100 },
        { key: "loan_default", label: "Loan financing ON by default", hint: "starting position of the dashboard's loan toggle", type: "bool" },
        { key: "dp_default", label: "Default down payment", hint: "%, starting position of the down-payment slider", type: "number", min: 0, max: 100 },
        { key: "loan_rate_default", label: "Default loan rate", hint: "% p.a., starting position of the loan-rate slider", type: "number", min: 0 },
        { key: "tenure_months_default", label: "Default loan tenure", hint: "months, starting position of the tenure slider", type: "number", min: 1, integer: true },
        { key: "fd_rate_default", label: "Default FD rate", hint: "% p.a., starting position of the FD-rate slider (comparison benchmark)", type: "number", min: 0 }
      ]
    },
    {
      title: "Comparison rates",
      fields: [
        { key: "bond_rate", label: "Corporate bond rate", hint: "fraction, e.g. 0.08 = 8% — shown on the 'vs other investments' chart", type: "fraction" },
        { key: "savings_rate", label: "Savings account rate", hint: "fraction, e.g. 0.035 = 3.5%", type: "fraction" },
        { key: "equity_rate", label: "Equity market rate", hint: "fraction, e.g. 0.12 = 12% — context only, equity carries market risk", type: "fraction" }
      ]
    },
    {
      title: "Commercial",
      fields: [
        { key: "solar_hour_share_pct", label: "Solar-hour usage share", hint: "%, 0-100 — commercial meters don't split ToD, so this replaces industrial's measured daytime fraction", type: "number", min: 0, max: 100 },
        { key: "gst_pct_commercial", label: "GST rate (commercial)", hint: "%, e.g. 8.9 = 8.9% — a percent NUMBER, not a fraction like the industrial GST rate above", type: "number", min: 0, max: 100 },
        { key: "dep_default_commercial", label: "Depreciation benefit ON by default (commercial)", hint: "starting position of the dashboard's depreciation toggle for a commercial customer — defaults OFF, separate from industrial's dep_default", type: "bool" },
        { key: "commercial_rate_table", label: "Price per kWp lookup table", hint: "JSON array of {\"kwp\":threshold,\"rate\":Rs per kWp}, sorted ascending — the highest threshold at or below the sized system's kWp wins", type: "json" }
      ]
    }
  ];

  var cfg = window.RiteAdminConfig || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.indexOf("REPLACE_ME") === 0) {
    // Fails loud in the console, not the UI — misconfiguration here would
    // otherwise just look like "sign in silently does nothing."
    console.error("admin/config.js is not configured — set SUPABASE_ANON_KEY.");
  }
  var sb = window.supabase.createClient(cfg.SUPABASE_URL || "", cfg.SUPABASE_ANON_KEY || "");

  var loginSection = document.getElementById("loginSection");
  var panelSection = document.getElementById("panelSection");
  var loginForm = document.getElementById("loginForm");
  var loginError = document.getElementById("loginError");
  var loginBtn = document.getElementById("loginBtn");
  var whoEmail = document.getElementById("whoEmail");
  var logoutBtn = document.getElementById("logoutBtn");
  var configFormEl = document.getElementById("configForm");
  var loadError = document.getElementById("loadError");
  var saveBtn = document.getElementById("saveBtn");
  var saveToast = document.getElementById("saveToast");
  var updatedNote = document.getElementById("updatedNote");

  function showLogin() {
    panelSection.classList.remove("active");
    loginSection.classList.add("active");
  }
  function showPanel() {
    loginSection.classList.remove("active");
    panelSection.classList.add("active");
  }

  function noteEl(cls, text) {
    var d = document.createElement("div");
    d.className = cls ? ("note " + cls) : "note";
    d.textContent = text;
    return d;
  }

  // --------------------------------------------------------- build the form
  function buildField(f) {
    if (f.type === "bool") {
      var row = document.createElement("div");
      row.className = "toggle-row admin-bool";

      var textWrap = document.createElement("div");
      var title = document.createElement("div");
      title.textContent = f.label;
      var hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = f.hint;
      textWrap.appendChild(title);
      textWrap.appendChild(hint);

      var switchLabel = document.createElement("label");
      switchLabel.className = "switch";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.id = "cfg-" + f.key;
      var slider = document.createElement("span");
      slider.className = "slider";
      switchLabel.appendChild(input);
      switchLabel.appendChild(slider);

      row.appendChild(textWrap);
      row.appendChild(switchLabel);
      return row;
    }

    var wrap = document.createElement("div");
    wrap.className = "field";
    var lbl = document.createElement("label");
    lbl.setAttribute("for", "cfg-" + f.key);
    lbl.textContent = f.label;
    wrap.appendChild(lbl);

    var el;
    if (f.type === "select") {
      el = document.createElement("select");
      el.id = "cfg-" + f.key;
      f.options.forEach(function (opt) {
        var o = document.createElement("option");
        o.value = opt;
        o.textContent = opt === "06-17" ? "06:00–17:00" : "09:00–17:00";
        el.appendChild(o);
      });
    } else if (f.type === "json") {
      el = document.createElement("textarea");
      el.id = "cfg-" + f.key;
      el.rows = 6;
      el.className = "admin-json-field";
    } else {
      el = document.createElement("input");
      el.type = "number";
      el.step = "any";
      el.id = "cfg-" + f.key;
    }
    wrap.appendChild(el);

    var hintEl = document.createElement("div");
    hintEl.className = "hint";
    hintEl.textContent = f.hint;
    wrap.appendChild(hintEl);

    return wrap;
  }

  function buildForm() {
    configFormEl.innerHTML = "";
    FIELD_GROUPS.forEach(function (group) {
      var g = document.createElement("div");
      g.className = "admin-group";

      var label = document.createElement("div");
      label.className = "section-label";
      label.textContent = group.title;
      g.appendChild(label);

      var grid = document.createElement("div");
      grid.className = "grid2";
      group.fields.forEach(function (f) {
        var el = buildField(f);
        if (f.type === "bool" || f.type === "json") {
          g.appendChild(el); // full-width row — a toggle, or a multi-line JSON textarea
        } else {
          grid.appendChild(el);
        }
      });
      if (grid.children.length) g.appendChild(grid);

      configFormEl.appendChild(g);
    });
  }

  function populateForm(config) {
    FIELD_GROUPS.forEach(function (group) {
      group.fields.forEach(function (f) {
        var el = document.getElementById("cfg-" + f.key);
        var v = config[f.key];
        if (f.type === "bool") {
          el.checked = !!v;
        } else if (f.type === "json") {
          el.value = (v === undefined || v === null) ? "" : JSON.stringify(v, null, 2);
        } else {
          el.value = (v === undefined || v === null) ? "" : v;
        }
      });
    });
  }

  /** Numbers are numbers; fractions land in 0-1; daytime_window is one of
   *  the two allowed values — per backend_and_admin.md's admin-page spec. */
  function validateAndCollect() {
    var config = {};
    var errors = [];
    FIELD_GROUPS.forEach(function (group) {
      group.fields.forEach(function (f) {
        var el = document.getElementById("cfg-" + f.key);
        if (f.type === "bool") { config[f.key] = el.checked; return; }
        if (f.type === "select") {
          if (f.options.indexOf(el.value) === -1) { errors.push(f.label + " must be one of: " + f.options.join(", ") + "."); return; }
          config[f.key] = el.value;
          return;
        }
        if (f.type === "json") {
          var parsed;
          try {
            parsed = JSON.parse(el.value);
          } catch (e) {
            errors.push(f.label + " must be valid JSON.");
            return;
          }
          if (!Array.isArray(parsed) || !parsed.every(function (row) {
            return row && typeof row === "object" && typeof row.kwp === "number" && typeof row.rate === "number";
          })) {
            errors.push(f.label + " must be a JSON array of {\"kwp\":number,\"rate\":number} objects.");
            return;
          }
          config[f.key] = parsed;
          return;
        }
        var raw = el.value.trim();
        var n = parseFloat(raw);
        if (raw === "" || isNaN(n) || !isFinite(n)) { errors.push(f.label + " must be a number."); return; }
        if (f.integer && Math.round(n) !== n) { errors.push(f.label + " must be a whole number."); return; }
        if (f.type === "fraction" && (n < 0 || n > 1)) { errors.push(f.label + " must be between 0 and 1 (it's a fraction, e.g. 0.089 = 8.9%)."); return; }
        if (f.min !== undefined && n < f.min) { errors.push(f.label + " must be at least " + f.min + "."); return; }
        if (f.max !== undefined && n > f.max) { errors.push(f.label + " must be at most " + f.max + "."); return; }
        config[f.key] = n;
      });
    });
    return { config: config, errors: errors };
  }

  // --------------------------------------------------------------- load/save
  function loadConfig() {
    loadError.innerHTML = "";
    return sb.from("app_config").select("config, updated_at").eq("id", 1).single().then(function (res) {
      if (res.error || !res.data || typeof res.data.config !== "object") {
        loadError.appendChild(noteEl("error", "Couldn't load the current settings" + (res.error ? (": " + res.error.message) : ".") + " Try reloading the page."));
        return;
      }
      populateForm(res.data.config);
      updatedNote.textContent = res.data.updated_at ? ("Last updated " + new Date(res.data.updated_at).toLocaleString()) : "";
    }).catch(function (err) {
      loadError.appendChild(noteEl("error", "Couldn't load the current settings: " + err.message));
    });
  }

  function saveConfig() {
    saveToast.innerHTML = "";
    var result = validateAndCollect();
    if (result.errors.length) {
      saveToast.appendChild(noteEl("error", result.errors.join(" ")));
      return;
    }
    saveBtn.disabled = true;
    sb.from("app_config").update({ config: result.config, updated_at: new Date().toISOString() }).eq("id", 1).select().single()
      .then(function (res) {
        saveBtn.disabled = false;
        if (res.error) {
          saveToast.appendChild(noteEl("error", "Save failed: " + res.error.message));
          return;
        }
        saveToast.appendChild(noteEl(null, "Saved. New estimates will use these values immediately."));
        if (res.data && res.data.updated_at) {
          updatedNote.textContent = "Last updated " + new Date(res.data.updated_at).toLocaleString();
        }
      })
      .catch(function (err) {
        saveBtn.disabled = false;
        saveToast.appendChild(noteEl("error", "Save failed: " + err.message));
      });
  }

  saveBtn.addEventListener("click", saveConfig);

  // ------------------------------------------------------------------- leads
  // "Leads" tab: a read-only view of the 'submissions' table (RLS grants
  // `authenticated` SELECT only — see backend_and_admin.md — so this table
  // can never be written to from here even by accident) plus an Excel
  // export. One column list drives the on-screen table AND the export, so
  // they can't drift apart; only the underlying VALUE differs between them
  // (display() formats for reading on screen, the export writes raw numbers
  // with native Excel number/percent formats instead of pre-built strings).
  var LEADS_COLUMNS = [
    { key: "date", label: "Date" },
    { key: "company", label: "Company" },
    { key: "mobile", label: "Mobile" },
    { key: "category", label: "Category" },
    { key: "stage", label: "Stage" },
    { key: "offered_kwp", label: "Offered kWp", num: true },
    { key: "effective_tariff", label: "Effective tariff (₹/unit)", num: true },
    { key: "irr", label: "IRR (%)", num: true },
    { key: "payback_years", label: "Payback (yrs)", num: true },
    { key: "net_capital", label: "Net capital (₹)", num: true },
    { key: "bill_path", label: "Bill file (front)", file: "bills" },
    { key: "bill_path_back", label: "Bill file (back)", file: "bills" },
    { key: "report_path", label: "Report file", file: "reports" }
  ];

  var leadsError = document.getElementById("leadsError");
  var leadsBody = document.getElementById("leadsBody");
  var leadsCount = document.getElementById("leadsCount");
  var downloadLeadsBtn = document.getElementById("downloadLeadsBtn");
  var currentLeads = [];
  var leadsLoadedOnce = false;

  function numOrNull(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }

  /** {bills,reports}/{submission_id}/{filename} -> just the filename, or
   *  null if the column is empty (an 'entered' lead never got a bill
   *  upload, or the report was never downloaded). */
  function filenameFromPath(path) {
    if (!path) return null;
    var parts = String(path).split("/");
    return parts[parts.length - 1] || path;
  }

  /** Flattens one submissions row (nested `computed` jsonb) into the flat
   *  shape both the table and the Excel export read from — RAW values only
   *  (e.g. irr as a 0-1 fraction, not "28.9%"); see displayCell()/
   *  downloadLeadsExcel() below for the two different ways each output
   *  presents them. bill_path/report_path are kept as their full raw
   *  path (not just the filename) — the on-screen table needs the full
   *  path to ask sign_url.php for a signed URL; the Excel export derives
   *  just the filename from it at export time instead (see below). A row
   *  with stage='entered' has computed=null — every computed.* field below
   *  just comes out null, same as any other missing value. */
  function flattenLead(row) {
    var computed = row.computed || {};
    return {
      date: row.created_at ? new Date(row.created_at) : null,
      company: row.company_name || "",
      mobile: row.mobile || "",
      category: row.category || "",
      stage: row.stage || "",
      offered_kwp: numOrNull(computed.offered_kwp),
      effective_tariff: numOrNull(computed.effective_tariff),
      irr: numOrNull(computed.irr),
      payback_years: numOrNull(computed.payback_years),
      net_capital: numOrNull(computed.ex_gst_capital),
      bill_path: row.bill_path || null,
      bill_path_back: row.bill_path_back || null,
      report_path: row.report_path || null
    };
  }

  /** Fetches a short-lived signed URL for a private bill/report object via
   *  api/sign_url.php (server-side, service role key) and opens it in a
   *  new tab. Requires the admin's own currently-valid Supabase session —
   *  sign_url.php verifies the access token server-side before signing
   *  anything, so this can't be used to sign arbitrary paths from outside
   *  an active admin session. */
  function downloadSignedFile(bucket, path, btn) {
    var originalLabel = btn.textContent;
    leadsError.innerHTML = "";
    btn.disabled = true;
    btn.textContent = "Opening…";

    function reset() {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }

    sb.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (!session || !session.access_token) {
        throw new Error("Your admin session has expired — please sign in again.");
      }
      return fetch("/api/sign_url.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket: bucket, path: path, access_token: session.access_token })
      });
    }).then(function (res) {
      return res.json();
    }).then(function (json) {
      reset();
      if (!json || !json.success || !json.url) {
        leadsError.appendChild(noteEl("error", "Couldn't create a download link" + (json && json.error ? (": " + json.error) : ".")));
        return;
      }
      window.open(json.url, "_blank", "noopener");
    }).catch(function (err) {
      reset();
      leadsError.appendChild(noteEl("error", "Couldn't create a download link: " + err.message));
    });
  }

  /** Human-readable text for the on-screen table (bill_path/report_path are
   *  handled separately in renderLeadsTable() as Download buttons, not
   *  through here). */
  function displayCell(lead, key) {
    switch (key) {
      case "date":
        return lead.date ? (lead.date.toLocaleDateString("en-IN") + " " + lead.date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })) : "—";
      case "irr":
        return lead.irr != null ? (lead.irr * 100).toFixed(1) + "%" : "—";
      case "effective_tariff":
        return lead.effective_tariff != null ? "₹" + lead.effective_tariff.toFixed(2) : "—";
      case "payback_years":
        return lead.payback_years != null ? lead.payback_years.toFixed(1) : "—";
      case "net_capital":
        return lead.net_capital != null ? "₹" + Math.round(lead.net_capital).toLocaleString("en-IN") : "—";
      case "offered_kwp":
        return lead.offered_kwp != null ? String(lead.offered_kwp) : "—";
      default:
        var v = lead[key];
        return (v === null || v === undefined || v === "") ? "—" : String(v);
    }
  }

  function renderLeadsTable(leads) {
    leadsBody.innerHTML = "";
    if (!leads.length) {
      var tr0 = document.createElement("tr");
      var td0 = document.createElement("td");
      td0.colSpan = LEADS_COLUMNS.length;
      td0.textContent = "No submissions yet.";
      tr0.appendChild(td0);
      leadsBody.appendChild(tr0);
      return;
    }
    leads.forEach(function (lead) {
      var tr = document.createElement("tr");
      LEADS_COLUMNS.forEach(function (col) {
        var td = document.createElement("td");
        if (col.num) td.className = "num";
        if (col.file) {
          var path = lead[col.key];
          if (path) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "leads-dl-btn";
            btn.textContent = "Download";
            btn.addEventListener("click", function () { downloadSignedFile(col.file, path, btn); });
            td.appendChild(btn);
          } else {
            td.textContent = "—";
          }
        } else {
          td.textContent = displayCell(lead, col.key);
        }
        tr.appendChild(td);
      });
      leadsBody.appendChild(tr);
    });
  }

  function loadLeads() {
    leadsError.innerHTML = "";
    downloadLeadsBtn.disabled = true;
    var loadingRow = document.createElement("tr");
    var loadingCell = document.createElement("td");
    loadingCell.colSpan = LEADS_COLUMNS.length;
    loadingCell.textContent = "Loading…";
    loadingRow.appendChild(loadingCell);
    leadsBody.innerHTML = "";
    leadsBody.appendChild(loadingRow);

    return sb.from("submissions")
      .select("company_name, mobile, category, stage, computed, bill_path, bill_path_back, report_path, created_at")
      .order("created_at", { ascending: false })
      .then(function (res) {
        if (res.error) {
          leadsBody.innerHTML = "";
          leadsError.appendChild(noteEl("error", "Couldn't load submissions: " + res.error.message));
          return;
        }
        currentLeads = (res.data || []).map(flattenLead);
        renderLeadsTable(currentLeads);
        downloadLeadsBtn.disabled = currentLeads.length === 0;
        leadsCount.textContent = currentLeads.length + (currentLeads.length === 1 ? " submission" : " submissions");
      })
      .catch(function (err) {
        leadsBody.innerHTML = "";
        leadsError.appendChild(noteEl("error", "Couldn't load submissions: " + err.message));
      });
  }

  /** {bills,reports}/{submission_id}/{filename} -> just the filename, or ""
   *  if the column is empty (an 'entered' lead never got a bill upload, or
   *  the report was never downloaded). Only used for the Excel export — a
   *  signed URL is short-lived (SIGNED_URL_TTL_SECONDS server-side, 300s),
   *  so embedding one in a saved spreadsheet would just be a dead link by
   *  the time anyone opens the file; a stable filename label is what
   *  actually holds up there. The on-screen table gets a live "Download"
   *  button instead (see renderLeadsTable()/downloadSignedFile()). */
  function filenameFromPath(path) {
    if (!path) return "";
    var parts = String(path).split("/");
    return parts[parts.length - 1] || path;
  }

  /** Builds the .xlsx via SheetJS. Unlike the on-screen table, cells here
   *  hold the RAW numeric values with a native Excel number format (`z`)
   *  applied — IRR as an actual percentage cell, money/kWp/years as plain
   *  numbers — rather than pre-formatted display strings, so the numbers
   *  are usable for further calculation in Excel, not just readable. */
  function downloadLeadsExcel() {
    if (!currentLeads.length || !window.XLSX) return;

    var header = LEADS_COLUMNS.map(function (c) { return c.label; });
    var aoa = [header];
    currentLeads.forEach(function (lead) {
      aoa.push([
        lead.date ? lead.date.toLocaleString("en-IN") : "",
        lead.company, lead.mobile, lead.category, lead.stage,
        lead.offered_kwp, lead.effective_tariff, lead.irr, lead.payback_years, lead.net_capital,
        filenameFromPath(lead.bill_path), filenameFromPath(lead.bill_path_back), filenameFromPath(lead.report_path)
      ]);
    });

    var ws = window.XLSX.utils.aoa_to_sheet(aoa);

    // Column indices are 0-based and must match LEADS_COLUMNS' order above:
    // 5=offered_kwp, 6=effective_tariff, 7=irr, 8=payback_years, 9=net_capital.
    var colFormats = { 5: "0.00", 6: "0.00", 7: "0.0%", 8: "0.0", 9: "#,##0" };
    var range = window.XLSX.utils.decode_range(ws["!ref"]);
    for (var col in colFormats) {
      if (!colFormats.hasOwnProperty(col)) continue;
      var colIndex = Number(col);
      for (var r = 1; r <= range.e.r; r++) {
        var addr = window.XLSX.utils.encode_cell({ r: r, c: colIndex });
        if (ws[addr] && typeof ws[addr].v === "number") ws[addr].z = colFormats[col];
      }
    }
    ws["!cols"] = LEADS_COLUMNS.map(function (c) { return { wch: Math.max(12, c.label.length + 2) }; });

    var wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Leads");

    var d = new Date();
    var pad2 = function (n) { n = String(n); return n.length < 2 ? "0" + n : n; };
    var filename = "rite-solar-leads-" + d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + ".xlsx";
    window.XLSX.writeFile(wb, filename);
  }

  downloadLeadsBtn.addEventListener("click", downloadLeadsExcel);

  document.querySelectorAll(".tab[data-admintab]").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab[data-admintab]").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      var showLeads = tab.dataset.admintab === "leads";
      document.getElementById("adminPaneConfig").classList.toggle("active", !showLeads);
      document.getElementById("adminPaneLeads").classList.toggle("active", showLeads);
      if (showLeads && !leadsLoadedOnce) {
        leadsLoadedOnce = true;
        loadLeads();
      }
    });
  });

  // ------------------------------------------------------------------- auth
  function enterPanel(session) {
    whoEmail.textContent = (session && session.user && session.user.email) || "";
    showPanel();
    buildForm();
    loadConfig();
  }

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    loginError.innerHTML = "";
    var email = document.getElementById("in-email").value.trim();
    var password = document.getElementById("in-password").value;
    if (!email || !password) {
      loginError.appendChild(noteEl("error", "Enter both email and password."));
      return;
    }
    loginBtn.disabled = true;
    sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
      loginBtn.disabled = false;
      if (res.error) {
        loginError.appendChild(noteEl("error", "Sign-in failed: " + res.error.message));
        return;
      }
      enterPanel(res.data.session);
    }).catch(function (err) {
      loginBtn.disabled = false;
      loginError.appendChild(noteEl("error", "Sign-in failed: " + err.message));
    });
  });

  logoutBtn.addEventListener("click", function () {
    sb.auth.signOut().then(function () {
      document.getElementById("in-password").value = "";
      showLogin();
    });
  });

  // Auto-restore an existing session (supabase-js persists it in
  // localStorage) so refreshing the page doesn't force signing in again.
  sb.auth.getSession().then(function (res) {
    var session = res.data && res.data.session;
    if (session) {
      enterPanel(session);
    } else {
      showLogin();
    }
  }).catch(function () {
    showLogin();
  });
})();
