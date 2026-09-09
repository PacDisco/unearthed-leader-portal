import { authenticate } from "./_shared/auth.js";

export async function handler(event) {
  try {
    // Auth: any signed-in user (shared content, but kept behind login).
    const auth = await authenticate(event);
    if (auth.response) return auth.response;

    const OBJECT = "2-58156993";
    const FIXED_ID = "50506535214";
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${FIXED_ID}?properties=insurance_overview__faqs,insurance_policy_wording,visa_information,flights__insurance_1_name,flights__insurance_1_url,flights__insurance_2_name,flights__insurance_2_url,flights__insurance_3_name,flights__insurance_3_url,payment_form_url,payments_information_content,faqs,documents_upload_form`,
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
        visa_information: data.properties?.visa_information || null,
        // Extra ad-hoc Flights/Insurance links (paired name + url, 1..3).
        // Same trip-overrides-global rule as the three fixed links above:
        // portal.js merges the trip record, and these are the global
        // fallbacks for a link that every trip shares.
        flights__insurance_1_name: data.properties?.flights__insurance_1_name || null,
        flights__insurance_1_url:  data.properties?.flights__insurance_1_url  || null,
        flights__insurance_2_name: data.properties?.flights__insurance_2_name || null,
        flights__insurance_2_url:  data.properties?.flights__insurance_2_url  || null,
        flights__insurance_3_name: data.properties?.flights__insurance_3_name || null,
        flights__insurance_3_url:  data.properties?.flights__insurance_3_url  || null,
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
