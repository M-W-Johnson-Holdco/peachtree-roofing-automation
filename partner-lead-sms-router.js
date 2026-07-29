// =====================================================================
// Peachtree Roofing — Partner / Lead SMS Router (RingCentral)
// Cloudflare Worker, driven by a RingCentral number's inbound-SMS webhook
//
// WHAT THIS DOES
// One RingCentral number handles two flows depending on what's texted in:
//   - Text "partner"   -> auto-reply with the business-partner contact form
//   - Text anything else (a partner's referral code, e.g. "ABC123")
//                       -> auto-reply with the lead form, with that code
//                          appended as a URL param so it can prefill
//
// WHY THIS LOOKS DIFFERENT FROM A TWILIO WEBHOOK
// RingCentral has no "reply inline in the webhook response" shortcut.
// Instead:
//   1. You create a WebHook "subscription" telling RC to POST to this
//      Worker whenever an inbound SMS arrives on this number.
//   2. RC subscriptions expire (max 7 days) and must be renewed —
//      this Worker's scheduled() (cron) handler does that automatically.
//   3. When a real inbound SMS notification arrives, this Worker makes
//      a normal outbound RingCentral SMS API call to send the reply
//      (same getRCToken/sendSMS pattern as peachtree-reminder-worker.js).
//
// IMPORTANT — SUBSCRIPTIONS ARE SCOPED TO THE JWT'S USER
// The EVENT_FILTER below uses extension/~, which resolves to whichever
// RingCentral user the JWT was generated for. This Worker's JWT is bound
// to info@peachtreeroof.com (owner of RC_FROM). The T1-T8 customer
// texting number lives on a different extension (k.liss@).
// Consequences to be aware of:
//   - Moving the JWT to a different login orphans the previous
//     subscription. renewOrCreateSubscription() will fail its PUT renew,
//     create a new subscription, and overwrite the KV id — leaving the
//     old one live for up to 7 days, still POSTing here, unreachable
//     because only the original user's token can delete it.
//   - That is why handleInboundEvent() hard-checks msg.to against
//     RC_FROM. Without it, an orphaned subscription on another extension
//     caused customer replies to T1-T8 group texts to be answered with
//     partner/lead form links.
//
// SETUP
// 1. In RingCentral, buy/assign a new number for this bot to use as
//    RC_FROM below. If it's on the same account as your existing JWT
//    app, the same RC_CLIENT_ID/SECRET/JWT usually work — just point
//    RC_FROM at the new number. If it's a different account/extension,
//    generate new JWT credentials for that extension instead.
// 2. Make sure the RC app has the "SMS", "ReadMessages", and
//    "Subscriptions" permissions enabled (same app used elsewhere is
//    fine as long as those scopes are on it).
// 3. Create a KV namespace in Cloudflare (e.g. "PARTNER_LEAD_KV") and
//    bind it to this Worker under the variable name PARTNER_LEAD_KV.
//    It stores the current subscription ID and de-dupes replies.
// 4. Create the Worker, paste this file in, fill in every YOUR_...
//    placeholder with real values, deploy it, and copy its URL.
// 5. Set WEBHOOK_URL below to that URL + "/rc-webhook", then redeploy.
// 6. Visit https://your-worker.workers.dev/setup once (GET request) to
//    create the first subscription.
// 7. Add a Cron Trigger (e.g. daily, "0 6 * * *") so scheduled() renews
//    the subscription well before its 7-day expiry.
// 8. Update CONTACT_FORM_URL / LEAD_FORM_URL below if they ever change.
// =====================================================================

// ---- CREDENTIALS (reuse your existing RC JWT app, or a new one) ----
const RC_CLIENT_ID     = "YOUR_RC_CLIENT_ID";
const RC_CLIENT_SECRET = "YOUR_RC_CLIENT_SECRET";
const RC_JWT           = "YOUR_RC_JWT";           // bound to info@peachtreeroof.com
const RC_FROM          = "+14043013229";          // the partner/lead number

// ---- WEBHOOK / SUBSCRIPTION CONFIG ----
const WEBHOOK_URL = "https://partner-lead-sms-router.k-liss.workers.dev/rc-webhook";
const EVENT_FILTER = "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS";
const SUBSCRIPTION_TTL_SECONDS = 604800; // 7 days — RingCentral's max for WebHook subscriptions

// ---- FORM LINKS ----
const CONTACT_FORM_URL = "https://script.google.com/a/macros/peachtreerestorations.com/s/AKfycbzxHujkYKy2vUo8q2abK8JKRQmCP22rIoMGojTIKayL5iSm_xBPvuDpdJTRF7QCUEca/exec";
const LEAD_FORM_URL    = "https://script.google.com/a/macros/peachtreerestorations.com/s/AKfycbxJ_0QPQnobojX-uls8tb8FXKvmgofaqHQ0gEuB5ZrlRkNmTKCiOpeQK6H-jloYvBAWyw/exec";
const LEAD_CODE_PARAM  = "code"; // query param the lead form should read to prefill the code field

const PARTNER_KEYWORD = "partner";

// Short redirect links hosted by this same Worker (see the /c and /l routes
// below) instead of texting out the long raw Apps Script URLs directly.
const SHORT_BASE = new URL(WEBHOOK_URL).origin;

function partnerReply() {
  return `Thank you for partnering with Peachtree Roofing & Exteriors! Please fill out this quick registration form to get started: ${SHORT_BASE}/c`;
}

function leadReply(code) {
  const url = `${SHORT_BASE}/l?${LEAD_CODE_PARAM}=${encodeURIComponent(code)}`;
  return `Thank you for your business! Submit your details here to get started with Peachtree Roofing & Exteriors: ${url}`;
}

// =====================================================================
// RINGCENTRAL AUTH + SMS (same pattern as peachtree-reminder-worker.js)
// =====================================================================

async function getRCToken() {
  const res = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + btoa(RC_CLIENT_ID + ":" + RC_CLIENT_SECRET)
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: RC_JWT
    })
  });
  const d = await res.json();
  if (!d.access_token) throw new Error("RC token failed: " + JSON.stringify(d));
  return d.access_token;
}

async function sendSMS(rcToken, toNumbers, message) {
  const res = await fetch(
    "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + rcToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: { phoneNumber: RC_FROM },
        to: toNumbers.map(n => ({ phoneNumber: n })),
        text: message
      })
    }
  );
  const d = await res.json();
  if (d.errorCode) throw new Error("SMS send failed: " + JSON.stringify(d));
}

// =====================================================================
// SUBSCRIPTION MANAGEMENT
// =====================================================================

async function renewOrCreateSubscription(env) {
  const token = await getRCToken();
  const existingId = await env.PARTNER_LEAD_KV.get("subscriptionId");

  if (existingId) {
    const renewRes = await fetch(`https://platform.ringcentral.com/restapi/v1.0/subscription/${existingId}`, {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ eventFilters: [EVENT_FILTER], expiresIn: SUBSCRIPTION_TTL_SECONDS })
    });
    if (renewRes.ok) {
      console.log("[Partner/Lead SMS] Renewed subscription " + existingId);
      return;
    }
    console.warn(`[Partner/Lead SMS] Renew failed (${renewRes.status}) — creating a new subscription`);
  }

  const createRes = await fetch("https://platform.ringcentral.com/restapi/v1.0/subscription", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      eventFilters: [EVENT_FILTER],
      deliveryMode: { transportType: "WebHook", address: WEBHOOK_URL },
      expiresIn: SUBSCRIPTION_TTL_SECONDS
    })
  });
  const data = await createRes.json();
  if (!data.id) throw new Error("Subscription creation failed: " + JSON.stringify(data));
  await env.PARTNER_LEAD_KV.put("subscriptionId", data.id);
  console.log("[Partner/Lead SMS] Created subscription " + data.id);
}

// =====================================================================
// INBOUND EVENT HANDLING
// =====================================================================

async function handleInboundEvent(rawText, env) {
  console.log("[Partner/Lead SMS] DEBUG raw body: " + rawText);

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch (e) {
    console.error("[Partner/Lead SMS] Failed to parse webhook body: " + e.message);
    return;
  }

  const msg = payload && payload.body;
  if (!msg || msg.type !== "SMS" || msg.direction !== "Inbound") {
    console.log("[Partner/Lead SMS] DEBUG skipped — msg.type=" + (msg && msg.type) + " direction=" + (msg && msg.direction));
    return;
  }

  // Only respond to texts sent TO this bot's number. A stale subscription on
  // another extension can still deliver events here, and without this guard a
  // customer's reply to a T1-T8 group text gets answered with a lead link.
  const toNumbers = (msg.to || []).map(t => t && t.phoneNumber).filter(Boolean);
  if (!toNumbers.includes(RC_FROM)) {
    console.log("[Partner/Lead SMS] Ignoring inbound to " + JSON.stringify(toNumbers) + " — not " + RC_FROM);
    return;
  }

  const messageId = String(msg.id || "");
  if (messageId) {
    const seen = await env.PARTNER_LEAD_KV.get("dedupe:" + messageId);
    if (seen) { console.log("[Partner/Lead SMS] Duplicate delivery for " + messageId + " — skipping"); return; }
    await env.PARTNER_LEAD_KV.put("dedupe:" + messageId, "1", { expirationTtl: 3600 });
  }

  const fromNumber = msg.from && msg.from.phoneNumber;
  const text = (msg.subject || "").trim(); // RingCentral stores the SMS text in `subject`
  if (!fromNumber || !text) return;

  const reply = text.toLowerCase() === PARTNER_KEYWORD ? partnerReply() : leadReply(text);

  try {
    const token = await getRCToken();
    await sendSMS(token, [fromNumber], reply);
    console.log(`[Partner/Lead SMS] Replied to ${fromNumber}`);
  } catch (e) {
    console.error("[Partner/Lead SMS] Reply failed: " + e.message);
  }
}

// =====================================================================
// WORKER EXPORT
// =====================================================================
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(renewOrCreateSubscription(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/setup") {
      try {
        await renewOrCreateSubscription(env);
        return new Response("Subscription created/renewed OK.", { status: 200 });
      } catch (e) {
        return new Response("Setup failed: " + e.message, { status: 500 });
      }
    }
    // Short redirect links texted out instead of the raw long form URLs
    if (request.method === "GET" && url.pathname === "/c") {
      return Response.redirect(CONTACT_FORM_URL, 302);
    }
    if (request.method === "GET" && url.pathname === "/l") {
      const code = url.searchParams.get(LEAD_CODE_PARAM) || "";
      const dest = code ? `${LEAD_FORM_URL}?${LEAD_CODE_PARAM}=${encodeURIComponent(code)}` : LEAD_FORM_URL;
      return Response.redirect(dest, 302);
    }
    if (request.method === "GET") {
      return new Response("Peachtree Partner/Lead SMS Router (RingCentral) is running.", { status: 200 });
    }

    if (url.pathname !== "/rc-webhook") {
      return new Response("Not found", { status: 404 });
    }

    // RC's one-time validation handshake when a subscription is (re)created
    const validationToken = request.headers.get("Validation-Token");
    if (validationToken) {
      return new Response(null, { status: 200, headers: { "Validation-Token": validationToken } });
    }

    // Real event delivery — read the body now (Cloudflare cancels the request
    // stream once a response is sent), ack immediately, process in the background
    const rawText = await request.text();
    ctx.waitUntil(handleInboundEvent(rawText, env));
    return new Response(null, { status: 200 });
  }
};
