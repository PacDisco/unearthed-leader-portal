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

const MAX_PIXELS = 25_000_000; // ~100MB of RGBA; bigger than any phone photo

export function rotateImage({ base64, mediaType }, degrees) {
  const turn = ((Number(degrees) % 360) + 360) % 360;
  if (![90, 180, 270].includes(turn)) return null;
  try {
    const input = Buffer.from(base64, "base64");
    let width, height, data;
    if (mediaType === "image/jpeg") {
      ({ width, height, data } = jpeg.decode(input, { useTArray: true, maxMemoryUsageInMB: 512 }));
    } else if (mediaType === "image/png") {
      ({ width, height, data } = PNG.sync.read(input));
    } else {
      return null;
    }
    if (width * height > MAX_PIXELS) return null;

    const outW = turn === 180 ? width : height;
    const outH = turn === 180 ? height : width;
    const out = Buffer.alloc(outW * outH * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let nx, ny;
        if (turn === 90) { nx = height - 1 - y; ny = x; }
        else if (turn === 180) { nx = width - 1 - x; ny = height - 1 - y; }
        else { nx = y; ny = width - 1 - x; }
        const s = (y * width + x) * 4;
        const d = (ny * outW + nx) * 4;
        out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 255;
      }
    }
    const encoded = jpeg.encode({ data: out, width: outW, height: outH }, 92);
    return { base64: Buffer.from(encoded.data).toString("base64"), mediaType: "image/jpeg" };
  } catch (err) {
    console.warn("[image-rotate] could not rotate:", err?.message || err);
    return null;
  }
}
