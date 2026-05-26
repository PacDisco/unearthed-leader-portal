// Returns the public VAPID key the browser needs to subscribe to Web
// Push. Public keys are not secrets — they only authenticate the SENDER
// to the push service, so it's safe to expose here.
//
// Required Netlify env var:
//   VAPID_PUBLIC_KEY  — the public half of the VAPID key pair you
//                       generated locally with:
//                         npx web-push generate-vapid-keys
//                       (don't commit either half to source control;
//                       set both halves as Netlify env vars).

export async function handler() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  if (!publicKey) {
    return jsonResponse(500, {
      error: "Push is not configured",
      details: "Set VAPID_PUBLIC_KEY in Netlify environment variables."
    });
  }
  return jsonResponse(200, { publicKey });
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    body: JSON.stringify(payload)
  };
}
