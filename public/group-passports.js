/*
 * group-passports.js — "DOWNLOAD ALL PASSPORTS (ZIP)" on the Expedition
 * Leader tab.
 *
 * 1. Asks /get-group-passports for the trip's passport manifest: one entry per
 *    person (Expedition Leader → School Leaders → Students, numbered like the
 *    group sheets) with a file-bound /document-proxy link, or none.
 * 2. Downloads each file through /document-proxy (the streaming edge
 *    function, so large phone photos are fine), a few at a time.
 * 3. Zips them with the store-only writer from group-csv.js and downloads
 *    Passports-<program>.zip, named "03 Students - Reynolds, Mia.jpg" etc.
 *    Anyone without a passport on file, or whose file couldn't be fetched, is
 *    listed in _MISSING-PASSPORTS.txt inside the zip, so a short zip is
 *    never silent about who's absent.
 *
 * Exposes window.GroupPassports.downloadAllPassports({ portalId, apiFetch,
 * button, setStatus }). Depends on window.GroupCsv (load group-csv.js first).
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
    var m = /\.([a-z0-9]{2,5})(?:$|[?#&])/i.exec(decodeURIComponent(String(url || "")));
    return m ? m[1].toLowerCase() : "jpg";
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

  // Pure: manifest + fetched files -> zip entries (exported for tests).
  // fetched[i] = { bytes, contentType } | { error } | null, aligned with people.
  function buildEntries(data, fetched) {
    var people = (data && data.people) || [];
    var program = safeProgram(data && data.program && data.program.name);
    var folder = "Passports-" + program + "/";
    var entries = [], missing = [];
    people.forEach(function (p, i) {
      var f = fetched[i];
      if (f && f.bytes) {
        entries.push({ name: folder + fileBase(p) + "." + extFor(f.contentType, p.url), bytes: f.bytes });
      } else {
        missing.push(fileBase(p) + " — " + (!p.url ? "no passport on file" : "download failed" + (f && f.error ? " (" + f.error + ")" : "")));
      }
    });
    if (missing.length) {
      entries.push({
        name: folder + "_MISSING-PASSPORTS.txt",
        text: "No passport image in this download for:\r\n\r\n" + missing.join("\r\n") + "\r\n",
      });
    }
    return { entries: entries, missing: missing, count: entries.length - (missing.length ? 1 : 0), program: program };
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

  function downloadAllPassports(opts) {
    opts = opts || {};
    var portalId = opts.portalId;
    var apiFetch = opts.apiFetch;
    var button = opts.button || null;
    var setStatus = opts.setStatus || function () {};

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

    var manifest;
    return apiFetch("/.netlify/functions/get-group-passports?portalId=" + encodeURIComponent(portalId))
      .then(function (res) {
        if (!res.ok) throw new Error("Server returned " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data && data.error) throw new Error(data.error);
        manifest = data;
        var people = data.people || [];
        var total = people.filter(function (p) { return p.url; }).length;
        if (!total) throw new Error("No passport images are on file for this program yet.");
        var done = 0;
        label("DOWNLOADING 0/" + total + "…");
        return pool(people, CONCURRENCY, function (p) {
          if (!p.url) return null;
          // Plain fetch: the doc token in the URL is the credential.
          return global.fetch(p.url, { credentials: "same-origin" })
            .then(function (res) {
              if (!res.ok) throw new Error("HTTP " + res.status);
              var type = res.headers.get("content-type") || "";
              return res.arrayBuffer().then(function (buf) {
                if (!buf.byteLength) throw new Error("empty file");
                return { bytes: new Uint8Array(buf), contentType: type };
              });
            })
            .catch(function (err) { return { error: err && err.message ? err.message : "error" }; })
            .then(function (r) { done += 1; label("DOWNLOADING " + done + "/" + total + "…"); return r; });
        });
      })
      .then(function (fetched) {
        label("ZIPPING…");
        var built = buildEntries(manifest, fetched);
        if (!built.count) throw new Error("None of the passport images could be downloaded.");
        var zip = global.GroupCsv._zipStore(built.entries, new Date());
        triggerDownload(new Blob([zip], { type: "application/zip" }), "Passports-" + built.program + ".zip");
        if (button) { button.disabled = false; button.textContent = originalText; }
        setStatus(built.missing.length
          ? built.count + " passports downloaded. " + built.missing.length +
            " missing — see _MISSING-PASSPORTS.txt in the zip."
          : "");
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
    _fileBase: fileBase,
    _extFor: extFor,
  };
  global.GroupPassports = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
