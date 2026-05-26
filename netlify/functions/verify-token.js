export async function handler(event) {
  try {
    const { token, email } = event.queryStringParameters;

    if (!token || !email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing token or email" })
      };
    }

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // Find contact
    const contactRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: "email",
              operator: "EQ",
              value: email
            }]
          }],
          properties: ["email", "portal_token", "portal_token_expiry"]
        })
      }
    );

    const contactData = await contactRes.json();
    const contact = contactData.results?.[0];

    if (!contact) {
      return {
        statusCode: 200,
        body: JSON.stringify({ valid: false, error: "Contact not found" })
      };
    }

    const storedToken = contact.properties?.portal_token;
    const expiry = parseInt(contact.properties?.portal_token_expiry || "0");

    if (storedToken !== token) {
      return {
        statusCode: 200,
        body: JSON.stringify({ valid: false, error: "Invalid token" })
      };
    }

    if (Date.now() > expiry) {
      return {
        statusCode: 200,
        body: JSON.stringify({ valid: false, error: "Link has expired" })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ valid: true })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
