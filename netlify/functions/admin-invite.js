// Invite a new admin to the portal.
//
// Flow:
//   1. Caller (the existing admin sending the invite) is authenticated by
//      checking that THEIR contact in HubSpot has a non-empty admin_role.
//      If not, we refuse.
//   2. Look up the invitee's contact by email; create one if it doesn't
//      exist (with optional first/last name from the form).
//   3. Set their admin_role property to the requested role
//      (School Support Manager | Expedition Planning Manager).
//   4. Generate a one-time portal_token + portal_token_expiry, save to
//      the contact, and email them a link to /set-password.html so they
//      can set their password and log in.
//
// Required env vars:
//   HUBSPOT_API_KEY                — read+write contacts
//   SMTP_USER, SMTP_PASS           — Gmail App Password setup (see
//                                    send-magic-link.js for the docs)
//   SMTP_FROM_NAME (optional)      — defaults to "Unearthed Education"
//   PORTAL_BASE_URL (optional)     — defaults to https://portal.unearthededucation.org

import crypto from "crypto";
import nodemailer from "nodemailer";
import { authenticateAdmin } from "./_shared/auth.js";

// Roles the FORM is allowed to ASSIGN to a new admin. The form's dropdown
// is hardcoded to these two — these are the only roles that show up as
// cards on the Expedition Overview. If you want to assign a different
// role (e.g. "Founder", "Director") you can either:
//   (a) edit the dropdown in admin-invite.html to expose it, OR
//   (b) set admin_role on the contact in HubSpot directly.
// Either way, ANY non-empty admin_role grants login + trip-picker access
// to the holder — see the inviter check below.
const ALLOWED_ASSIGNABLE_ROLES = new Set([
  "School Support Manager",
  "Expedition Planning Manager"
]);

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  return cachedTransporter;
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const missing = [];
    if (!process.env.HUBSPOT_API_KEY) missing.push("HUBSPOT_API_KEY");
    if (!process.env.SMTP_USER)       missing.push("SMTP_USER");
    if (!process.env.SMTP_PASS)       missing.push("SMTP_PASS");
    if (missing.length) {
      console.error("[admin-invite] Missing env vars:", missing);
      return jsonResponse(500, { error: `Server is not configured (${missing.join(", ")}).` });
    }

    // Auth: only an admin may invite admins. We take the inviter's identity
    // from the VERIFIED session token, not from a body field — the old code
    // trusted body.inviterEmail, so anyone could claim to be an admin by
    // sending a known admin's email. The live admin_role re-check below then
    // also catches a role that was revoked after the token was issued.
    const auth = authenticateAdmin(event);
    if (auth.response) return auth.response;

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (_) { return jsonResponse(400, { error: "Invalid JSON body" }); }

    const inviterEmail = auth.session.email;
    const inviteeEmail = (body.inviteeEmail || "").toLowerCase().trim();
    const firstName    = (body.firstName    || "").trim();
    const lastName     = (body.lastName     || "").trim();
    const role         = String(body.role   || "").trim();

    if (!inviterEmail || !inviteeEmail || !role) {
      return jsonResponse(400, { error: "Missing inviterEmail, inviteeEmail or role" });
    }
    if (!ALLOWED_ASSIGNABLE_ROLES.has(role)) {
      return jsonResponse(400, { error: `Role must be one of: ${[...ALLOWED_ASSIGNABLE_ROLES].join(", ")}` });
    }

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // 1. Verify the caller is an admin in HubSpot. ANY non-empty
    //    admin_role grants invite permission — not just the two roles
    //    the form lets you assign — so e.g. a "Founder" or "Director"
    //    can also invite School Support Managers / Expedition Planning Managers.
    const inviter = await findContactByEmail(inviterEmail, headers);
    const inviterRole = (inviter?.properties?.admin_role || "").trim();
    if (!inviter || !inviterRole) {
      console.warn(`[admin-invite] Refused — caller ${inviterEmail} has no admin_role set`);
      return jsonResponse(403, { error: "You must be an admin to send invites." });
    }

    // 2. Find or create the invitee.
    let invitee = await findContactByEmail(inviteeEmail, headers);
    if (!invitee) {
      const props = {
        email: inviteeEmail,
        admin_role: role
      };
      if (firstName) props.firstname = firstName;
      if (lastName)  props.lastname  = lastName;

      const createRes = await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts",
        { method: "POST", headers, body: JSON.stringify({ properties: props }) }
      );
      if (!createRes.ok) {
        const text = await createRes.text().catch(() => "");
        console.error(`[admin-invite] Create failed ${createRes.status}: ${text.slice(0, 200)}`);
        return jsonResponse(502, { error: "Could not create contact in HubSpot.", details: `HubSpot ${createRes.status}` });
      }
      invitee = await createRes.json();
    } else {
      // 2b. Existing contact — patch the role + optional name fields.
      const props = { admin_role: role };
      if (firstName && !invitee.properties?.firstname) props.firstname = firstName;
      if (lastName  && !invitee.properties?.lastname)  props.lastname  = lastName;

      const patchRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${invitee.id}`,
        { method: "PATCH", headers, body: JSON.stringify({ properties: props }) }
      );
      if (!patchRes.ok) {
        const text = await patchRes.text().catch(() => "");
        console.error(`[admin-invite] Role patch failed ${patchRes.status}: ${text.slice(0, 200)}`);
        return jsonResponse(502, { error: "Could not set admin role.", details: `HubSpot ${patchRes.status}` });
      }
    }

    // 3. Generate token + save to contact.
    const token  = crypto.randomBytes(32).toString("hex");
    const expiry = Date.now() + 60 * 60 * 1000; // 1 hour
    const tokenPatch = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${invitee.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: {
            portal_token: token,
            portal_token_expiry: expiry.toString()
          }
        })
      }
    );
    if (!tokenPatch.ok) {
      const text = await tokenPatch.text().catch(() => "");
      console.error(`[admin-invite] Token patch failed ${tokenPatch.status}: ${text.slice(0, 200)}`);
      return jsonResponse(502, { error: "Could not save invite token.", details: `HubSpot ${tokenPatch.status}` });
    }

    // 4. Email the invite link.
    const baseUrl = (process.env.PORTAL_BASE_URL || "https://leaders.unearthededucation.org").replace(/\/+$/, "");
    const link    = `${baseUrl}/set-password.html?token=${token}&email=${encodeURIComponent(inviteeEmail)}`;
    const fromName = process.env.SMTP_FROM_NAME || "Unearthed Education";
    const greetingName = firstName || invitee.properties?.firstname || "there";

    try {
      const info = await getTransporter().sendMail({
        from: `"${fromName}" <${process.env.SMTP_USER}>`,
        to: inviteeEmail,
        subject: `You're invited to the Unearthed Portal as ${role}`,
        text: buildPlainText(greetingName, role, link),
        html: buildHtml(greetingName, role, link)
      });
      console.log(`[admin-invite] Sent to ${inviteeEmail} (${role}); messageId=${info.messageId}`);
    } catch (err) {
      console.error("[admin-invite] SMTP send failed:", err?.message || err);
      return jsonResponse(502, { error: "Could not send the invite email.", details: String(err?.message || err) });
    }

    return jsonResponse(200, { success: true, invitee: { email: inviteeEmail, role } });

  } catch (err) {
    console.error("[admin-invite] Unhandled:", err?.stack || err?.message || err);
    return jsonResponse(500, { error: err?.message || "Server error" });
  }
}

async function findContactByEmail(email, headers) {
  const res = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/search",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["email", "firstname", "lastname", "admin_role"]
      })
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.[0] || null;
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

function buildPlainText(name, role, link) {
  return [
    `Hi ${name},`,
    ``,
    `You've been invited to the Unearthed Education portal as a ${role}.`,
    `Tap the link below to set your password and sign in:`,
    ``,
    link,
    ``,
    `This link expires in 1 hour. If you weren't expecting it, you can ignore this email.`,
    ``,
    `— Unearthed Education`,
  ].join("\n");
}

function buildHtml(name, role, link) {
  const safeName = escapeHtml(name);
  const safeRole = escapeHtml(role);
  const safeLink = escapeHtml(link);
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0; padding:0; background:#f5f1e6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; color:#231f20;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1e6;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border:1px solid #e2decf;">
        <tr><td style="padding:32px 32px 8px;">
          <div style="font-size:11px; letter-spacing:1.5px; color:#999; font-weight:600;">UNEARTHED EDUCATION · ADMIN INVITE</div>
          <h1 style="margin:12px 0 0; font-size:22px; font-weight:600; color:#231f20;">You're invited as ${safeRole}</h1>
        </td></tr>
        <tr><td style="padding:16px 32px 8px; font-size:14px; line-height:1.6; color:#444;">
          <p style="margin:0 0 14px;">Hi ${safeName},</p>
          <p style="margin:0 0 14px;">You've been added to the Unearthed Education portal as a <strong>${safeRole}</strong>. Tap the button below to set your password and sign in.</p>
        </td></tr>
        <tr><td align="center" style="padding:8px 32px 24px;">
          <a href="${safeLink}" style="display:inline-block; padding:14px 28px; background:#2d6b74; color:#ffffff; text-decoration:none; font-size:13px; font-weight:600; letter-spacing:1.5px; border-radius:4px;">SET PASSWORD &amp; SIGN IN</a>
        </td></tr>
        <tr><td style="padding:0 32px 8px; font-size:12px; line-height:1.6; color:#666;">
          <p style="margin:0 0 8px;">If the button doesn't work, copy and paste this link into your browser:</p>
          <p style="margin:0 0 16px; word-break:break-all;"><a href="${safeLink}" style="color:#2d6b74;">${safeLink}</a></p>
        </td></tr>
        <tr><td style="padding:0 32px 28px; font-size:12px; line-height:1.6; color:#888; border-top:1px solid #e2decf; padding-top:16px;">
          <p style="margin:14px 0 0;">This link expires in 1 hour. If you weren't expecting this invite, you can ignore the email.</p>
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
