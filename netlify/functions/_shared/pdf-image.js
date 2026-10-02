// Pulls the scanned photo out of a scanner-app PDF.
//
// Scanner apps (TapScanner, Adobe Scan, iOS Files, macOS Preview) save a
// passport as a PDF that is one image wrapped in a page. A PDF can't be
// rotated or repaired the way a photo can, so when a PDF read fails we take
// that image out and treat it like any other photo upload — which lets a
// sideways scan be turned upright before the retry.
//
// Handles the encodings scanner PDFs actually use:
//   - DCTDecode                     a JPEG, used byte-for-byte
//   - [FlateDecode, DCTDecode]      a zipped JPEG
//   - FlateDecode                   zipped raw pixels (8-bit Gray / RGB / CMYK,
//                                   ICC-based or Indexed), with or without PNG
//                                   row predictors
// Anything else (JPEG 2000, JBIG2, CCITT fax) is reported, not decoded.
//
// Returns, for the largest image found:
//   { base64, mediaType: "image/jpeg", pageRotation }   for a JPEG
//   { pixels: { width, height, data /* RGBA */ }, pageRotation }   for raw pixels
// or { none: "<what was found>" } so the log says why nothing came out.
// `pageRotation` is the first page's /Rotate: images are stored un-rotated.

import zlib from "zlib";
import {
  PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray, PDFDict, PDFRef,
  PDFString, PDFHexString,
} from "pdf-lib";

const MAX_PIXELS = 60_000_000;

export async function largestImageFromPdf(base64) {
  let doc;
  try {
    doc = await PDFDocument.load(Buffer.from(base64, "base64"), { updateMetadata: false });
  } catch (err) {
    return { none: `unreadable-pdf(${String(err?.message || err).slice(0, 40)})` };
  }
  const resolve = (v) => (v instanceof PDFRef ? doc.context.lookup(v) : v);

  const images = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (resolve(dict.get(PDFName.of("Subtype"))) !== PDFName.of("Image")) continue;
    const num = (k) => { const v = resolve(dict.get(PDFName.of(k))); return v instanceof PDFNumber ? v.asNumber() : 0; };
    const width = num("Width"), height = num("Height");
    const f = resolve(dict.get(PDFName.of("Filter")));
    const filters = !f ? [] : (f instanceof PDFArray ? f.asArray().map(resolve) : [f]).map(n => String(n).replace("/", ""));
    images.push({ obj, dict, width, height, filters });
  }
  if (images.length === 0) return { none: "no-images" };

  images.sort((a, b) => b.width * b.height - a.width * a.height);
  const pageRotation = (() => {
    try { const p = doc.getPages()[0]; return p ? (((p.getRotation().angle || 0) % 360) + 360) % 360 : 0; }
    catch { return 0; }
  })();

  const tried = [];
  for (const img of images.slice(0, 3)) {
    const label = `${img.filters.join("+") || "raw"}:${img.width}x${img.height}`;
    try {
      const out = decodeImage(img, resolve);
      if (out) return { ...out, pageRotation, found: label };
      tried.push(label);
    } catch (err) {
      tried.push(`${label}(${String(err?.message || err).slice(0, 30)})`);
    }
  }
  return { none: tried.join(",") };
}

function decodeImage({ obj, dict, width, height, filters }, resolve) {
  const raw = Buffer.from(obj.getContents());

  if (filters.length === 1 && filters[0] === "DCTDecode") {
    return { base64: raw.toString("base64"), mediaType: "image/jpeg" };
  }
  if (filters.length === 2 && filters[0] === "FlateDecode" && filters[1] === "DCTDecode") {
    return { base64: zlib.inflateSync(raw).toString("base64"), mediaType: "image/jpeg" };
  }
  if (!(filters.length === 1 && filters[0] === "FlateDecode") && filters.length !== 0) return null;
  if (!width || !height || width * height > MAX_PIXELS) return null;

  const bpcObj = resolve(dict.get(PDFName.of("BitsPerComponent")));
  const bpc = bpcObj instanceof PDFNumber ? bpcObj.asNumber() : 8;
  if (bpc !== 8) return null;

  const cs = colourSpace(resolve(dict.get(PDFName.of("ColorSpace"))), resolve);
  if (!cs) return null;

  let bytes = filters.length ? zlib.inflateSync(raw) : raw;
  const parms = resolve(dict.get(PDFName.of("DecodeParms")));
  const predictor = parms instanceof PDFDict && resolve(parms.get(PDFName.of("Predictor")));
  if (predictor instanceof PDFNumber && predictor.asNumber() >= 10) {
    bytes = unpredictPng(bytes, width, height, cs.components);
  } else if (predictor instanceof PDFNumber && predictor.asNumber() === 2) {
    return null; // TIFF predictor: not seen in scanner output, not worth guessing
  }

  const rowLen = width * cs.components;
  if (bytes.length < rowLen * height) return null;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += cs.components) {
    const [r, g, b] = cs.toRgb(bytes, p);
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return { pixels: { width, height, data } };
}

// Returns { components, toRgb(bytes, offset) } or null.
function colourSpace(cs, resolve) {
  const gray = { components: 1, toRgb: (b, p) => [b[p], b[p], b[p]] };
  const rgb = { components: 3, toRgb: (b, p) => [b[p], b[p + 1], b[p + 2]] };
  const cmyk = { components: 4, toRgb: (b, p) => {
    const k = 255 - b[p + 3];
    return [(255 - b[p]) * k / 255, (255 - b[p + 1]) * k / 255, (255 - b[p + 2]) * k / 255];
  } };
  const byName = (n) => n === "/DeviceGray" || n === "/CalGray" ? gray
    : n === "/DeviceRGB" || n === "/CalRGB" ? rgb
    : n === "/DeviceCMYK" ? cmyk : null;

  if (!cs) return gray;
  if (cs instanceof PDFName) return byName(String(cs));
  if (!(cs instanceof PDFArray)) return null;
  const parts = cs.asArray().map(resolve);
  const kind = String(parts[0]);
  if (kind === "/ICCBased") {
    const stream = parts[1];
    const n = stream && stream.dict && resolve(stream.dict.get(PDFName.of("N")));
    const count = n instanceof PDFNumber ? n.asNumber() : 3;
    return count === 1 ? gray : count === 3 ? rgb : count === 4 ? cmyk : null;
  }
  if (kind === "/CalRGB") return rgb;
  if (kind === "/CalGray") return gray;
  if (kind === "/Indexed") {
    const base = colourSpace(parts[1], resolve);
    const lookupObj = parts[3];
    let table;
    if (lookupObj instanceof PDFRawStream) {
      const lf = resolve(lookupObj.dict.get(PDFName.of("Filter")));
      const lb = Buffer.from(lookupObj.getContents());
      table = lf ? zlib.inflateSync(lb) : lb;
    } else if (lookupObj instanceof PDFHexString || lookupObj instanceof PDFString) {
      table = Buffer.from(lookupObj.asBytes());
    }
    if (!base || !table) return null;
    return { components: 1, toRgb: (b, p) => base.toRgb(table, b[p] * base.components) };
  }
  return null;
}

// PNG row filters (PDF predictors 10–15): each row starts with a filter byte.
function unpredictPng(buf, width, height, bpp) {
  const rowLen = width * bpp;
  const out = Buffer.alloc(rowLen * height);
  let prev = Buffer.alloc(rowLen);
  for (let y = 0; y < height; y++) {
    const start = y * (rowLen + 1);
    if (start + rowLen + 1 > buf.length) break;
    const type = buf[start];
    const row = buf.subarray(start + 1, start + 1 + rowLen);
    const cur = Buffer.alloc(rowLen);
    for (let x = 0; x < rowLen; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
    cur.copy(out, y * rowLen);
    prev = cur;
  }
  return out;
}
