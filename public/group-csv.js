/* group-csv.js
 * -----------------------------------------------------------------------------
 * Client-side CSV builder for the Expedition Leader "DOWNLOAD GROUP INFORMATION"
 * card. Fetches the same /get-group-info JSON the PDF uses and turns it into
 * four spreadsheet-ready CSVs — Motivations, Emergency Contacts, Medical
 * Details, Travel — bundled into one .zip download.
 *
 * No dependencies: the zip is written here as a store-only (uncompressed)
 * archive, which every OS and spreadsheet app opens natively. That keeps the
 * CSP surface unchanged — nothing new is loaded from a CDN.
 *
 * Differences from the PDF, all in the CSV's favour: the role grouping becomes
 * a plain "Role" column so the rows sort and filter, dates stay in ISO
 * (YYYY-MM-DD) so spreadsheets parse them as dates, and the emergency sheet
 * carries the contact relationship that the PDF has no room for.
 *
 * Loaded as a same-origin <script> from index.html; also loadable in Node for
 * tests (attaches to globalThis.GroupCsv and, if present, module.exports).
 * -----------------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  function esc(s) { return s == null ? "" : String(s); }

  // ---- CSV ------------------------------------------------------------------

  // Spreadsheet apps treat a leading =, +, -, @ (or a control character) as the
  // start of a formula. Answers typed into a form are data, never formulas, so
  // neutralise those with a leading apostrophe — except a leading + or - that
  // introduces something numeric, which is overwhelmingly a phone number
  // ("+64 21 555 0199") or a negative value and must stay readable.
  function deFormula(s) {
    if (/^[=@\t\r]/.test(s)) return "'" + s;
    if (/^[+-]/.test(s) && !/^[+-][\d\s().+-]*$/.test(s)) return "'" + s;
    return s;
  }

  function csvCell(v) {
    var s = deFormula(esc(v));
    if (/[",\n\r]/.test(s) || /^\s|\s$/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // rows = array of arrays. CRLF line endings: what Excel expects, and what
  // RFC 4180 specifies.
  function toCsv(rows) {
    return (rows || []).map(function (r) {
      return (r || []).map(csvCell).join(",");
    }).join("\r\n") + "\r\n";
  }

  // ---- the four sheets ------------------------------------------------------

  // Walk role-grouped sheets ({ groups: [{ role, rows }] }) into flat rows with
  // the role as the first column.
  function flattenGroups(groups, rowToCells) {
    var out = [];
    (groups || []).forEach(function (g) {
      (g.rows || []).forEach(function (r) {
        out.push([g.role].concat(rowToCells(r)));
      });
    });
    return out;
  }

  function motivationsCsv(data) {
    var m = (data && data.motivations) || { questions: [], rows: [] };
    var qs = m.questions || [];
    var rows = [["First Name"].concat(qs.map(function (q) { return q.label; }))];
    (m.rows || []).forEach(function (r) {
      rows.push([r.firstName].concat(qs.map(function (q) { return r[q.key]; })));
    });
    return toCsv(rows);
  }

  function emergencyCsv(data) {
    var rows = [[
      "Role", "#", "First Name", "Last Name",
      "Guardian Contact 1 Name", "Guardian Contact 1 Phone", "Guardian Contact 1 Relationship",
      "Guardian Contact 2 Name", "Guardian Contact 2 Phone", "Guardian Contact 2 Relationship",
    ]];
    var groups = (data && data.emergency && data.emergency.groups) || [];
    flattenGroups(groups, function (r) {
      var contacts = r.contacts || [];
      var c0 = contacts[0] || {}, c1 = contacts[1] || {};
      return [r.index, r.first, r.last,
              c0.name, c0.phone, c0.role,
              c1.name, c1.phone, c1.role];
    }).forEach(function (r) { rows.push(r); });
    return toCsv(rows);
  }

  function medicalCsv(data) {
    var rows = [["Role", "#", "First Name", "Last Name", "Medical Information", "Status"]];
    var groups = (data && data.medical && data.medical.groups) || [];
    flattenGroups(groups, function (r) {
      // One "question: answer" per line inside a single quoted cell, so the
      // sheet keeps one row per person.
      var info = (r.items || []).map(function (it) {
        return esc(it.question) + ": " + esc(it.answer);
      }).join("\n");
      return [r.index, r.first, r.last, info, r.status];
    }).forEach(function (r) { rows.push(r); });
    return toCsv(rows);
  }

  function travelCsv(data) {
    var rows = [[
      "Role", "#", "First Name", "Middle Name(s)", "Last Name", "Gender",
      "Date of Birth", "Age on Departure", "Passport Number",
      "Country of Issue", "Expiry Date", "Dietary Requirement",
    ]];
    var groups = (data && data.travel && data.travel.groups) || [];
    flattenGroups(groups, function (r) {
      return [r.index, r.first, r.middle, r.last, r.gender,
              r.dateOfBirth, r.ageOnDeparture, r.passportNumber,
              r.passportCountry, r.passportExpiry, r.dietary];
    }).forEach(function (r) { rows.push(r); });
    return toCsv(rows);
  }

  // The four files, in the same order as the PDF's four sheets.
  function buildGroupCsvs(data) {
    data = data || {};
    return [
      { name: "1-motivations.csv", text: motivationsCsv(data) },
      { name: "2-emergency-contacts.csv", text: emergencyCsv(data) },
      { name: "3-medical-details.csv", text: medicalCsv(data) },
      { name: "4-travel-passenger-details.csv", text: travelCsv(data) },
    ];
  }

  // ---- minimal store-only ZIP writer ---------------------------------------

  var CRC_TABLE = (function () {
    var table = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0 ^ (-1);
    for (var i = 0; i < bytes.length; i++) {
      c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    }
    return (c ^ (-1)) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    // Node <11 / very old browsers.
    var buf = Buffer.from(str, "utf8");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  // DOS date/time fields used by the zip local + central headers.
  function dosDateTime(date) {
    var d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
    var year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  // files = [{ name, text }] -> Uint8Array of a valid .zip (no compression).
  function zipStore(files, when) {
    var dt = dosDateTime(when);
    var entries = (files || []).map(function (f) {
      // A UTF-8 BOM makes Excel on Windows read accented names correctly.
      var bytes = utf8("﻿" + esc(f.text));
      return { nameBytes: utf8(esc(f.name)), bytes: bytes, crc: crc32(bytes) };
    });

    var LOCAL = 30, CENTRAL = 46, EOCD = 22;
    var localSize = 0, centralSize = 0;
    entries.forEach(function (e) {
      localSize += LOCAL + e.nameBytes.length + e.bytes.length;
      centralSize += CENTRAL + e.nameBytes.length;
    });

    var out = new Uint8Array(localSize + centralSize + EOCD);
    var view = new DataView(out.buffer);
    var pos = 0;
    function u16(v) { view.setUint16(pos, v, true); pos += 2; }
    function u32(v) { view.setUint32(pos, v >>> 0, true); pos += 4; }
    function raw(b) { out.set(b, pos); pos += b.length; }

    // Local file headers + data.
    entries.forEach(function (e) {
      e.offset = pos;
      u32(0x04034B50);          // local file header signature
      u16(20);                  // version needed (2.0)
      u16(0x0800);              // flags: filename is UTF-8
      u16(0);                   // method: stored
      u16(dt.time); u16(dt.date);
      u32(e.crc);
      u32(e.bytes.length);      // compressed size
      u32(e.bytes.length);      // uncompressed size
      u16(e.nameBytes.length);
      u16(0);                   // extra field length
      raw(e.nameBytes);
      raw(e.bytes);
    });

    // Central directory.
    var centralStart = pos;
    entries.forEach(function (e) {
      u32(0x02014B50);          // central directory header signature
      u16(20);                  // version made by
      u16(20);                  // version needed
      u16(0x0800);
      u16(0);
      u16(dt.time); u16(dt.date);
      u32(e.crc);
      u32(e.bytes.length);
      u32(e.bytes.length);
      u16(e.nameBytes.length);
      u16(0);                   // extra
      u16(0);                   // comment
      u16(0);                   // disk number start
      u16(0);                   // internal attributes
      u32(0);                   // external attributes
      u32(e.offset);
      raw(e.nameBytes);
    });

    // End of central directory. Snapshot the directory's size first — `pos`
    // keeps moving as the record below is written.
    var centralSizeActual = pos - centralStart;
    u32(0x06054B50);
    u16(0); u16(0);
    u16(entries.length); u16(entries.length);
    u32(centralSizeActual);
    u32(centralStart);
    u16(0);                     // comment length

    return out;
  }

  // ---- browser-only: build + download --------------------------------------

  function safeName(s) {
    return (esc(s).replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "-") || "program");
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Give the browser a moment to start the download before revoking.
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // Click handler, mirroring GroupPdf.downloadGroupInfoPdf. `apiFetch` is the
  // authenticated fetch defined in index.html.
  function downloadGroupInfoCsv(opts) {
    opts = opts || {};
    var portalId = opts.portalId;
    var apiFetch = opts.apiFetch || (typeof window !== "undefined" ? window.fetch.bind(window) : null);
    var button = opts.button || null;
    var setStatus = opts.setStatus || function () {};

    if (!portalId) { setStatus("No program id available."); return Promise.reject(new Error("Missing portalId")); }

    var originalText = button ? button.textContent : "";
    if (button) { button.disabled = true; button.textContent = "PREPARING CSV…"; }
    setStatus("");

    return apiFetch("/.netlify/functions/get-group-info?portalId=" + encodeURIComponent(portalId))
      .then(function (res) {
        if (!res.ok) throw new Error("Server returned " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data && data.error) throw new Error(data.error);
        var program = safeName(data.program && data.program.name);
        var files = buildGroupCsvs(data).map(function (f) {
          return { name: "Expedition-Leader-Info-" + program + "/" + f.name, text: f.text };
        });
        var zip = zipStore(files, data.generatedAt ? new Date(data.generatedAt) : new Date());
        triggerDownload(new Blob([zip], { type: "application/zip" }),
                        "Expedition-Leader-Info-" + program + "-CSV.zip");
        if (button) { button.disabled = false; button.textContent = originalText; }
      })
      .catch(function (err) {
        console.error("[group-csv] download failed:", err);
        if (button) { button.disabled = false; button.textContent = originalText; }
        setStatus("Could not generate the CSVs: " + (err && err.message ? err.message : "unknown error"));
        throw err;
      });
  }

  var api = {
    buildGroupCsvs: buildGroupCsvs,
    downloadGroupInfoCsv: downloadGroupInfoCsv,
    _toCsv: toCsv,
    _csvCell: csvCell,
    _zipStore: zipStore,
    _crc32: crc32,
  };
  global.GroupCsv = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
