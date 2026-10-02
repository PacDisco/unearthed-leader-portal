// Rotates a passport image so its machine-readable zone reads left to right.
//
// Vision models transcribe sideways text noticeably worse than upright text,
// and a scanned two-page spread is very often sideways (the MRZ runs up the
// edge of the page). The first read reports which way the page is turned;
// this turns it upright for the retry. Pure JS (jpeg-js / pngjs) so it runs
// in a Netlify function with no native binaries.
//
// `degrees` is how far to rotate CLOCKWISE: 90, 180 or 270. Returns
// { base64, mediaType } or null when the type isn't supported or decoding
// fails — the caller then simply skips the rotated retry.

import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const MAX_PIXELS = 60_000_000;  // decode cap (~240MB RGBA); scanner pages are well under
const MAX_SIDE = 2000;           // the model downsizes to ~1.5k anyway; this keeps payloads small

// `degrees`: 0, 90, 180 or 270 clockwise. 0 still re-encodes (and downsizes),
// which is how an oversized photo pulled out of a PDF is made sendable.
// Also accepts already-decoded pixels — { pixels: { width, height, data } }
// with RGBA data — which is how an image pulled out of a PDF arrives.
export function rotateImage({ base64, mediaType, pixels }, degrees) {
  const turn = ((Number(degrees) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(turn)) return null;
  try {
    let width, height, data;
    const input = pixels ? null : Buffer.from(base64, "base64");
    if (pixels) {
      ({ width, height, data } = pixels);
    } else if (mediaType === "image/jpeg") {
      ({ width, height, data } = jpeg.decode(input, { useTArray: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 100 }));
    } else if (mediaType === "image/png") {
      ({ width, height, data } = PNG.sync.read(input));
    } else {
      return null;
    }
    if (width * height > MAX_PIXELS) return null;

    // Box-free nearest-neighbour downscale folded into the rotation: for each
    // OUTPUT pixel, find its source pixel. Plenty for text at this size.
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const sw = Math.max(1, Math.round(width * scale));
    const sh = Math.max(1, Math.round(height * scale));
    const outW = (turn === 90 || turn === 270) ? sh : sw;
    const outH = (turn === 90 || turn === 270) ? sw : sh;
    const out = Buffer.alloc(outW * outH * 4);
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        // position in the scaled, un-rotated image
        let x, y;
        if (turn === 0) { x = ox; y = oy; }
        else if (turn === 90) { x = oy; y = sh - 1 - ox; }
        else if (turn === 180) { x = sw - 1 - ox; y = sh - 1 - oy; }
        else { x = sw - 1 - oy; y = ox; }
        const srcX = Math.min(width - 1, Math.floor(x / scale));
        const srcY = Math.min(height - 1, Math.floor(y / scale));
        const s4 = (srcY * width + srcX) * 4;
        const d4 = (oy * outW + ox) * 4;
        out[d4] = data[s4]; out[d4 + 1] = data[s4 + 1]; out[d4 + 2] = data[s4 + 2]; out[d4 + 3] = 255;
      }
    }
    const encoded = jpeg.encode({ data: out, width: outW, height: outH }, 92);
    return { base64: Buffer.from(encoded.data).toString("base64"), mediaType: "image/jpeg" };
  } catch (err) {
    console.warn("[image-rotate] could not rotate:", err?.message || err);
    return null;
  }
}
