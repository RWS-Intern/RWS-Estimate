(function () {
  "use strict";

  var TOD_SLOTS = [
    { key: "t00_06", label: "00:00–06:00" },
    { key: "t06_09", label: "06:00–09:00" },
    { key: "t09_17", label: "09:00–17:00" },
    { key: "t17_24", label: "17:00–24:00" }
  ];
  var HISTORY_MONTHS = 12;

  // Client always ends up sending one or more IMAGES to the endpoint — see
  // extraction_hardening.md. A photo upload is a single image; a PDF is
  // rendered page-by-page via pdf.js (MSEDCL bills spread billing details,
  // ToD slots, and history across multiple pages — page 1 alone is mostly
  // header/summary). Neither the server nor a classic OCR pass ever has to
  // deal with a raw scanned PDF.
  var RAW_FILE_MAX_BYTES = 20 * 1024 * 1024; // sanity cap before we touch the file at all
  var MAX_IMAGE_BYTES = 6 * 1024 * 1024;     // matches api/extract.php's per-image limit
  var IMAGE_LONG_EDGE = 1600;
  var IMAGE_JPEG_QUALITY = 0.85;
  var PDF_RENDER_DPI = 220;      // within the ~200-300dpi range extraction_hardening.md asks for
  var PDF_RENDER_MAX_DIM = 2200; // guard against unusually large page sizes
  var PDF_MAX_PAGES = 8;         // sanity cap — real MSEDCL bills run 2-4 pages
  var PDF_WORKER_SRC = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  }

  // ---------------------------------------------------------------- steps
  function showStep(id) {
    document.querySelectorAll(".step").forEach(function (el) {
      el.classList.toggle("active", el.id === id);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ------------------------------------------------------------- entry form
  var entryForm = document.getElementById("entryForm");
  var nameInput = document.getElementById("in-name");
  var mobileInput = document.getElementById("in-mobile");
  var billInput = document.getElementById("in-bill");
  var uploadBox = document.getElementById("uploadBox");
  var fileNameEl = document.getElementById("fileName");
  var submitBtn = document.getElementById("submitBtn");
  var billErrMsgEl = document.querySelector("#f-bill .errmsg");
  var DEFAULT_BILL_ERR = billErrMsgEl.textContent;

  // Tracks the Supabase submissions row for the customer currently moving
  // through entry -> extract -> confirm. idPromise resolves to the row id,
  // or null if lead.php never got a row created (Supabase down/misconfigured,
  // or the request itself failed) — every persistence call downstream treats
  // a null id as "skip, nothing to attach this to" rather than an error.
  var currentSubmission = { idPromise: null };

  mobileInput.addEventListener("input", function () {
    mobileInput.value = mobileInput.value.replace(/\D/g, "").slice(0, 10);
  });

  document.querySelectorAll('input[name="category"]').forEach(function (r) {
    r.addEventListener("change", function () {
      document.getElementById("lbl-commercial").classList.toggle("checked", r.value === "Commercial" && r.checked);
      document.getElementById("lbl-industrial").classList.toggle("checked", r.value === "Industrial" && r.checked);
      clearError("f-category");
    });
  });

  uploadBox.addEventListener("click", function () { billInput.click(); });
  ["dragover", "dragenter"].forEach(function (evt) {
    uploadBox.addEventListener(evt, function (e) { e.preventDefault(); uploadBox.classList.add("drag"); });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    uploadBox.addEventListener(evt, function (e) { e.preventDefault(); uploadBox.classList.remove("drag"); });
  });
  uploadBox.addEventListener("drop", function (e) {
    var files = e.dataTransfer.files;
    if (files && files.length) {
      billInput.files = files;
      onBillSelected();
    }
  });
  billInput.addEventListener("change", onBillSelected);

  function onBillSelected() {
    var f = billInput.files[0];
    fileNameEl.textContent = f ? f.name : "";
    clearError("f-bill");
  }

  function setError(fieldId, show) {
    var el = document.getElementById(fieldId);
    el.classList.toggle("has-err", !!show);
    var input = el.querySelector("input");
    if (input) input.classList.toggle("err", !!show);
  }
  function clearError(fieldId) {
    setError(fieldId, false);
    if (fieldId === "f-bill") billErrMsgEl.textContent = DEFAULT_BILL_ERR;
  }
  function setBillError(message) {
    billErrMsgEl.textContent = message;
    setError("f-bill", true);
  }

  function validateEntryForm() {
    var ok = true;

    if (!nameInput.value.trim()) { setError("f-name", true); ok = false; } else { clearError("f-name"); }

    if (!/^[0-9]{10}$/.test(mobileInput.value.trim())) { setError("f-mobile", true); ok = false; } else { clearError("f-mobile"); }

    var category = document.querySelector('input[name="category"]:checked');
    if (!category) { setError("f-category", true); ok = false; } else { clearError("f-category"); }

    var file = billInput.files[0];
    if (!file) {
      setError("f-bill", true); ok = false;
    } else {
      var okType = /\.(pdf|jpe?g|png)$/i.test(file.name) ||
        ["application/pdf", "image/jpeg", "image/png"].indexOf(file.type) !== -1;
      if (!okType) { setError("f-bill", true); ok = false; }
      else if (file.size > RAW_FILE_MAX_BYTES) {
        setBillError("That file is too large. Please upload a bill under 20 MB.");
        ok = false;
      } else { clearError("f-bill"); }
    }

    return ok;
  }

  // ---------------------------------------------------------- image helpers
  /** Encodes a canvas as JPEG, stepping down through quality levels until
   *  the blob fits under MAX_IMAGE_BYTES (or the last quality is reached). */
  function canvasToJpegFile(canvas, filename, qualities) {
    function attempt(i) {
      var q = qualities[i];
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error("could not encode the image")); return; }
          resolve(blob);
        }, "image/jpeg", q);
      }).then(function (blob) {
        if (blob.size <= MAX_IMAGE_BYTES || i === qualities.length - 1) {
          return new File([blob], filename, { type: "image/jpeg" });
        }
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  /** Photo upload: downscale long edge to ~1600px, JPEG ~0.85. */
  function downscaleImage(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        var longEdge = Math.max(w, h);
        var scale = longEdge > IMAGE_LONG_EDGE ? IMAGE_LONG_EDGE / longEdge : 1;
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        var newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
        canvasToJpegFile(canvas, newName, [IMAGE_JPEG_QUALITY, 0.65, 0.45]).then(resolve, reject);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("could not load that image")); };
      img.src = url;
    });
  }

  /** Renders one PDF page to a canvas at ~200-220dpi, capped so neither
   *  dimension exceeds PDF_RENDER_MAX_DIM, then encodes it as JPEG. */
  function renderPdfPageToImage(pdf, pageNum) {
    return pdf.getPage(pageNum).then(function (page) {
      var scale = PDF_RENDER_DPI / 72;
      var viewport = page.getViewport({ scale: scale });
      var longest = Math.max(viewport.width, viewport.height);
      if (longest > PDF_RENDER_MAX_DIM) {
        scale = scale * (PDF_RENDER_MAX_DIM / longest);
        viewport = page.getViewport({ scale: scale });
      }
      var canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      var ctx = canvas.getContext("2d");
      return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
        return canvasToJpegFile(canvas, "bill-page" + pageNum + ".jpg", [0.85, 0.7, 0.5]);
      });
    });
  }

  /** PDF upload: render EVERY page to its own image via pdf.js — MSEDCL
   *  bills spread the billing-details/ToD/history tables across multiple
   *  pages, so page 1 alone is not enough. Renders sequentially (not in
   *  parallel) to keep peak memory bounded on phones. This is also what
   *  lets a scanned/photographed PDF (no text layer) still reach the
   *  vision path — there is no server-side rasteriser. */
  function renderPdfPagesToImages(file) {
    if (!window.pdfjsLib) {
      return Promise.reject(new Error("PDF support didn't load — check your connection and try again"));
    }
    return file.arrayBuffer().then(function (buf) {
      return window.pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (pdf) {
      var pageCount = Math.min(pdf.numPages, PDF_MAX_PAGES);
      var images = [];
      function renderNext(pageNum) {
        if (pageNum > pageCount) return images;
        return renderPdfPageToImage(pdf, pageNum).then(function (imageFile) {
          images.push(imageFile);
          return renderNext(pageNum + 1);
        });
      }
      return renderNext(1);
    });
  }

  /** Always resolves to {imageFiles, pdfFile}. imageFiles has one entry per
   *  PDF page (or a single entry for a photo upload). pdfFile is non-null
   *  only when the original upload was a PDF (sent alongside the rendered
   *  images so the server can still try its free text-layer fast path). */
  function prepareUpload(file) {
    var isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
    var task = isPdf
      ? renderPdfPagesToImages(file).then(function (imageFiles) { return { imageFiles: imageFiles, pdfFile: file }; })
      : downscaleImage(file).then(function (imageFile) { return { imageFiles: [imageFile], pdfFile: null }; });
    return task.catch(function (err) {
      err.stage = "prepare";
      throw err;
    });
  }

  // ----------------------------------------------------------- persistence
  // Supabase persistence (SPEC.md "Persist to Supabase") is all
  // fire-and-forget from the UI's point of view — every call here is wrapped
  // so a Supabase outage never blocks or breaks the customer-facing flow.

  /** Fires right after the entry form validates, in parallel with
   *  extraction (not awaited) — captures the lead even if the customer
   *  never reaches confirm. Resolves to the new row id, or null on any
   *  failure. */
  function createLead(companyName, mobile, category) {
    var fd = new FormData();
    fd.append("company_name", companyName);
    fd.append("mobile", mobile);
    fd.append("category", category);
    return fetch("api/lead.php", { method: "POST", body: fd })
      .then(function (res) { return res.json(); })
      .then(function (json) { return (json && json.success && json.id) ? json.id : null; })
      .catch(function () { return null; });
  }

  /** Uploads the ORIGINAL bill file (not the downscaled/rendered images
   *  sent to extract.php) once extraction has succeeded. Silently no-ops if
   *  there's no lead row to attach it to. */
  function uploadBillFile(rawFile) {
    if (!currentSubmission.idPromise) return;
    currentSubmission.idPromise.then(function (id) {
      if (!id) return null;
      var fd = new FormData();
      fd.append("id", id);
      fd.append("bill_file", rawFile, rawFile.name);
      return fetch("api/upload_bill.php", { method: "POST", body: fd });
    }).catch(function (err) {
      console.warn("Bill upload failed (non-fatal):", err);
    });
  }

  /** Uploads the generated report PDF once it's already downloading in the
   *  browser. Silently no-ops (with a console note) if there's no lead row
   *  to attach it to. Unlike a bare fetch(), this actually reads the JSON
   *  response and logs it on failure — a fetch() only rejects on a network
   *  error, so a {"success":false} response (Supabase misconfigured, the
   *  'reports' bucket missing, etc — see api/upload_report.php's own
   *  error_log() calls for the exact reason) would otherwise pass silently. */
  function uploadReportFile(blob) {
    if (!currentSubmission.idPromise) {
      console.warn("Report upload skipped: no submission id was ever created for this session (lead.php never ran or was never awaited).");
      return;
    }
    currentSubmission.idPromise.then(function (id) {
      if (!id) {
        console.warn("Report upload skipped: lead.php never returned a submission id (Supabase down/misconfigured, or the insert failed).");
        return null;
      }
      var fd = new FormData();
      fd.append("id", id);
      fd.append("report_file", blob, "report.pdf");
      return fetch("api/upload_report.php", { method: "POST", body: fd })
        .then(function (res) { return res.json(); })
        .then(function (json) {
          if (!json || !json.success) {
            console.warn("Report upload failed (non-fatal) — check the server's PHP error log for the exact reason:", json && json.error ? json.error : json);
          }
        });
    }).catch(function (err) {
      console.warn("Report upload failed (non-fatal):", err);
    });
  }

  /** Fires after the dashboard has already rendered — updates the lead row
   *  with the confirmed extraction and the computed summary. Silently
   *  no-ops if there's no lead row to attach it to. */
  function persistCompletedSubmission(confirmed, formulation) {
    if (!currentSubmission.idPromise) return;
    currentSubmission.idPromise.then(function (id) {
      if (!id) return null;
      var m = RiteEngine.compute(dashState.lock, dashState.config, dashState.scenario);
      var computed = {
        offered_kwp: formulation.offered_kwp,
        effective_tariff: formulation.effective_tariff,
        annual_generation: formulation.annual_generation,
        ex_gst_capital: formulation.ex_gst_capital,
        irr: m.irrV,
        payback_years: m.payback,
        npv: m.npvV,
        lcoe: m.lcoe
      };
      var fd = new FormData();
      fd.append("id", id);
      fd.append("extracted", JSON.stringify(confirmed));
      fd.append("computed", JSON.stringify(computed));
      return fetch("api/complete.php", { method: "POST", body: fd });
    }).catch(function (err) {
      console.warn("Persisting the completed submission failed (non-fatal):", err);
    });
  }

  // --------------------------------------------------------------- submit
  entryForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!validateEntryForm()) return;

    var rawFile = billInput.files[0];
    // Kicked off now, awaited later (by uploadBillFile/persistCompletedSubmission)
    // — never blocks extraction, which is what actually gates the UI.
    currentSubmission.idPromise = createLead(
      nameInput.value.trim(), mobileInput.value.trim(),
      document.querySelector('input[name="category"]:checked').value
    );

    submitBtn.disabled = true;
    showStep("step-loading");

    prepareUpload(rawFile).then(function (result) {
      var fd = new FormData();
      fd.append("name", nameInput.value.trim());
      fd.append("mobile", mobileInput.value.trim());
      fd.append("category", document.querySelector('input[name="category"]:checked').value);
      // Array field name so PHP collects every page as $_FILES['bill_image'][...]
      // even when there's only one (a photo upload).
      result.imageFiles.forEach(function (f) { fd.append("bill_image[]", f, f.name); });
      if (result.pdfFile) fd.append("bill_pdf", result.pdfFile, result.pdfFile.name);
      return fetch("api/extract.php", { method: "POST", body: fd });
    }).then(function (res) {
      return res.json().catch(function () {
        throw new Error("The server returned an unexpected response.");
      });
    }).then(function (json) {
      submitBtn.disabled = false;
      if (json && json.success) {
        uploadBillFile(rawFile);
        renderConfirmForm(json.data, json.needs_review || {}, json.suggested_corrections || {}, json.quality || "ok", null);
      } else {
        renderConfirmForm(blankExtraction(), {}, {}, "poor",
          (json && json.error) || "We couldn't read this bill. Please fill in the values below manually.");
      }
      showStep("step-confirm");
    }).catch(function (err) {
      submitBtn.disabled = false;
      if (err && err.stage === "prepare") {
        // Couldn't even build an image client-side — stay on the entry step.
        showStep("step-entry");
        setBillError("We couldn't process that file in your browser (" + err.message +
          "). Please try a different file, or upload a photo instead.");
        return;
      }
      renderConfirmForm(blankExtraction(), {}, {}, "poor",
        "We couldn't read this bill (" + err.message + "). Please fill in the values below manually.");
      showStep("step-confirm");
    });
  });

  // ------------------------------------------------------------ confirm form
  function blankExtraction() {
    return {
      consumer_number: null, consumer_name: null, tariff_category: null,
      tariff_code: null, contract_demand_kva: null, sanctioned_load_kw: null,
      current_month: {
        total_units: null, energy_rate: null, demand_charge_per_unit: null,
        fac: null, electricity_duty: null, tax_on_sale: null,
        tod: {
          t00_06: { units: null, rate: null }, t06_09: { units: null, rate: null },
          t09_17: { units: null, rate: null }, t17_24: { units: null, rate: null }
        }
      },
      billing_history_units: []
    };
  }

  function fmtInput(v) { return (v === null || v === undefined) ? "" : v; }
  function isNullish(v) { return v === null || v === undefined || v === ""; }
  function currentCategoryGuess() {
    var picked = document.querySelector('input[name="category"]:checked');
    return picked ? picked.value : null;
  }

  /** Wraps one labelled input in its .field div, and — when needsReview is
   *  true — an amber "please check" note with an optional one-tap
   *  suggested-correction button (the ÷100 paise fix, etc). */
  function makeFieldDiv(label, inputEl, needsReview, suggestion) {
    var wrap = document.createElement("div");
    wrap.className = "field";
    if (needsReview) wrap.classList.add("reviewme");

    var lbl = document.createElement("label");
    lbl.textContent = label;
    wrap.appendChild(lbl);
    wrap.appendChild(inputEl);

    if (needsReview) {
      var note = document.createElement("div");
      note.className = "reviewnote";
      var noteText = document.createElement("span");
      noteText.textContent = "Please check this value.";
      note.appendChild(noteText);
      if (suggestion !== undefined && suggestion !== null) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "fixit-btn";
        btn.textContent = "Use " + suggestion + "?";
        btn.addEventListener("click", function () {
          inputEl.value = suggestion;
          wrap.classList.remove("reviewme");
          note.style.display = "none";
        });
        note.appendChild(btn);
      }
      wrap.appendChild(note);
    }
    return wrap;
  }

  function stableNullFirstSort(items) {
    items.sort(function (a, b) { return (a.isNull ? 0 : 1) - (b.isNull ? 0 : 1); });
    return items;
  }

  function buildCustomerFields(data, nr, sugg) {
    var container = document.getElementById("customerFieldsGrid");
    container.innerHTML = "";
    var specs = [
      { path: "consumer_number", label: "Consumer number", type: "text", value: data.consumer_number },
      { path: "consumer_name", label: "Consumer name", type: "text", value: data.consumer_name },
      { path: "tariff_category", label: "Category", type: "select", value: data.tariff_category },
      { path: "tariff_code", label: "Tariff code", type: "text", value: data.tariff_code },
      { path: "contract_demand_kva", label: "Contract demand (kVA)", type: "number", value: data.contract_demand_kva },
      { path: "sanctioned_load_kw", label: "Sanctioned load (kW)", type: "number", value: data.sanctioned_load_kw }
    ];
    var items = specs.map(function (spec) {
      var input;
      if (spec.type === "select") {
        input = document.createElement("select");
        input.id = "c-" + spec.path;
        ["Commercial", "Industrial"].forEach(function (opt) {
          var o = document.createElement("option");
          o.value = opt; o.textContent = opt;
          input.appendChild(o);
        });
        input.value = (spec.value === "Industrial" || spec.value === "Commercial") ? spec.value : (currentCategoryGuess() || "Commercial");
      } else {
        input = document.createElement("input");
        input.type = spec.type === "number" ? "number" : "text";
        if (spec.type === "number") input.step = "any";
        input.id = "c-" + spec.path;
        input.value = fmtInput(spec.value);
      }
      var needsReview = !!nr[spec.path];
      var el = makeFieldDiv(spec.label, input, needsReview, sugg[spec.path]);
      return { el: el, isNull: isNullish(spec.value) };
    });
    stableNullFirstSort(items).forEach(function (it) { container.appendChild(it.el); });
  }

  function buildRateFields(data, nr, sugg) {
    var container = document.getElementById("rateFieldsGrid");
    container.innerHTML = "";
    var cm = data.current_month || {};
    var specs = [
      { path: "current_month.total_units", label: "Total units this month", value: cm.total_units },
      { path: "current_month.energy_rate", label: "Energy rate (Rs/unit)", value: cm.energy_rate },
      { path: "current_month.demand_charge_per_unit", label: "Demand charge (Rs/unit)", value: cm.demand_charge_per_unit },
      { path: "current_month.fac", label: "FAC (Rs/unit)", value: cm.fac },
      { path: "current_month.electricity_duty", label: "Electricity duty (Rs/unit)", value: cm.electricity_duty },
      { path: "current_month.tax_on_sale", label: "Tax on sale (Rs/unit)", value: cm.tax_on_sale }
    ];
    var idFor = {
      "current_month.total_units": "c-total_units",
      "current_month.energy_rate": "c-energy_rate",
      "current_month.demand_charge_per_unit": "c-demand_charge_per_unit",
      "current_month.fac": "c-fac",
      "current_month.electricity_duty": "c-electricity_duty",
      "current_month.tax_on_sale": "c-tax_on_sale"
    };
    var items = specs.map(function (spec) {
      var input = document.createElement("input");
      input.type = "number"; input.step = "any";
      input.id = idFor[spec.path];
      input.value = fmtInput(spec.value);
      var needsReview = !!nr[spec.path];
      var el = makeFieldDiv(spec.label, input, needsReview, sugg[spec.path]);
      return { el: el, isNull: isNullish(spec.value) };
    });
    stableNullFirstSort(items).forEach(function (it) { container.appendChild(it.el); });
  }

  function buildTodRows(data, nr) {
    var tod = (data.current_month && data.current_month.tod) || {};
    var body = document.getElementById("todBody");
    body.innerHTML = "";
    var rows = TOD_SLOTS.map(function (slot) {
      var v = tod[slot.key] || {};
      var unitsPath = "current_month.tod." + slot.key + ".units";
      var ratePath = "current_month.tod." + slot.key + ".rate";
      var needsReview = !!nr[unitsPath] || !!nr[ratePath];

      var tr = document.createElement("tr");
      var tdLabel = document.createElement("td");
      tdLabel.textContent = slot.label;

      var unitsInput = document.createElement("input");
      unitsInput.type = "number"; unitsInput.step = "any";
      unitsInput.id = "c-tod-" + slot.key + "-units";
      unitsInput.value = fmtInput(v.units);

      var rateInput = document.createElement("input");
      rateInput.type = "number"; rateInput.step = "any";
      rateInput.id = "c-tod-" + slot.key + "-rate";
      rateInput.value = fmtInput(v.rate);

      if (needsReview) {
        tr.classList.add("reviewme");
        unitsInput.title = "Please check this value";
        rateInput.title = "Please check this value";
      }

      var tdUnits = document.createElement("td"); tdUnits.appendChild(unitsInput);
      var tdRate = document.createElement("td"); tdRate.appendChild(rateInput);
      tr.appendChild(tdLabel); tr.appendChild(tdUnits); tr.appendChild(tdRate);

      return { el: tr, isNull: isNullish(v.units) || isNullish(v.rate) };
    });
    stableNullFirstSort(rows).forEach(function (r) { body.appendChild(r.el); });
  }

  function buildHistoryItems(data, nr) {
    var history = Array.isArray(data.billing_history_units) ? data.billing_history_units : [];
    var grid = document.getElementById("historyGrid");
    grid.innerHTML = "";

    var aggregateNote = document.getElementById("historyNote");
    if (nr["billing_history_units"]) {
      aggregateNote.style.display = "block";
      aggregateNote.textContent = "This bill's billing history has fewer or more months than expected — please check the values below.";
    } else {
      aggregateNote.style.display = "none";
    }

    var items = [];
    for (var i = 0; i < HISTORY_MONTHS; i++) {
      var value = history[i];
      var needsReview = !!nr["billing_history_units[" + i + "]"];
      var div = document.createElement("div");
      div.className = "history-item";
      if (needsReview) div.classList.add("reviewme");

      var label = document.createElement("label");
      label.textContent = i === 0 ? "This month" : (i + 1) + " months ago";

      var input = document.createElement("input");
      input.type = "number"; input.step = "any";
      input.id = "c-hist-" + i;
      input.value = fmtInput(value);
      if (needsReview) input.title = "Please check this value";

      div.appendChild(label);
      div.appendChild(input);
      items.push({ el: div, isNull: isNullish(value) });
    }
    stableNullFirstSort(items).forEach(function (it) { grid.appendChild(it.el); });
  }

  function renderConfirmForm(data, needsReview, suggestedCorrections, quality, errorMessage) {
    var note = document.getElementById("confirmNote");
    note.innerHTML = "";

    if (errorMessage) {
      var errDiv = document.createElement("div");
      errDiv.className = "note error";
      errDiv.textContent = errorMessage;
      note.appendChild(errDiv);
    } else if (quality === "poor") {
      var warnDiv = document.createElement("div");
      warnDiv.className = "note warn";
      var warnText = document.createElement("div");
      warnText.textContent = "We couldn't read this bill very clearly — please double-check the highlighted fields below, or upload a clearer photo.";
      warnDiv.appendChild(warnText);
      var retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "btn secondary";
      retryBtn.style.marginTop = "10px";
      retryBtn.textContent = "Upload a clearer photo instead";
      retryBtn.addEventListener("click", function () {
        billInput.value = "";
        fileNameEl.textContent = "";
        clearError("f-bill");
        showStep("step-entry");
      });
      warnDiv.appendChild(retryBtn);
      note.appendChild(warnDiv);
    }

    buildCustomerFields(data, needsReview, suggestedCorrections);
    buildRateFields(data, needsReview, suggestedCorrections);
    buildTodRows(data, needsReview);
    buildHistoryItems(data, needsReview);
  }

  function numOrNull(id) {
    var raw = document.getElementById(id).value;
    if (raw === "" || raw === null) return null;
    var n = parseFloat(raw);
    return isNaN(n) ? null : n;
  }
  function strOrNull(id) {
    var raw = document.getElementById(id).value.trim();
    return raw === "" ? null : raw;
  }

  function collectConfirmedData() {
    var tod = {};
    TOD_SLOTS.forEach(function (slot) {
      tod[slot.key] = {
        units: numOrNull("c-tod-" + slot.key + "-units"),
        rate: numOrNull("c-tod-" + slot.key + "-rate")
      };
    });
    var history = [];
    for (var i = 0; i < HISTORY_MONTHS; i++) {
      var v = numOrNull("c-hist-" + i);
      if (v !== null) history.push(v);
    }
    return {
      consumer_number: strOrNull("c-consumer_number"),
      consumer_name: strOrNull("c-consumer_name"),
      tariff_category: document.getElementById("c-tariff_category").value,
      tariff_code: strOrNull("c-tariff_code"),
      contract_demand_kva: numOrNull("c-contract_demand_kva"),
      sanctioned_load_kw: numOrNull("c-sanctioned_load_kw"),
      current_month: {
        total_units: numOrNull("c-total_units"),
        energy_rate: numOrNull("c-energy_rate"),
        demand_charge_per_unit: numOrNull("c-demand_charge_per_unit"),
        fac: numOrNull("c-fac"),
        electricity_duty: numOrNull("c-electricity_duty"),
        tax_on_sale: numOrNull("c-tax_on_sale"),
        tod: tod
      },
      billing_history_units: history
    };
  }

  // ------------------------------------------------------------- dashboard
  var dashboardSection = document.getElementById("dashboardSection");
  var formulationErrorEl = document.getElementById("formulationError");
  var PANEL_WATTAGE = 580; // bifacial module assumption, matches reference/estimate.html

  // ------------------------------------------------------- hero header mode
  // The "Investment Ka Dhurandhar" hero band is shared by every step; only
  // its subline swaps between the landing pitch and "Prepared for {name}"
  // once we actually have a customer/result to show (SPEC.md "Hero header").
  var heroSubLanding = document.getElementById("heroSubLanding");
  var heroSubResults = document.getElementById("heroSubResults");
  var heroCompanyName = document.getElementById("heroCompanyName");

  function showHeroResults(companyName) {
    heroCompanyName.textContent = (companyName || "").toUpperCase();
    heroSubResults.classList.add("active");
    heroSubLanding.classList.remove("active");
  }
  function showHeroLanding() {
    heroSubLanding.classList.add("active");
    heroSubResults.classList.remove("active");
  }

  // Holds the live scenario + the values locked in at confirm time. Sliders
  // mutate dashState.scenario and re-render; confirming again rebuilds it
  // from scratch (fresh formulation -> fresh scenario defaults).
  var dashState = {
    config: null, lock: null, scenario: null, formulation: null, confirmed: null, m: null,
    chCmp: null, chLump: null, chLev: null
  };

  function setSliderPair(rId, nId, dispId, v) {
    document.getElementById(rId).value = v;
    document.getElementById(nId).value = v;
    var d = document.getElementById(dispId);
    if (d) d.textContent = v;
  }

  function syncDashboardControls(scenario) {
    document.getElementById("d_t_dep").checked = scenario.dep;
    document.getElementById("d_taxwrap").style.opacity = scenario.dep ? 1 : .4;
    document.getElementById("d_t_loan").checked = scenario.loan;
    document.getElementById("d_loanbox").classList.toggle("off", !scenario.loan);
    setSliderPair("d_r_tax", "d_n_tax", "d_v_tax", scenario.tax);
    setSliderPair("d_r_dp", "d_n_dp", "d_v_dp", scenario.dp);
    setSliderPair("d_r_rate", "d_n_rate", "d_v_rate", scenario.rate);
    setSliderPair("d_r_ten", "d_n_ten", "d_v_ten", scenario.ten);
    setSliderPair("d_r_fd", "d_n_fd", "d_v_fd", scenario.fd);
  }

  /** Templates the "how we sized your plant & priced each unit" cards from
   *  this customer's own derived values — see SPEC.md's Formulas section. */
  function renderNarrative(formulation) {
    var windowLabel = formulation.daytime_window === "09-17" ? "09:00–17:00" : "06:00–17:00";
    var pct = Math.round(formulation.daytime_fraction * 100);
    var monthsNote = formulation.months_used < 12
      ? (" (based on " + formulation.months_used + " month" + (formulation.months_used === 1 ? "" : "s") + " of billing history)")
      : "";

    document.getElementById("d_why_size_h").textContent = "1 · System size → " + formulation.offered_kwp + " kWp";
    document.getElementById("d_why_size_p").innerHTML =
      "Solar only produces in the <b>" + windowLabel + "</b> window — about <b>" + pct + "%</b> of your annual usage" +
      monthsNote + ". Your load needs <b>" + formulation.required_kwp_exact.toFixed(2) + " kWp</b> for full daytime cover; " +
      "we round UP to <b>" + formulation.offered_kwp + " kWp</b> so the system fully meets daytime demand, with a little headroom.";

    var tb = formulation.tariff_breakdown;
    var todTerm = tb.daytime_tod_rate < 0
      ? "− daytime ToD rebate <b>₹" + Math.abs(tb.daytime_tod_rate).toFixed(2) + "</b>"
      : "+ daytime ToD charge <b>₹" + tb.daytime_tod_rate.toFixed(2) + "</b>";
    document.getElementById("d_why_rate_h").textContent = "2 · Per-unit value → ₹" + formulation.effective_tariff.toFixed(2) + "/unit";
    document.getElementById("d_why_rate_p").innerHTML =
      "Built bottom-up from your tariff: base energy <b>₹" + tb.energy_rate.toFixed(2) + "</b> + demand <b>₹" +
      tb.demand_charge_per_unit.toFixed(2) + "</b> + FAC <b>₹" + tb.fac.toFixed(2) + "</b> + duty <b>₹" +
      tb.electricity_duty.toFixed(2) + "</b> + tax-on-sale <b>₹" + tb.tax_on_sale.toFixed(2) + "</b> " + todTerm +
      " − Grid Support Charge <b>₹" + tb.gsc.toFixed(2) + "</b> = <b>₹" + formulation.effective_tariff.toFixed(2) +
      "/unit</b> — the real value each solar unit offsets, net of the ToD rebate and the GSC.";
  }

  /** Recomputes the engine from the current dashState and repaints every
   *  metric, chart, and the 25-year table. Called on confirm and on every
   *  slider/toggle change. */
  function renderDashboard() {
    if (!dashState.config || !dashState.lock || !dashState.scenario) return;
    var config = dashState.config, lock = dashState.lock, scenario = dashState.scenario;
    var inr = RiteEngine.inr, inrShort = RiteEngine.inrShort;
    var m = RiteEngine.compute(lock, config, scenario);
    dashState.m = m; // held so the PDF report can reuse the exact same numbers, not recompute

    var tax = scenario.tax / 100;
    var fdPost = scenario.fd / 100 * (1 - tax);
    var inv = m.exGst;
    var irrPct = m.irrV != null ? (m.irrV * 100).toFixed(1) + "%" : "—";

    document.getElementById("d_cmp_amt").textContent = "₹" + (inv / 1e5).toFixed(1) + " lakh";
    document.getElementById("d_k_irr").textContent = irrPct;
    document.getElementById("d_k_earn").textContent = inrShort(m.profit);
    document.getElementById("d_k_yield").textContent = "₹" + m.lcoe.toFixed(2) + "/unit";
    document.getElementById("d_k_pay").textContent = (m.payback != null ? m.payback.toFixed(1) : "—");
    document.getElementById("d_k_npv").textContent = inrShort(m.npvV);
    document.getElementById("d_k_mult").textContent = m.multiple.toFixed(1) + "x";

    document.getElementById("d_o_size").textContent = lock.size + " kWp";
    document.getElementById("d_o_price").textContent = inrShort(m.netCost);
    document.getElementById("d_o_net").textContent = inrShort(m.exGst);
    document.getElementById("d_o_gen").textContent = "~" + Math.round(lock.size * lock.gen * config.days).toLocaleString("en-IN") + " units";
    document.getElementById("d_o_esc").textContent = (config.tariff_esc * 100).toFixed(0) + "% / year";
    document.getElementById("d_o_rate").textContent = "₹" + lock.flatRate.toFixed(2) + "/unit";

    document.getElementById("d_spec_kwp").textContent = lock.size + " kWp (DC)";
    document.getElementById("d_spec_panels").textContent = "~" + Math.round(lock.size * 1000 / PANEL_WATTAGE) + " panels";
    document.getElementById("d_spec_gen").textContent = "~" + Math.round(lock.size * lock.gen * config.days).toLocaleString("en-IN") + " units";

    document.getElementById("d_c_solar").textContent = inrShort(m.totalOper);
    document.getElementById("d_cmp_note").textContent =
      "On " + inrShort(inv) + " of capital, this solar investment returns about " + inrShort(m.totalOper) +
      " over 25 years. Solar IRR ≈ " + irrPct + " vs ~" + scenario.fd + "% FD, ~" + (config.bond_rate * 100).toFixed(0) +
      "% bonds, ~" + (config.equity_rate * 100).toFixed(0) + "% equity (equity carries market risk; solar is asset-backed and inflation-linked).";
    dashState.chCmp = RiteCharts.renderCompareChart(document.getElementById("d_chart_cmp"), dashState.chCmp, {
      irrV: m.irrV, bondRate: config.bond_rate, fdRate: scenario.fd, savingsRate: config.savings_rate
    });

    document.getElementById("d_s_earn").textContent = inrShort(m.profit);
    document.getElementById("d_s_avg").textContent = inrShort(m.avgOper);
    document.getElementById("d_s_back").textContent = inrShort(m.totalOper);
    document.getElementById("d_s_lcoe").textContent = "₹" + m.lcoe.toFixed(2) + "/unit";
    document.getElementById("d_lump_verdict").textContent = "Your " + inrShort(inv) + " returns about " + inrShort(m.totalOper) +
      " over 25 years — a " + m.multiple.toFixed(1) + "x money multiple and a " + irrPct + " IRR, recovered in ~" +
      (m.payback ? m.payback.toFixed(1) : "—") + " years.";

    var labels = m.rows.map(function (r) { return r.y; });
    var fdC = [], v = inv;
    for (var y = 1; y <= config.years; y++) { v = v * (1 + fdPost); fdC.push(Math.round(v - inv)); }
    dashState.chLump = RiteCharts.renderLumpChart(document.getElementById("d_chart_lump"), dashState.chLump, {
      labels: labels,
      solarCum: m.rows.map(function (r) { return Math.round(r.cum); }),
      fdCum: fdC,
      fdLabel: "Same " + inrShort(inv) + " in FD — cumulative earnings",
      inr: inr
    });
    RiteCharts.drawTable(document.getElementById("d_tbl_lump"), m.rows, inr);

    document.getElementById("d_l_dp").textContent = inrShort(m.downPay + m.procFee);
    document.getElementById("d_l_roe").textContent = m.finIrr != null ? (m.finIrr * 100).toFixed(0) + "%" : "—";
    document.getElementById("d_l_emi").textContent = inr(m.emi);
    document.getElementById("d_l_net1").textContent = inr(m.rows[0].oper / 12 - m.emi);
    document.getElementById("d_l_int").textContent = inrShort(m.totalInterest);
    document.getElementById("d_l_25").textContent = inrShort(m.rows.reduce(function (a, r) { return a + r.finNet; }, 0));

    var lv = document.getElementById("d_lev_verdict");
    if (!scenario.loan) {
      lv.textContent = "Financing is OFF — showing an all-cash investment. Turn on a bank loan to see the levered return on your own capital.";
      lv.style.background = "#fff7e6"; lv.style.color = "#8a5a00"; lv.style.borderColor = "#f3dca0";
    } else {
      lv.style.background = "#eafaf2"; lv.style.color = "#136b41"; lv.style.borderColor = "#bfe9d2";
      lv.textContent = "With just " + inrShort(m.downPay + m.procFee) + " of your own cash, the savings cover the EMI and your return on equity rises to ≈ " +
        (m.finIrr != null ? (m.finIrr * 100).toFixed(0) + "%" : "—") + ". Leverage amplifies an already strong return.";
    }
    dashState.chLev = RiteCharts.renderLevChart(document.getElementById("d_chart_lev"), dashState.chLev, {
      labels: labels,
      financedCum: m.rows.map(function (r) { return Math.round(r.fcum); }),
      inr: inr
    });
  }

  function bindScenarioPair(rId, nId, key, dispId) {
    var r = document.getElementById(rId), n = document.getElementById(nId), d = document.getElementById(dispId);
    function set(v) {
      if (!dashState.scenario || isNaN(v)) return;
      dashState.scenario[key] = v;
      r.value = v; n.value = v;
      if (d) d.textContent = v;
      renderDashboard();
    }
    r.addEventListener("input", function (e) { set(parseFloat(e.target.value)); });
    n.addEventListener("input", function (e) { set(parseFloat(e.target.value)); });
  }
  bindScenarioPair("d_r_tax", "d_n_tax", "tax", "d_v_tax");
  bindScenarioPair("d_r_dp", "d_n_dp", "dp", "d_v_dp");
  bindScenarioPair("d_r_rate", "d_n_rate", "rate", "d_v_rate");
  bindScenarioPair("d_r_ten", "d_n_ten", "ten", "d_v_ten");
  bindScenarioPair("d_r_fd", "d_n_fd", "fd", "d_v_fd");

  document.getElementById("d_t_dep").addEventListener("change", function (e) {
    if (!dashState.scenario) return;
    dashState.scenario.dep = e.target.checked;
    document.getElementById("d_taxwrap").style.opacity = e.target.checked ? 1 : .4;
    renderDashboard();
  });
  document.getElementById("d_t_loan").addEventListener("change", function (e) {
    if (!dashState.scenario) return;
    dashState.scenario.loan = e.target.checked;
    document.getElementById("d_loanbox").classList.toggle("off", !e.target.checked);
    renderDashboard();
  });

  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
      document.querySelectorAll(".tabpane").forEach(function (x) { x.classList.remove("active"); });
      t.classList.add("active");
      document.getElementById("d_pane_" + t.dataset.tab).classList.add("active");
      setTimeout(function () {
        [dashState.chCmp, dashState.chLump, dashState.chLev].forEach(function (c) { if (c) c.resize(); });
      }, 30);
    });
  });

  document.getElementById("confirmBtn").addEventListener("click", function () {
    var confirmed = collectConfirmedData();
    console.log("Confirmed extraction JSON:", confirmed);

    formulationErrorEl.style.display = "none";
    dashboardSection.style.display = "none";

    RiteConfig.load().then(function (config) {
      var formulation;
      try {
        formulation = RiteFormulation.derive(confirmed, config);
      } catch (e) {
        formulationErrorEl.textContent = e.message;
        formulationErrorEl.style.display = "block";
        return;
      }

      dashState.config = config;
      dashState.formulation = formulation;
      dashState.confirmed = confirmed;
      dashState.lock = { size: formulation.offered_kwp, gen: config.gen_per_kwp_day, flatRate: formulation.effective_tariff };
      dashState.scenario = {
        dep: config.dep_default, tax: config.tax_default, loan: config.loan_default,
        dp: config.dp_default, rate: config.loan_rate_default, ten: config.tenure_months_default, fd: config.fd_rate_default
      };

      syncDashboardControls(dashState.scenario);
      renderNarrative(formulation);
      renderDashboard();
      showHeroResults(nameInput.value.trim());

      dashboardSection.style.display = "block";
      dashboardSection.scrollIntoView({ behavior: "smooth", block: "start" });

      // Persist AFTER the dashboard has already rendered — never blocks it.
      persistCompletedSubmission(confirmed, formulation);
    });
  });

  document.getElementById("downloadPdfBtn").addEventListener("click", function () {
    var btn = this;
    var statusNote = document.getElementById("pdfStatusNote");
    statusNote.style.display = "none";

    if (!dashState.config || !dashState.lock || !dashState.scenario || !dashState.formulation || !dashState.m) {
      return; // dashboard hasn't rendered yet — button shouldn't be reachable, but don't crash if it is
    }

    var activeTab = document.querySelector(".tab.active");
    var scenarioKey = (activeTab && activeTab.dataset.tab === "lev") ? "lev" : "lump";

    btn.disabled = true;
    RiteReport.buildAndDownload({
      companyName: nameInput.value.trim() || "Customer",
      category: dashState.confirmed ? dashState.confirmed.tariff_category : null,
      consumerNumber: dashState.confirmed ? dashState.confirmed.consumer_number : null,
      formulation: dashState.formulation,
      config: dashState.config,
      lock: dashState.lock,
      scenario: dashState.scenario,
      m: dashState.m,
      scenarioKey: scenarioKey,
      charts: {
        compare: dashState.chCmp,
        active: scenarioKey === "lev" ? dashState.chLev : dashState.chLump
      }
    }).then(function (blob) {
      btn.disabled = false;
      uploadReportFile(blob);
    }).catch(function (err) {
      btn.disabled = false;
      statusNote.className = "note error";
      statusNote.textContent = "Couldn't generate the PDF (" + err.message + "). Please try again.";
      statusNote.style.display = "block";
    });
  });

  document.getElementById("startOverBtn").addEventListener("click", function () {
    entryForm.reset();
    fileNameEl.textContent = "";
    document.getElementById("lbl-commercial").classList.remove("checked");
    document.getElementById("lbl-industrial").classList.remove("checked");
    dashboardSection.style.display = "none";
    formulationErrorEl.style.display = "none";
    currentSubmission.idPromise = null;
    dashState.config = null; dashState.lock = null; dashState.scenario = null;
    dashState.formulation = null; dashState.confirmed = null; dashState.m = null;
    showHeroLanding();
    showStep("step-entry");
  });

})();
