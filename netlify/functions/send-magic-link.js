// Issues a magic-link / forgot-password email for a portal user.
//
// Flow:
//   1. Look up the contact in HubSpot by email.
//   2. Generate a one-time token, save it (+ expiry) on the contact's
//      portal_token / portal_token_expiry properties.
//   3. Send an email directly via Gmail SMTP from info@unearthededucation.org,
//      using a Google App Password. (Previous version used a Zapier webhook;
//      that path was removed when we moved to direct sending.)
//
// Required Netlify environment variables:
//   HUBSPOT_API_KEY    — HubSpot private app token, must allow read+write
//                        on contacts (we read email/firstname and patch
//                        portal_token / portal_token_expiry).
//   SMTP_USER          — Gmail / Google Workspace mailbox we send AS.
//                        Typically "info@unearthededucation.org".
//   SMTP_PASS          — App Password (NOT the account's real password).
//                        Generated at https://myaccount.google.com/apppasswords
//                        with 2-Step Verification enabled on the account.
//
// Optional:
//   SMTP_FROM_NAME     — Sender display name. Defaults to "Unearthed Education".
//   PORTAL_BASE_URL    — Base URL the magic link points to. Defaults to
//                        https://portal.unearthededucation.org. Useful for
//                        testing on Netlify deploy previews.
//
// Sending limits worth knowing about:
//   - Gmail free  ~500 messages / day
//   - Workspace   ~2000 messages / day
//   Either is way more than this portal will ever need, but exceeding it
//   triggers a temporary block. If we ever start doing bulk announcements
//   from this account, switch to a transactional provider (Resend,
//   Postmark, SendGrid).

import crypto from "crypto";
import nodemailer from "nodemailer";

// We create the transport lazily on first call (and reuse across warm
// invocations) so we don't keep an SMTP socket open between cold starts
// or pay the auth cost when Netlify spins up a fresh Function instance.
let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // STARTTLS upgrade — Gmail rejects port-465 with port-587 settings
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return cachedTransporter;
}

export async function handler(event) {
  try {
    const { email } = JSON.parse(event.body || "{}");

    if (!email) {
      return jsonResponse(400, { error: "Missing email" });
    }

    const cleanEmail = String(email).toLowerCase().trim();

    // Validate environment configuration up-front so we don't get halfway
    // through (token saved, no email sent) before discovering a missing var.
    const missing = [];
    if (!process.env.HUBSPOT_API_KEY) missing.push("HUBSPOT_API_KEY");
    if (!process.env.SMTP_USER)       missing.push("SMTP_USER");
    if (!process.env.SMTP_PASS)       missing.push("SMTP_PASS");
    if (missing.length) {
      console.error(`[send-magic-link] Missing env vars: ${missing.join(", ")}`);
      return jsonResponse(500, { error: `Server is not configured (${missing.join(", ")}).` });
    }

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
    };

    // 1. Find contact in HubSpot.
    const contactRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: cleanEmail }] }],
          // portal_token_expiry lets us enforce a send cooldown without a new
          // property: a link's expiry is always issue-time + 1h, so we can
          // recover roughly when the last link went out.
          properties: ["email", "firstname", "portal_token_expiry"],
        }),
      }
    );

    if (!contactRes.ok) {
      const text = await contactRes.text().catch(() => "");
      console.error(`[send-magic-link] HubSpot search failed ${contactRes.status}: ${text.slice(0, 300)}`);
      return jsonResponse(502, { error: "Could not look up your account.", details: `HubSpot ${contactRes.status}` });
    }

    const contactData = await contactRes.json();
    const contact = contactData.results?.[0];

    if (!contact) {
      console.warn("[send-magic-link] magic-link requested for an unknown email");
      // Don't leak existence: return 200 with a generic success message.
      // Frontend says "If your email is in our system, you'll get a link"
      // regardless of whether the account actually existed.
      return jsonResponse(200, { success: true });
    }

    // Cooldown: don't fire off another email if we sent one to this account
    // within the last 60s (anti-bombing). A link's expiry is issue-time + 1h,
    // so issue-time ≈ expiry - 1h. Returns the same generic success so the
    // response shape doesn't reveal whether a send actually happened.
    const COOLDOWN_MS = 60 * 1000;
    const prevExpiry = parseInt(contact.properties?.portal_token_expiry || "0", 10) || 0;
    const prevIssuedAt = prevExpiry - 60 * 60 * 1000;
    if (prevIssuedAt > 0 && (Date.now() - prevIssuedAt) < COOLDOWN_MS) {
      console.warn("[send-magic-link] suppressed — within cooldown for this account");
      return jsonResponse(200, { success: true });
    }

    // 2. Generate token + expiry.
    const token  = crypto.randomBytes(32).toString("hex");
    const expiry = Date.now() + 60 * 60 * 1000; // 1 hour

    // 3. Save token to HubSpot.
    const patchRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: {
            portal_token: token,
            portal_token_expiry: expiry.toString(),
          },
        }),
      }
    );

    if (!patchRes.ok) {
      const text = await patchRes.text().catch(() => "");
      console.error(`[send-magic-link] HubSpot patch failed ${patchRes.status}: ${text.slice(0, 300)}`);
      return jsonResponse(502, { error: "Could not save your reset token.", details: `HubSpot ${patchRes.status}` });
    }

    // 4. Build link + send email.
    const baseUrl   = (process.env.PORTAL_BASE_URL || "https://leaders.unearthededucation.org").replace(/\/+$/, "");
    const link      = `${baseUrl}/set-password.html?token=${token}&email=${encodeURIComponent(cleanEmail)}`;
    const firstName = contact.properties?.firstname || "there";
    const fromName  = process.env.SMTP_FROM_NAME || "Unearthed Education";

    try {
      const info = await getTransporter().sendMail({
        from: `"${fromName}" <${process.env.SMTP_USER}>`,
        to: cleanEmail,
        subject: "Set your Unearthed Portal password",
        text: buildPlainText(firstName, link),
        html: buildHtml(firstName, link),
      });
      console.log(`[send-magic-link] Sent to ${cleanEmail}; messageId=${info.messageId}; response=${info.response}`);
    } catch (err) {
      // Most common errors here:
      //   - "Invalid login: 535-5.7.8 Username and Password not accepted"
      //     → SMTP_PASS is wrong, or 2FA isn't on, or you used the
      //     account password instead of an App Password.
      //   - "self signed certificate in certificate chain" → very rare,
      //     would mean a corporate proxy is intercepting TLS.
      //   - "Greeting never received" / connection timeout → outbound
      //     SMTP blocked at the network layer. Netlify allows it.
      console.error("[send-magic-link] SMTP send failed:", err?.message || err);
      return jsonResponse(502, {
        error: "Could not send the email.",
        details: String(err?.message || err),
      });
    }

    return jsonResponse(200, { success: true });

  } catch (err) {
    console.error("[send-magic-link] Unhandled error:", err?.stack || err?.message || err);
    return jsonResponse(500, { error: err?.message || "Server error" });
  }
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

// ---------- email body builders ----------

function buildPlainText(firstName, link) {
  return [
    `Hi ${firstName},`,
    ``,
    `Tap the link below to set your password for the Unearthed Education parent portal.`,
    ``,
    link,
    ``,
    `This link expires in 1 hour. If you didn't request it, you can ignore this email.`,
    ``,
    `— Unearthed Education`,
  ].join("\n");
}

function buildHtml(firstName, link) {
  // Inline styles so the email renders the same in Gmail, Apple Mail,
  // Outlook web, and the mobile clients without a stylesheet. Simple
  // single-column layout, ~600px max — standard email-client safe.
  // The escapeHtml() guard keeps stray quotes / angle brackets from
  // breaking the layout if a contact's first name has unusual chars.
  const safeName = escapeHtml(firstName);
  const safeLink = escapeHtml(link);
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0; padding:0; background:#f5f1e6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; color:#231f20;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1e6;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border:1px solid #e2decf;">
        <tr><td style="padding:32px 32px 8px;">
          <div style="font-size:11px; letter-spacing:1.5px; color:#999; font-weight:600;">UNEARTHED EDUCATION</div>
          <h1 style="margin:12px 0 0; font-size:22px; font-weight:600; color:#231f20;">Set your portal password</h1>
        </td></tr>
        <tr><td style="padding:16px 32px 8px; font-size:14px; line-height:1.6; color:#444;">
          <p style="margin:0 0 14px;">Hi ${safeName},</p>
          <p style="margin:0 0 14px;">Tap the button below to set your password for the Unearthed Education parent portal.</p>
        </td></tr>
        <tr><td align="center" style="padding:8px 32px 24px;">
          <a href="${safeLink}" style="display:inline-block; padding:14px 28px; background:#5b7f9e; color:#ffffff; text-decoration:none; font-size:13px; font-weight:600; letter-spacing:1.5px; border-radius:4px;">SET PASSWORD</a>
        </td></tr>
        <tr><td style="padding:0 32px 8px; font-size:12px; line-height:1.6; color:#666;">
          <p style="margin:0 0 8px;">If the button doesn't work, copy and paste this link into your browser:</p>
          <p style="margin:0 0 16px; word-break:break-all;"><a href="${safeLink}" style="color:#5b7f9e;">${safeLink}</a></p>
        </td></tr>
        <tr><td style="padding:0 32px 28px; font-size:12px; line-height:1.6; color:#888; border-top:1px solid #e2decf; padding-top:16px;">
          <p style="margin:14px 0 0;">This link expires in 1 hour. If you didn't request it, you can ignore this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
