/* group-pdf.js
 * -----------------------------------------------------------------------------
 * Client-side PDF builder for the Expedition Leader "DOWNLOAD GROUP INFORMATION"
 * button. Fetches the assembled group data from /get-group-info and renders the
 * four sheets (Motivations, Emergency Contacts, Medical Details, Travel) into a
 * single landscape PDF using pdfmake (lazy-loaded from jsDelivr — already
 * allowed by the site CSP script-src).
 *
 * Loaded as a same-origin <script> from index.html; also loadable in Node for
 * tests (attaches to globalThis.GroupPdf and, if present, module.exports).
 * -----------------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  var PDFMAKE_JS  = "https://cdn.jsdelivr.net/npm/pdfmake@0.2.10/build/pdfmake.min.js";
  var PDFMAKE_VFS = "https://cdn.jsdelivr.net/npm/pdfmake@0.2.10/build/vfs_fonts.js";

  // Palette mirrors the reference workbook.
  var C = {
    headerBg: "#000000",  // black column-header / title bars
    headerFg: "#FFFFFF",
    sectionBg: "#D9D9D9", // grey Expedition Leader / School Leaders / Students rows
    border: "#BFBFBF",
    legendHdr: "#000000",
  };

  // ---- small helpers -------------------------------------------------------

  function esc(s) { return s == null ? "" : String(s); }

  // "YYYY-MM-DD" -> "02 Dec 1972"; anything else passes through unchanged.
  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function fmtDate(v) {
    var s = esc(v).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return s;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12) return s;
    return (d < 10 ? "0" + d : d) + " " + MONTHS[mo - 1] + " " + y;
  }

  function titleBar(text, colSpanCols) {
    // A single black bar spanning the whole table width.
    var first = { text: esc(text), colSpan: colSpanCols, fillColor: C.headerBg,
                  color: C.headerFg, bold: true, fontSize: 11, margin: [2, 3, 2, 3] };
    var row = [first];
    for (var i = 1; i < colSpanCols; i++) row.push({});
    return row;
  }

  function headerCell(text) {
    return { text: esc(text), fillColor: C.headerBg, color: C.headerFg, bold: true, fontSize: 8 };
  }

  // Header cell with extra props (colSpan / rowSpan / alignment).
  function hcell(text, extra) {
    var base = { text: esc(text), fillColor: C.headerBg, color: C.headerFg, bold: true, fontSize: 8 };
    if (extra) for (var k in extra) base[k] = extra[k];
    return base;
  }

  function sectionRow(role, ncols) {
    var first = { text: esc(role), colSpan: ncols, fillColor: C.sectionBg, bold: true, fontSize: 8 };
    var row = [first];
    for (var i = 1; i < ncols; i++) row.push({});
    return row;
  }

  function cell(text) { return { text: esc(text), fontSize: 8 }; }

  // Standard table layout: thin grey grid lines.
  var GRID = {
    hLineWidth: function () { return 0.5; },
    vLineWidth: function () { return 0.5; },
    hLineColor: function () { return C.border; },
    vLineColor: function () { return C.border; },
    paddingLeft: function () { return 3; },
    paddingRight: function () { return 3; },
    paddingTop: function () { return 2; },
    paddingBottom: function () { return 2; },
  };

  // ---- the four sheets -----------------------------------------------------

  function motivationsSection(data, first) {
    var m = (data && data.motivations) || { questions: [], rows: [] };
    var qs = m.questions || [];
    var ncols = 1 + qs.length;

    var body = [];
    body.push(titleBar("Motivations", ncols));
    body.push([headerCell("First Name")].concat(qs.map(function (q) { return headerCell(q.label); })));
    if (!m.rows || !m.rows.length) {
      body.push([{ text: "No student responses found.", colSpan: ncols, italics: true, fontSize: 8 }].concat(
        qs.map(function () { return {}; })));
    } else {
      m.rows.forEach(function (r) {
        var row = [cell(r.firstName)];
        qs.forEach(function (q) { row.push(cell(r[q.key])); });
        body.push(row);
      });
    }

    var widths = [70].concat(qs.map(function () { return "*"; }));
    return {
      pageBreak: first ? undefined : "before",
      table: { headerRows: 2, widths: widths, body: body },
      layout: GRID,
    };
  }

  function groupedSection(title, columnLabels, widths, groups, rowToCells) {
    var ncols = columnLabels.length;
    var body = [];
    body.push(titleBar(title, ncols));
    body.push(columnLabels.map(headerCell));

    var any = false;
    (groups || []).forEach(function (g) {
      body.push(sectionRow(g.role, ncols));
      (g.rows || []).forEach(function (r) { body.push(rowToCells(r)); any = true; });
    });
    if (!any) {
      body.push([{ text: "No people found for this program.", colSpan: ncols, italics: true, fontSize: 8 }]
        .concat(columnLabels.slice(1).map(function () { return {}; })));
    }

    return {
      pageBreak: "before",
      table: { headerRows: 2, widths: widths, body: body },
      layout: GRID,
    };
  }

  function emergencySection(data) {
    // Columns: # | First | Last | Guardian Contact 1 (Name, Phone) | Guardian Contact 2 (Name, Phone)
    var ncols = 7;
    var widths = [16, 72, 72, "*", 90, "*", 90];
    var body = [];

    body.push(titleBar("Emergency Contact Details", ncols));

    // Two-row header: a grouped "Guardian Contact 1/2" label spanning each
    // pair of Name/Phone columns; #, First, Last span both header rows.
    body.push([
      hcell("#", { rowSpan: 2 }),
      hcell("First", { rowSpan: 2 }),
      hcell("Last", { rowSpan: 2 }),
      hcell("Guardian Contact 1", { colSpan: 2, alignment: "center" }), {},
      hcell("Guardian Contact 2", { colSpan: 2, alignment: "center" }), {},
    ]);
    body.push([{}, {}, {}, headerCell("Name"), headerCell("Phone"), headerCell("Name"), headerCell("Phone")]);

    var groups = (data.emergency && data.emergency.groups) || [];
    var any = false;
    groups.forEach(function (g) {
      body.push(sectionRow(g.role, ncols));
      (g.rows || []).forEach(function (r) {
        var c0 = r.contacts[0] || {}, c1 = r.contacts[1] || {};
        body.push([cell(r.index), cell(r.first), cell(r.last),
                   cell(c0.name), cell(c0.phone), cell(c1.name), cell(c1.phone)]);
        any = true;
      });
    });
    if (!any) {
      body.push([{ text: "No people found for this program.", colSpan: ncols, italics: true, fontSize: 8 }]
        .concat([{}, {}, {}, {}, {}, {}]));
    }

    return { pageBreak: "before", table: { headerRows: 3, widths: widths, body: body }, layout: GRID };
  }

  // A medical cell = a stack of the applicant's actual answers, each rendered as
  // a bold question followed by their response.
  function medicalCell(items) {
    if (!items || !items.length) return { text: "—", fontSize: 8, color: "#999999" };
    return {
      stack: items.map(function (it, i) {
        return {
          fontSize: 8,
          margin: [0, i ? 3 : 0, 0, 0],
          text: [
            { text: esc(it.question), bold: true },
            { text: "  " + esc(it.answer) },
          ],
        };
      }),
    };
  }

  function medicalSection(data) {
    var ncols = 5;
    var widths = [16, 72, 72, "*", 58];
    var body = [];
    body.push(titleBar("Team Medical Conditions", ncols));
    body.push([headerCell("#"), headerCell("First"), headerCell("Last"),
               headerCell("Medical Information (from application)"), headerCell("Status")]);

    var groups = (data.medical && data.medical.groups) || [];
    var any = false;
    groups.forEach(function (g) {
      body.push(sectionRow(g.role, ncols));
      (g.rows || []).forEach(function (r) {
        body.push([cell(r.index), cell(r.first), cell(r.last), medicalCell(r.items), cell(r.status)]);
        any = true;
      });
    });
    if (!any) {
      body.push([{ text: "No people found for this program.", colSpan: ncols, italics: true, fontSize: 8 }, {}, {}, {}, {}]);
    }

    return { pageBreak: "before", table: { headerRows: 2, widths: widths, body: body }, layout: GRID };
  }

  function travelSection(data) {
    // Middle Name sits between First and Last: airline tickets are issued
    // against the full passport name, so it belongs in reading order.
    var cols = ["#", "First Name", "Middle Name(s)", "Last Name", "Gender", "Date of Birth",
                "Age on Departure", "Passport Number", "Country of Issue", "Expiry Date", "Dietary Requirement"];
    var widths = [14, 58, 58, 58, 30, 52, 34, 60, 56, 52, "*"];
    var section = groupedSection("Passenger Details for Travel", cols, widths,
      data.travel && data.travel.groups, function (r) {
        return [cell(r.index), cell(r.first), cell(r.middle), cell(r.last), cell(r.gender),
                cell(fmtDate(r.dateOfBirth)), cell(r.ageOnDeparture),
                cell(r.passportNumber), cell(r.passportCountry),
                cell(fmtDate(r.passportExpiry)), cell(r.dietary)];
      });

    // Dietary code legend beneath the passenger table.
    var legend = data.dietaryLegend || [];
    var legendBody = [[{ text: "Dietary Codes", colSpan: 2, fillColor: C.legendHdr, color: C.headerFg, bold: true, fontSize: 8 }, {}]];
    legend.forEach(function (pair) {
      var code = pair[0], desc = pair[1];
      if (!desc) { // category heading row
        legendBody.push([{ text: code, colSpan: 2, bold: true, italics: true, fontSize: 7.5, fillColor: "#F2F2F2" }, {}]);
      } else {
        legendBody.push([{ text: code, bold: true, fontSize: 7.5 }, { text: desc, fontSize: 7.5 }]);
      }
    });

    return [
      section,
      { text: " ", fontSize: 4 },
      { table: { headerRows: 1, widths: [60, "*"], body: legendBody }, layout: GRID },
    ];
  }

  // ---- doc definition ------------------------------------------------------

  function buildGroupPdfDocDefinition(data) {
    data = data || {};
    var title = "EXPEDITION LEADER INFORMATION";
    var sub = (data.program && data.program.name) ? data.program.name : "";
    var when = data.generatedAt ? new Date(data.generatedAt) : null;
    var whenStr = when && !isNaN(when.getTime())
      ? when.toLocaleDateString("en-NZ", { year: "numeric", month: "short", day: "numeric" })
      : "";

    var content = [
      { text: title, bold: true, fontSize: 15, margin: [0, 0, 0, 2] },
    ];
    if (sub) content.push({ text: sub, fontSize: 11, margin: [0, 0, 0, 2] });
    if (whenStr) content.push({ text: "Generated " + whenStr, fontSize: 8, color: "#666666", margin: [0, 0, 0, 8] });

    content.push(motivationsSection(data, true));
    content.push(emergencySection(data));
    content.push(medicalSection(data));
    // travelSection returns an array (table + legend); flatten it in.
    travelSection(data).forEach(function (part) { content.push(part); });

    return {
      pageOrientation: "landscape",
      pageSize: "A4",
      pageMargins: [24, 28, 24, 28],
      defaultStyle: { font: "Roboto", fontSize: 8 },
      footer: function (currentPage, pageCount) {
        return { text: "Confidential — " + currentPage + " / " + pageCount,
                 alignment: "center", fontSize: 7, color: "#999999", margin: [0, 6, 0, 0] };
      },
      content: content,
    };
  }

  // ---- browser-only: lazy load pdfmake + download --------------------------

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error("Failed to load " + src)); };
      document.head.appendChild(el);
    });
  }

  var _pdfMakeReady = null;
  function ensurePdfMake() {
    if (typeof window !== "undefined" && window.pdfMake) return Promise.resolve(window.pdfMake);
    if (_pdfMakeReady) return _pdfMakeReady;
    _pdfMakeReady = loadScript(PDFMAKE_JS)
      .then(function () { return loadScript(PDFMAKE_VFS); })
      .then(function () {
        if (!window.pdfMake) throw new Error("pdfMake failed to initialise");
        return window.pdfMake;
      });
    return _pdfMakeReady;
  }

  function safeName(s) {
    return (esc(s).replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "-") || "program");
  }

  // Click handler. `apiFetch` is the authenticated fetch defined in index.html;
  // pass it in so this file stays decoupled from the auth token plumbing.
  function downloadGroupInfoPdf(opts) {
    opts = opts || {};
    var portalId = opts.portalId;
    var apiFetch = opts.apiFetch || (typeof window !== "undefined" ? window.fetch.bind(window) : null);
    var button = opts.button || null;
    var setStatus = opts.setStatus || function () {};

    if (!portalId) { setStatus("No program id available."); return Promise.reject(new Error("Missing portalId")); }

    var originalText = button ? button.textContent : "";
    if (button) { button.disabled = true; button.textContent = "PREPARING PDF…"; }
    setStatus("");

    return Promise.all([
      apiFetch("/.netlify/functions/get-group-info?portalId=" + encodeURIComponent(portalId))
        .then(function (res) {
          if (!res.ok) throw new Error("Server returned " + res.status);
          return res.json();
        }),
      ensurePdfMake(),
    ]).then(function (arr) {
      var data = arr[0];
      if (data && data.error) throw new Error(data.error);
      var doc = buildGroupPdfDocDefinition(data);
      var fname = "Expedition-Leader-Info-" + safeName(data.program && data.program.name) + ".pdf";
      window.pdfMake.createPdf(doc).download(fname);
      if (button) { button.disabled = false; button.textContent = originalText; }
    }).catch(function (err) {
      console.error("[group-pdf] download failed:", err);
      if (button) { button.disabled = false; button.textContent = originalText; }
      setStatus("Could not generate the PDF: " + (err && err.message ? err.message : "unknown error"));
      throw err;
    });
  }

  var api = {
    buildGroupPdfDocDefinition: buildGroupPdfDocDefinition,
    downloadGroupInfoPdf: downloadGroupInfoPdf,
    _fmtDate: fmtDate,
  };
  global.GroupPdf = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
