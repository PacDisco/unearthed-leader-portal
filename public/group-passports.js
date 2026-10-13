/*
 * group-passports.js — "DOWNLOAD ALL PASSPORTS (ZIP)" on the Expedition
 * Leader tab.
 *
 * 1. Asks /get-group-passports for the trip's passport manifest: one entry per
 *    person (Expedition Leader → School Leaders → Students, numbered like the
 *    group sheets) with file-bound /document-proxy links for
 *      - passports uploaded with the passport check's UPLOAD PASSPORT button
 *      - the passport on their application form
 * 2. For each person, adds passports uploaded through the documents form
 *    (the VIEW DOCUMENTS uploads, including ones a parent uploaded for their
 *    child) from /get-uploaded-documents — any document whose name or file
 *    name mentions "passport".
 * 3. Downloads every file through /document-proxy (the streaming edge
 *    function, so large phone photos are fine), a few at a time, and zips
 *    them with the store-only writer from group-csv.js:
 *      Passports-<program>/03 Students - Reynolds, Mia.jpg
 *    and, when someone has more than one file,
 *      Passports-<program>/03 Students - Reynolds, Mia (portal upload).jpg
 *      Passports-<program>/03 Students - Reynolds, Mia (application).jpg
 *      Passports-<program>/03 Students - Reynolds, Mia (document upload).pdf
 *    Anyone with no passport in the zip is listed in _MISSING-PASSPORTS.txt.
 *
 * Exposes window.GroupPassports.downloadAllPassports({ portalId, apiFetch,
 * button, setStatus, docsFormIds }). Depends on window.GroupCsv (load
 * group-csv.js first).
 */
(function (global) {
  "use strict";

  var CONCURRENCY = 3;

  var EXT_BY_TYPE = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
    "image/gif": "gif", "image/heic": "heic", "image/heif": "heif", "application/pdf": "pdf",
  };

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // Filesystem-safe, but keeps letters with accents/macrons.
  function clean(s) {
    return String(s == null ? "" : s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function fileBase(p) {
    var who = clean(p.last) && clean(p.first) ? clean(p.last) + ", " + clean(p.first)
      : clean(p.name) || "Unnamed";
    return pad(p.index) + " " + clean(p.role) + " - " + who;
  }

  function extFor(contentType, url) {
    var t = String(contentType || "").split(";")[0].trim().toLowerCase();
    if (EXT_BY_TYPE[t]) return EXT_BY_TYPE[t];
    var raw = String(url || "");
    try { raw = decodeURIComponent(raw); } catch (_) { /* keep raw */ }
    var m = /\.([a-z0-9]{2,5})(?:$|[?#&])/i.exec(raw);
    return m ? m[1].toLowerCase() : "jpg";
  }

  // The underlying file a /document-proxy link points at, so the same file
  // reached two ways (each link carries its own token) is only zipped once.
  function rawTarget(proxyLink) {
    var m = /[?&]url=([^&]+)/.exec(String(proxyLink || ""));
    if (!m) return String(proxyLink || "");
    try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
  }

  function isPassportDoc(d) {
    return /passport/i.test(String((d && d.fieldLabel) || "")) || /passport/i.test(String((d && d.filename) || ""));
  }

  // Adds documents-form passports to a person's file list, skipping files
  // already there. Pure (exported for tests).
  function mergeDocuments(person, documents) {
    var files = (person.files || []).slice();
    var seen = {};
    files.forEach(function (f) { seen[rawTarget(f.url)] = true; });
    (documents || []).filter(isPassportDoc).forEach(function (d) {
      if (!d.url) return;
      var key = rawTarget(d.url);
      if (seen[key]) return;
      seen[key] = true;
      files.push({ source: "document upload", url: d.url });
    });
    return files;
  }

  function safeProgram(s) {
    return (String(s || "").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "-") || "program");
  }

  // Run `worker` over `items` with at most `limit` in flight.
  function pool(items, limit, worker) {
    var i = 0, results = new Array(items.length);
    function next() {
      if (i >= items.length) return Promise.resolve();
      var at = i++;
      return Promise.resolve(worker(items[at], at)).then(function (r) { results[at] = r; return next(); });
    }
    var runners = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) runners.push(next());
    return Promise.all(runners).then(function () { return results; });
  }

  // Pure: people (with .files) + fetched results -> zip entries (exported for
  // tests). fetched[p][f] = { bytes, contentType } | { error }.
  function buildEntries(data, fetched) {
    var people = (data && data.people) || [];
    var program = safeProgram(data && data.program && data.program.name);
    var folder = "Passports-" + program + "/";
    var entries = [], missing = [], used = {}, count = 0;

    people.forEach(function (p, pi) {
      var files = p.files || [];
      var got = (fetched[pi] || []).map(function (r, fi) { return { r: r, file: files[fi] }; })
        .filter(function (x) { return x.r && x.r.bytes; });

      if (!got.length) {
        var failed = (fetched[pi] || []).filter(function (r) { return r && r.error; });
        missing.push(fileBase(p) + " — " + (!files.length ? "no passport on file"
          : "download failed" + (failed.length ? " (" + failed.map(function (r) { return r.error; }).join("; ") + ")" : "")));
        return;
      }

      // Count sources so a second file from the same source gets a number.
      var perSource = {};
      got.forEach(function (x) {
        var base = fileBase(p);
        var src = x.file.source || "file";
        perSource[src] = (perSource[src] || 0) + 1;
        if (got.length > 1) base += " (" + src + (perSource[src] > 1 ? " " + perSource[src] : "") + ")";
        var name = folder + base + "." + extFor(x.r.contentType, x.file.url);
        var n = 2;
        while (used[name]) name = folder + base + " " + (n++) + "." + extFor(x.r.contentType, x.file.url);
        used[name] = true;
        entries.push({ name: name, bytes: x.r.bytes });
        count += 1;
      });
    });

    if (missing.length) {
      entries.push({
        name: folder + "_MISSING-PASSPORTS.txt",
        text: "No passport image in this download for:\r\n\r\n" + missing.join("\r\n") + "\r\n",
      });
    }
    return { entries: entries, missing: missing, count: count, program: program };
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function fetchFile(url) {
    // Plain fetch: the doc token in the URL is the credential.
    return global.fetch(url, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        var type = res.headers.get("content-type") || "";
        return res.arrayBuffer().then(function (buf) {
          if (!buf.byteLength) throw new Error("empty file");
          return { bytes: new Uint8Array(buf), contentType: type };
        });
      })
      .catch(function (err) { return { error: err && err.message ? err.message : "error" }; });
  }

  function downloadAllPassports(opts) {
    opts = opts || {};
    var portalId = opts.portalId;
    var apiFetch = opts.apiFetch;
    var button = opts.button || null;
    var setStatus = opts.setStatus || function () {};
    var docsFormIds = String(opts.docsFormIds || "").trim();

    if (!portalId) { setStatus("No program id available."); return Promise.reject(new Error("Missing portalId")); }
    if (!global.GroupCsv || typeof global.GroupCsv._zipStore !== "function") {
      setStatus("Zip module failed to load. Please refresh and try again.");
      return Promise.reject(new Error("GroupCsv missing"));
    }

    var originalText = button ? button.textContent : "";
    function label(t) { if (button) button.textContent = t; }
    if (button) button.disabled = true;
    label("FINDING PASSPORTS…");
    setStatus("");

    var manifest, docWarnings = 0;
    return apiFetch("/.netlify/functions/get-group-passports?portalId=" + encodeURIComponent(portalId))
      .then(function (res) {
        if (!res.ok) throw new Error("Server returned " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data && data.error) throw new Error(data.error);
        manifest = data;
        var people = data.people || [];
        if (!docsFormIds) return null;

        // Documents-form passports, one lookup per person.
        var checked = 0;
        label("CHECKING DOCUMENTS 0/" + people.length + "…");
        return pool(people, CONCURRENCY, function (p) {
          if (!p.email) return null;
          return apiFetch("/.netlify/functions/get-uploaded-documents?email=" + encodeURIComponent(p.email) +
                          "&formIds=" + encodeURIComponent(docsFormIds))
            .then(function (res) { return res.json().catch(function () { return {}; }); })
            .then(function (d) {
              if (d && d.error) docWarnings += 1;
              p.files = mergeDocuments(p, (d && d.documents) || []);
            })
            .catch(function () { docWarnings += 1; })
            .then(function () { checked += 1; label("CHECKING DOCUMENTS " + checked + "/" + people.length + "…"); });
        });
      })
      .then(function () {
        var people = manifest.people || [];
        var jobs = [];
        people.forEach(function (p, pi) {
          (p.files || []).forEach(function (f, fi) { jobs.push({ pi: pi, fi: fi, url: f.url }); });
        });
        if (!jobs.length) throw new Error("No passport images are on file for this program yet.");

        var done = 0;
        label("DOWNLOADING 0/" + jobs.length + "…");
        var fetched = people.map(function () { return []; });
        return pool(jobs, CONCURRENCY, function (j) {
          return fetchFile(j.url).then(function (r) {
            fetched[j.pi][j.fi] = r;
            done += 1;
            label("DOWNLOADING " + done + "/" + jobs.length + "…");
          });
        }).then(function () { return fetched; });
      })
      .then(function (fetched) {
        label("ZIPPING…");
        var built = buildEntries(manifest, fetched);
        if (!built.count) throw new Error("None of the passport images could be downloaded.");
        var zip = global.GroupCsv._zipStore(built.entries, new Date());
        triggerDownload(new Blob([zip], { type: "application/zip" }), "Passports-" + built.program + ".zip");
        if (button) { button.disabled = false; button.textContent = originalText; }
        var notes = [];
        if (built.missing.length) notes.push(built.missing.length + " people have no passport in the zip — see _MISSING-PASSPORTS.txt.");
        if (docWarnings) notes.push("Uploaded documents couldn't be checked for " + docWarnings + " people.");
        setStatus(notes.length ? built.count + " passport files downloaded. " + notes.join(" ") : "");
      })
      .catch(function (err) {
        console.error("[group-passports] download failed:", err);
        if (button) { button.disabled = false; button.textContent = originalText; }
        setStatus("Could not download the passports: " + (err && err.message ? err.message : "unknown error"));
        throw err;
      });
  }

  var api = {
    downloadAllPassports: downloadAllPassports,
    _buildEntries: buildEntries,
    _mergeDocuments: mergeDocuments,
    _fileBase: fileBase,
    _extFor: extFor,
  };
  global.GroupPassports = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
