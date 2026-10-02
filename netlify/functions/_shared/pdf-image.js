// Pulls the scanned photo out of a scanner-app PDF.
//
// Scanner apps (TapScanner, Adobe Scan, iOS Files) save a passport as a PDF
// that is nothing more than one JPEG wrapped in a page. A PDF can't be
// rotated or repaired the way a photo can, so when a PDF read fails we take
// that JPEG out and treat it like any other photo upload — which lets a
// sideways scan be turned upright before the retry.
//
// Returns { base64, mediaType: "image/jpeg", pageRotation } for the largest
// JPEG on the first page that has one, or null (no JPEG, encrypted, broken).
// `pageRotation` is the page's /Rotate: the JPEG is stored un-rotated, so a
// viewer's "upright" is the JPEG turned by that much.

import { PDFDocument, PDFName, PDFRawStream, PDFNumber } from "pdf-lib";

export async function largestJpegFromPdf(base64) {
  try {
    const doc = await PDFDocument.load(Buffer.from(base64, "base64"), {
      ignoreEncryption: false, updateMetadata: false,
    });
    let best = null;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
      const filter = dict.get(PDFName.of("Filter"));
      const filters = filter ? (filter.asArray ? filter.asArray() : [filter]) : [];
      // Only a plain DCT (JPEG) stream can be used byte-for-byte.
      if (filters.length !== 1 || filters[0] !== PDFName.of("DCTDecode")) continue;
      const w = dict.get(PDFName.of("Width")), h = dict.get(PDFName.of("Height"));
      const area = (w instanceof PDFNumber ? w.asNumber() : 0) * (h instanceof PDFNumber ? h.asNumber() : 0);
      if (!best || area > best.area) best = { area, bytes: obj.getContents() };
    }
    if (!best) return null;
    const page = doc.getPages()[0];
    const pageRotation = page ? (((page.getRotation().angle || 0) % 360) + 360) % 360 : 0;
    return { base64: Buffer.from(best.bytes).toString("base64"), mediaType: "image/jpeg", pageRotation };
  } catch (err) {
    console.warn("[pdf-image] could not extract:", err?.message || err);
    return null;
  }
}
