import { authenticate } from "./_shared/auth.js";

export async function handler(event) {
  try {
    // Auth: any signed-in user (shared content, but kept behind login).
    const auth = authenticate(event);
    if (auth.response) return auth.response;

    const OBJECT = "2-58156993";
    const FIXED_ID = "50506535214";
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${FIXED_ID}?properties=insurance_overview__faqs,insurance_policy_wording,payment_form_url,payments_information_content,faqs,documents_upload_form`,
      { headers }
    );

    if (!res.ok) {
      console.error("[get-insurance] fetch failed:", (await res.text().catch(() => "")).slice(0, 300));
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Fixed object fetch failed" })
      };
    }

    const data = await res.json();

    return {
      statusCode: 200,
      body: JSON.stringify({
        insurance_overview__faqs: data.properties?.insurance_overview__faqs || null,
        insurance_policy_wording: data.properties?.insurance_policy_wording || null,
        payment_form_url: data.properties?.payment_form_url || null,
        payments_information_content: data.properties?.payments_information_content || null,
        // Renamed in the response so the frontend can disambiguate from the
        // per-trip `faqs` it already gets via portal.js → portalData.
        global_faqs: data.properties?.faqs || null,
        // Jotform URL where parents/students upload documents.
        documents_upload_form: data.properties?.documents_upload_form || null
      })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" })
    };
  }
}
