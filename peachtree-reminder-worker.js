// =====================================================================
// Peachtree Roofing — Day-Before Appointment Reminder Worker
// Cloudflare Worker with cron trigger: 0 15 * * * (10am ET / 11am EDT = 15:00 UTC)
//
// SETUP:
// 1. Create a new Cloudflare Worker named "peachtree-reminder-worker"
// 2. Paste this entire file as the Worker script
// 3. Fill in every YOUR_... placeholder below with real values
// 4. Add a Cron Trigger: 0 15 * * *
//    Cloudflare Dashboard → Worker → Triggers → Cron Triggers → Add
// 5. In your app's Config tab, set "Template Tab Name" to whatever you
//    put in GS_TMPL_TAB_NAME below, then click "Sync Reminder Templates
//    to Sheet" to push your current templates up.
// =====================================================================

// ---- CREDENTIALS ----
const GCAL_CLIENT_ID     = "YOUR_GCAL_CLIENT_ID";
const GCAL_CLIENT_SECRET = "YOUR_GCAL_CLIENT_SECRET";
const GCAL_REFRESH_TOKEN = "YOUR_GCAL_REFRESH_TOKEN";

const RC_CLIENT_ID     = "YOUR_RC_CLIENT_ID";
const RC_CLIENT_SECRET = "YOUR_RC_CLIENT_SECRET";
const RC_JWT           = "YOUR_RC_JWT";
const RC_FROM          = "YOUR_RC_FROM_NUMBER"; // e.g. +17704586405

const GS_CLIENT_ID     = "YOUR_GS_CLIENT_ID";
const GS_CLIENT_SECRET = "YOUR_GS_CLIENT_SECRET";
const GS_REFRESH_TOKEN = "YOUR_GS_REFRESH_TOKEN";
const GS_SHEET_ID      = "YOUR_GS_SHEET_ID";
const GS_SHEET_NAME    = "Log 2026";    // e.g. Log 2026
const GS_TMPL_TAB_NAME = "ReminderTemplates"; // must match app config

// ---- FIXED GROUP NUMBERS ----
const FIXED_NUMBERS = ["+17704586405", "+18448235776", "+16782938467", "+17702265514"];

// ---- SALESPERSON MAP ----
const SALESPERSON_MAP = {
  "Tim Bresko":          "+17707124556",
  "Alex Raffensperger":  "+17703628125",
  "Wells Walker":        "+14705960020",
  "Ahmed Alsinjary":     "+16786345945",
  "Erika Kight":         "+14703044658",
  "Dan Sinnott":         "+17705009727",
  "Tim Jones":           "+14705960016",
  "Kenneth Gutzler":     "+14703044657",
  "Scott Gunty":         "+14708822601",
  "Denerick Spaulding":  "+14709364847",
  "Shuwayne Agard":      "+14709364845",
  "Lavelle Westbrooks":  "+14705271788",
  "Cameron Black":       "+17703171457",
  "Rafael Berrios":      "+14703302110"
};

// ---- CALENDAR MAP ----
// Replace these calendar IDs with Peachtree's actual Google Calendar IDs
const GCAL_CALENDAR_DEFAULT = "YOUR_DEFAULT_CALENDAR_ID"; // e.g. info@peachtreeroof.com
const GCAL_CALENDAR_MAP = {
  "Re-inspection Adjustment":           "YOUR_GCAL_ID_RE_INSPECTION",
  "Insurance Adjustment":               "YOUR_GCAL_ID_INSURANCE_ADJUSTMENT",
  "Interior Only Insurance Adjustment": "YOUR_GCAL_ID_INTERIOR_INS_ADJ",
  "Forensic Inspection":                "YOUR_GCAL_ID_FORENSIC",
  "Engineer Inspection":                "YOUR_GCAL_ID_ENGINEER",
  "On-Roof Inspection":                 "YOUR_DEFAULT_CALENDAR_ID",
  "Interior Only Inspection":           "YOUR_GCAL_ID_INTERIOR_INSP",
  "Shingle Pull":                       "YOUR_GCAL_ID_SHINGLE_PULL",
  "Video Repair":                       "YOUR_GCAL_ID_VIDEO_REPAIR",
  "2nd Video Repair":                   "YOUR_GCAL_ID_2ND_VIDEO_REPAIR",
  "Leak Source":                        "YOUR_GCAL_ID_LEAK_SOURCE"
};

const APPT_TYPES = Object.keys(GCAL_CALENDAR_MAP);

// ---- FALLBACK SMS TEMPLATE (used if sheet read fails) ----
const REMINDER_FALLBACK = "Hi {{First Name}}! This is a reminder from Peachtree Roofing & Exteriors that your {{Appointment Type}} is scheduled for tomorrow, {{Date}} at {{Time}}. Reply to this message with any questions. Thank you!";

// =====================================================================
// UTILITIES
// =====================================================================

function getAllCalendarIds() {
  const ids = [GCAL_CALENDAR_DEFAULT];
  for (const id of Object.values(GCAL_CALENDAR_MAP)) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function extractApptType(summary) {
  for (const t of APPT_TYPES) {
    if (summary && summary.includes(t)) return t;
  }
  return "";
}

function extractJobInfo(summary) {
  const m = (summary || "").match(/—\s*(.+?)\s*\(Job\s*([^)]+)\)/);
  return m ? { name: m[1].trim(), jobKey: m[2].trim() } : { name: summary || "", jobKey: "" };
}

function toE164(p) {
  if (!p) return null;
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return null;
}

function formatDateNice(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });
}

function formatTimeNice(dtStr) {
  return new Date(dtStr).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/New_York"
  }) + " ET";
}

function getTomorrowET() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  now.setDate(now.getDate() + 1);
  return now.toLocaleDateString("en-CA");
}

function applyVars(tmpl, firstName, apptType, dateStr, timeStr, address, jobNum, spPhone) {
  return (tmpl || "")
    .replace(/{{First Name}}/g,        firstName || "")
    .replace(/{{Appointment Type}}/g,  apptType  || "")
    .replace(/{{Date}}/g,              dateStr   || "")
    .replace(/{{Time}}/g,              timeStr   || "")
    .replace(/{{Address}}/g,           address   || "")
    .replace(/{{Job Number}}/g,        jobNum    || "")
    .replace(/{{Salesperson Phone}}/g, spPhone   || "");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =====================================================================
// AUTH
// =====================================================================

async function getToken(clientId, clientSecret, refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token"
    })
  });
  const d = await res.json();
  if (!d.access_token) throw new Error("Token failed: " + JSON.stringify(d));
  return d.access_token;
}

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

// =====================================================================
// GOOGLE SHEETS — read templates, read log, append rows
// =====================================================================

async function readReminderTemplates(gsToken) {
  const sn = encodeURIComponent(GS_TMPL_TAB_NAME);
  try {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${GS_SHEET_ID}/values/${sn}!A:B`,
      { headers: { Authorization: "Bearer " + gsToken } }
    );
    const d = await res.json();
    if (!d.values || d.values.length < 2) {
      console.log("[Peachtree Reminder Worker] Template sheet empty or missing — using fallback");
      return {};
    }
    const map = {};
    for (const row of d.values.slice(1)) {
      const type = (row[0] || "").trim();
      const tmpl = (row[1] || "").trim();
      if (type && tmpl) map[type] = tmpl;
    }
    console.log(`[Peachtree Reminder Worker] Loaded ${Object.keys(map).length} templates from sheet`);
    return map;
  } catch (e) {
    console.warn("[Peachtree Reminder Worker] Could not read template sheet: " + e.message + " — using fallback");
    return {};
  }
}

async function getSheetLog(gsToken) {
  const sn = encodeURIComponent(GS_SHEET_NAME);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${GS_SHEET_ID}/values/${sn}!A:N`,
    { headers: { Authorization: "Bearer " + gsToken } }
  );
  const d = await res.json();
  if (!d.values || d.values.length < 2) return [];
  return d.values.slice(1).map(r => ({
    timestamp: r[0]||"", jobNum: r[1]||"", name: r[2]||"", phone: r[3]||"",
    trigger: r[4]||"", template: r[5]||"", message: r[6]||"",
    acculynxLogged: r[7]||"", status: r[8]||"", jobGuid: r[9]||"",
    messageId: r[10]||"", runBy: r[11]||"", secondaryPhone: r[12]||"",
    conversationId: r[13]||""
  }));
}

function reminderAlreadySent(sheetLog, jobKey, apptType, tomorrowDate) {
  const triggerKey = "Day-Before Reminder — " + apptType;
  const eventDate  = new Date(tomorrowDate + "T12:00:00");
  const dayBefore  = new Date(eventDate);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const dayBeforeStr = dayBefore.toLocaleDateString("en-CA");
  return sheetLog.some(row => {
    if (row.template !== "REMINDER" || row.trigger !== triggerKey) return false;
    const jMatch = row.jobNum === jobKey || (jobKey && row.jobNum.toLowerCase() === jobKey.toLowerCase());
    if (!jMatch) return false;
    const ts = row.timestamp ? new Date(row.timestamp) : null;
    if (!ts) return false;
    return ts.toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === dayBeforeStr;
  });
}

async function appendSheetRow(gsToken, entry) {
  const sn  = encodeURIComponent(GS_SHEET_NAME);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GS_SHEET_ID}/values/${sn}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + gsToken, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [[
      entry.timestamp, entry.jobNum, entry.name, entry.phone,
      entry.trigger, entry.template, entry.message, entry.acculynxLogged,
      entry.status, entry.jobGuid, entry.messageId, entry.runBy,
      entry.secondaryPhone, entry.conversationId
    ]] })
  });
  if (!res.ok) throw new Error("Sheet append failed: " + await res.text());
}

// =====================================================================
// GOOGLE CALENDAR — tomorrow's events across all calendars
// =====================================================================

async function getTomorrowEvents(gcalToken, dateStr) {
  const dayStart = new Date(dateStr + "T00:00:00-05:00").toISOString();
  const dayEnd   = new Date(dateStr + "T23:59:59-05:00").toISOString();

  const results = await Promise.all(getAllCalendarIds().map(async calId => {
    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events` +
        `?timeMin=${encodeURIComponent(dayStart)}&timeMax=${encodeURIComponent(dayEnd)}` +
        `&singleEvents=true&orderBy=startTime&maxResults=100`,
        { headers: { Authorization: "Bearer " + gcalToken } }
      );
      const d = await res.json();
      return (d.items || []).map(ev => ({ ...ev, _calendarId: calId }));
    } catch { return []; }
  }));

  const seen = new Set(); const events = [];
  for (const batch of results) {
    for (const ev of batch) {
      if (!seen.has(ev.id)) { seen.add(ev.id); events.push(ev); }
    }
  }
  events.sort((a, b) => {
    const at = a.start?.dateTime ? new Date(a.start.dateTime) : 0;
    const bt = b.start?.dateTime ? new Date(b.start.dateTime) : 0;
    return at - bt;
  });
  return events;
}

// =====================================================================
// RINGCENTRAL
// =====================================================================

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
  if (d.errorCode) throw new Error("SMS failed: " + JSON.stringify(d));
  return d?.conversation?.id || "";
}

// =====================================================================
// JOB LOOKUP
// =====================================================================

function findJobEntries(sheetLog, jobKey) {
  if (!jobKey) return [];
  const ql = jobKey.toLowerCase().trim();
  return sheetLog.filter(r =>
    r.jobNum.toLowerCase() === ql ||
    r.jobGuid.toLowerCase() === ql ||
    r.jobNum.toLowerCase().includes(ql)
  );
}

function buildJobContext(entries) {
  if (!entries.length) return null;
  const first = entries[0];
  let salesperson = "", spPhone = null;
  for (const entry of entries) {
    for (const [name, phone] of Object.entries(SALESPERSON_MAP)) {
      if ((entry.message || "").includes(name)) { salesperson = name; spPhone = phone; break; }
    }
    if (salesperson) break;
  }
  const spDisplay = spPhone
    ? spPhone.replace("+1","").replace(/(\d{3})(\d{3})(\d{4})/,"($1) $2-$3")
    : "";
  return {
    jobNum: first.jobNum, jobGuid: first.jobGuid,
    jobKey: first.jobNum || first.jobGuid,
    name: first.name,
    phone: toE164(first.phone),
    phone2: first.secondaryPhone ? toE164(first.secondaryPhone) : null,
    salesperson, spPhone, spDisplay,
    conversationId: first.conversationId
  };
}

// =====================================================================
// MAIN
// =====================================================================

async function runReminders() {
  const tomorrowDate = getTomorrowET();
  console.log(`[Peachtree Reminder Worker] Running for ${tomorrowDate}`);

  const gsToken = await getToken(GS_CLIENT_ID, GS_CLIENT_SECRET, GS_REFRESH_TOKEN);
  const [gcalToken, rcToken, templates, sheetLog] = await Promise.all([
    getToken(GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REFRESH_TOKEN),
    getRCToken(),
    readReminderTemplates(gsToken),
    getSheetLog(gsToken)
  ]);

  const events = await getTomorrowEvents(gcalToken, tomorrowDate);
  console.log(`[Peachtree Reminder Worker] ${events.length} event(s) tomorrow`);

  if (!events.length) { console.log("[Peachtree Reminder Worker] Nothing to do"); return; }

  let sent = 0, skipped = 0, failed = 0;

  for (const ev of events) {
    const apptType                   = extractApptType(ev.summary || "");
    const { name: custName, jobKey } = extractJobInfo(ev.summary || "");
    const startDt                    = ev.start?.dateTime;
    const timeStr                    = startDt ? formatTimeNice(startDt) : "";
    const dateStr                    = formatDateNice(tomorrowDate);

    if (!apptType) { console.log(`[Peachtree Reminder Worker] Skipping: ${ev.summary}`); skipped++; continue; }

    if (jobKey && reminderAlreadySent(sheetLog, jobKey, apptType, tomorrowDate)) {
      console.log(`[Peachtree Reminder Worker] Already sent for ${jobKey} — skip`); skipped++; continue;
    }

    const entries = findJobEntries(sheetLog, jobKey);
    const ctx     = buildJobContext(entries);

    if (!ctx?.phone) {
      console.log(`[Peachtree Reminder Worker] No phone for ${jobKey} (${custName}) — skip`); skipped++; continue;
    }

    const firstName = (ctx.name || custName).split(" ")[0];
    const tmpl      = templates[apptType] || REMINDER_FALLBACK;
    const smsMsg    = applyVars(tmpl, firstName, apptType, dateStr, timeStr, "", ctx.jobKey, ctx.spDisplay || "");

    const recips = [ctx.phone];
    if (ctx.phone2 && !recips.includes(ctx.phone2)) recips.push(ctx.phone2);
    for (const n of FIXED_NUMBERS) { if (!recips.includes(n)) recips.push(n); }
    if (ctx.spPhone && !recips.includes(ctx.spPhone)) recips.push(ctx.spPhone);

    try {
      console.log(`[Peachtree Reminder Worker] Sending to ${ctx.name} — ${apptType}`);
      const convId = await sendSMS(rcToken, recips, smsMsg);
      await appendSheetRow(gsToken, {
        timestamp: new Date().toISOString(),
        jobNum: ctx.jobNum || ctx.jobGuid || jobKey, name: ctx.name,
        phone: ctx.phone,
        trigger: "Day-Before Reminder — " + apptType,
        template: "REMINDER", message: smsMsg, acculynxLogged: "",
        status: "sent", jobGuid: ctx.jobGuid || "", messageId: "",
        runBy: "Auto-Reminder Worker",
        secondaryPhone: ctx.phone2 || "", conversationId: convId || ""
      });
      sent++;
      console.log(`[Peachtree Reminder Worker] ✓ ${ctx.name} | ${jobKey}`);
    } catch (e) {
      failed++;
      console.error(`[Peachtree Reminder Worker] ✗ ${jobKey}: ${e.message}`);
    }
    await sleep(800);
  }

  console.log(`[Peachtree Reminder Worker] Done — Sent:${sent} Skipped:${skipped} Failed:${failed}`);
}

// =====================================================================
// WORKER EXPORT
// =====================================================================

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders());
  },
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/run") {
      ctx.waitUntil(runReminders());
      return new Response("Reminder job triggered — check Worker logs", { status: 200 });
    }
    return new Response("Peachtree Roofing Reminder Worker. Visit /run to trigger manually.", { status: 200 });
  }
};
