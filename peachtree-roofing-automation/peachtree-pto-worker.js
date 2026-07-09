// =====================================================================
// Peachtree Roofing — PTO Daily Slack Digest Worker
// Cloudflare Worker with cron trigger
//
// Cron schedule (set in Cloudflare Dashboard → Worker → Triggers):
//   Summer (EDT, Apr–Oct): 0 12 * * *   (8am EDT = 12:00 UTC)
//   Winter (EST, Nov–Mar): 0 13 * * *   (8am EST = 13:00 UTC)
//
// SETUP:
// 1. Create a new Cloudflare Worker named "peachtree-pto-worker"
// 2. Paste this entire file as the Worker script
// 3. Fill in every YOUR_... placeholder below with real values
// 4. Add a Cron Trigger for the current season (see above)
//    Cloudflare Dashboard → Worker → Triggers → Cron Triggers → Add
// 5. In Slack: go to api.slack.com/apps → Your App → Incoming Webhooks
//    Enable Incoming Webhooks → Add New Webhook to Workspace
//    Choose #companywideannouncements → Copy the webhook URL
// 6. Visit /run on the worker URL to test it manually
// =====================================================================

// ---- CREDENTIALS ----
const GS_CLIENT_ID     = "YOUR_GS_CLIENT_ID";
const GS_CLIENT_SECRET = "YOUR_GS_CLIENT_SECRET";
const GS_REFRESH_TOKEN = "YOUR_GS_REFRESH_TOKEN";
const GS_SHEET_ID      = "YOUR_GS_SHEET_ID";   // same sheet ID as main app

// ---- SHEET TAB NAMES (must match your Google Sheet) ----
const PTO_REQUESTS_TAB = "PTORequests";
const PTO_PERMS_TAB    = "UserPermissions";

// ---- SLACK ----
// Incoming Webhook URL for #companywideannouncements
const SLACK_WEBHOOK_URL = "YOUR_SLACK_WEBHOOK_URL";
// e.g. "https://hooks.slack.com/services/T00000000/B00000000/xxxxxxxxxxxxxxxxxxxx"

// =====================================================================
// AUTH
// =====================================================================

async function getGSToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     GS_CLIENT_ID,
      client_secret: GS_CLIENT_SECRET,
      refresh_token: GS_REFRESH_TOKEN,
      grant_type:    "refresh_token"
    })
  });
  const d = await res.json();
  if (!d.access_token) throw new Error("GS token failed: " + JSON.stringify(d));
  return d.access_token;
}

// =====================================================================
// GOOGLE SHEETS
// =====================================================================

async function readSheet(token, tabName, range) {
  const encoded = encodeURIComponent(tabName + "!" + range);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${GS_SHEET_ID}/values/${encoded}`,
    { headers: { Authorization: "Bearer " + token } }
  );
  const d = await res.json();
  if (d.error) throw new Error("Sheets read failed: " + d.error.message);
  return d.values || [];
}

// =====================================================================
// UTILITIES
// =====================================================================

function getTodayET() {
  // Returns YYYY-MM-DD in Eastern Time
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function formatDateNice(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric"
  });
}

function parseHalfDayTimes(notes) {
  // Extract "First day half: 9am-1pm" and "Last day half: 1pm-5pm" from notes
  const firstMatch = (notes || "").match(/First day half:\s*([\w\-]+)/i);
  const lastMatch  = (notes || "").match(/Last day half:\s*([\w\-]+)/i);
  return {
    firstTime: firstMatch ? firstMatch[1] : null,
    lastTime:  lastMatch  ? lastMatch[1]  : null
  };
}

function friendlyTime(code) {
  if (code === "9am-1pm")  return "9am–1pm";
  if (code === "1pm-5pm")  return "1pm–5pm";
  return code || "half day";
}

// =====================================================================
// MAIN
// =====================================================================

async function runPtoDigest() {
  const today = getTodayET();
  console.log(`[PTO Digest] Running for ${today}`);

  const token = await getGSToken();

  const [reqRows, permRows] = await Promise.all([
    readSheet(token, PTO_REQUESTS_TAB, "A:O"),
    readSheet(token, PTO_PERMS_TAB,    "A:C")
  ]);

  // Build email → display name map from UserPermissions (col A=Email, C=Name)
  const nameMap = {};
  for (const row of permRows.slice(1)) {
    const email = (row[0] || "").trim().toLowerCase();
    const name  = (row[2] || "").trim();
    if (email && name) nameMap[email] = name;
  }

  // PTORequests cols: A=ID B=Email C=MgrEmail D=Type E=Start F=End
  //                   G=HalfStart H=HalfEnd I=Days J=Notes K=Status
  const out = [];
  for (const row of reqRows.slice(1)) {
    const status = (row[10] || "").trim().toLowerCase();
    if (status !== "approved") continue;

    const start = (row[4] || "").trim();
    const end   = (row[5] || "").trim();
    if (!start || !end) continue;
    if (today < start || today > end) continue; // not out today

    const email     = (row[1] || "").trim().toLowerCase();
    const type      = (row[3] || "PTO").trim();
    const halfStart = (row[6] || "").trim().toUpperCase() === "TRUE";
    const halfEnd   = (row[7] || "").trim().toUpperCase() === "TRUE";
    const notes     = (row[9] || "").trim();
    const name      = nameMap[email] || email;

    const { firstTime, lastTime } = parseHalfDayTimes(notes);

    const isFirstDay  = today === start;
    const isLastDay   = today === end;
    const isSingleDay = start === end;

    let halfDetail = "";
    if (isSingleDay && halfStart) {
      halfDetail = ` _(${friendlyTime(firstTime)})_`;
    } else if (isFirstDay && halfStart) {
      halfDetail = ` _(first day: ${friendlyTime(firstTime)})_`;
    } else if (isLastDay && halfEnd) {
      halfDetail = ` _(last day: ${friendlyTime(lastTime)})_`;
    }

    out.push(`• *${name}* — ${type}${halfDetail}`);
  }

  if (!out.length) {
    console.log("[PTO Digest] No one out today — skipping Slack post");
    return;
  }

  const header = `:beach_with_umbrella: *Who's Out Today — ${formatDateNice(today)}*`;
  const message = header + "\n\n" + out.join("\n");

  const slackRes = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message })
  });

  if (!slackRes.ok) {
    const err = await slackRes.text();
    throw new Error("Slack post failed: " + err);
  }

  console.log(`[PTO Digest] Posted ${out.length} person(s) to #companywideannouncements`);
}

// =====================================================================
// WORKER EXPORT
// =====================================================================

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPtoDigest());
  },
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/run") {
      ctx.waitUntil(runPtoDigest());
      return new Response("PTO digest triggered — check Worker logs", { status: 200 });
    }
    return new Response(
      "Peachtree PTO Digest Worker\n" +
      "  GET /run  → trigger digest manually\n" +
      "  Cron runs daily at 8am ET",
      { status: 200 }
    );
  }
};
