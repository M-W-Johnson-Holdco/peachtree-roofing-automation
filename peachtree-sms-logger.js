// =====================================================================
// Peachtree Roofing — Inbound SMS Logger
// Cloudflare Worker, driven by a RingCentral inbound-SMS webhook.
//
// WHAT THIS DOES
// When a customer replies to one of the T1-T8 group texts, this Worker
// looks their phone number up in the texting Log sheet to find the job,
// then posts the reply onto that job's AccuLynx file as
// "[Inbound SMS Reply] From: ... | <timestamp>" — replying into the
// existing message thread when the log has a messageId for it, so the
// whole customer conversation stays in one AccuLynx thread.
//
// SETUP
// 1. Create the Worker, paste this file in, and fill in every YOUR_...
//    placeholder with real values.
// 2. Point a RingCentral WebHook subscription at this Worker's URL.
//    (See partner-lead-sms-router.js for the subscription lifecycle —
//    note that subscriptions are scoped to the JWT's RingCentral user.)
//
// TIMEZONE
// All timestamps posted to AccuLynx are rendered in America/New_York and
// suffixed "ET". Do not use a fixed zone like "EST" (no daylight saving,
// so it reads an hour early all summer) and do not use America/Chicago
// (Central, a full hour behind Eastern year-round) — both have been bugs
// here before.
// =====================================================================

const ACCULYNX_API_KEY = "YOUR_ACCULYNX_API_KEY";
const ACCULYNX_PROXY = "https://peachtree-acculynx-proxy.k-liss.workers.dev";

const GS_SHEET_ID = "YOUR_GS_SHEET_ID";
const GS_SHEET_NAME = "Log 2026";
const GS_CLIENT_ID = "YOUR_GS_CLIENT_ID";
const GS_CLIENT_SECRET = "YOUR_GS_CLIENT_SECRET";
const GS_REFRESH_TOKEN = "YOUR_GS_REFRESH_TOKEN";

// Eastern, with daylight saving handled automatically by the IANA zone.
const LOG_TIMEZONE = 'America/New_York';

function etTimestamp(creationTime) {
  return new Date(creationTime || Date.now())
    .toLocaleString('en-US', { timeZone: LOG_TIMEZONE }) + ' ET';
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Validation-Token'
      }
    });
  }

  const validationToken = request.headers.get('Validation-Token');
  if (validationToken && request.method === 'GET') {
    return new Response(null, {
      status: 200,
      headers: { 'Validation-Token': validationToken, 'Content-Type': 'application/json' }
    });
  }

  if (request.method === 'POST') {
    const contentLength = parseInt(request.headers.get('content-length') || '0');
    if (validationToken && contentLength < 10) {
      return new Response(null, {
        status: 200,
        headers: { 'Validation-Token': validationToken, 'Content-Type': 'application/json' }
      });
    }

    try {
      const bodyText = await request.text();
      console.log('Received body:', bodyText);

      const body = JSON.parse(bodyText);
      const msgBody = body?.body;
      const msgs = msgBody?.messages || (msgBody?.direction ? [msgBody] : []);
      console.log('Messages found:', msgs.length);

      for (const msg of msgs) {
        if (msg.direction !== 'Inbound') {
          console.log('Skipping — not inbound. Direction:', msg.direction, 'Type:', msg.type);
          continue;
        }

        const fromPhone = msg.from?.phoneNumber || '';
        const text = msg.subject || msg.body || msg.text || '(no text)';
        const timestamp = etTimestamp(msg.creationTime);

        console.log('From:', fromPhone, 'Text:', text);
        if (!fromPhone) continue;

        const jobInfo = await findJobByPhoneInSheets(fromPhone);

        if (jobInfo && jobInfo.jobGuid) {
          console.log('Found job:', jobInfo.jobNum, 'GUID:', jobInfo.jobGuid, 'MessageID:', jobInfo.messageId);
          try {
            if (jobInfo.messageId) {
              try {
                await replyToAccuLynx(jobInfo.jobGuid, jobInfo.messageId, `[Inbound SMS Reply] From: ${fromPhone} | ${timestamp}\n\n${text}`);
                console.log('Successfully replied to AccuLynx thread for Job', jobInfo.jobNum);
              } catch(replyErr) {
                console.log('Reply failed, falling back to new message:', replyErr.message);
                await postToAccuLynx(jobInfo.jobGuid, `[Inbound SMS Reply] From: ${fromPhone} | ${timestamp}\n\n${text}`);
                console.log('Successfully posted new message to AccuLynx Job', jobInfo.jobNum);
              }
            } else {
              await postToAccuLynx(jobInfo.jobGuid, `[Inbound SMS Reply] From: ${fromPhone} | ${timestamp}\n\n${text}`);
              console.log('Successfully logged reply to AccuLynx Job', jobInfo.jobNum);
            }
          } catch(e) {
            console.error('AccuLynx post error:', e.message);
          }
        } else if (jobInfo && !jobInfo.jobGuid) {
          console.log('Found job', jobInfo.jobNum, 'but no GUID in sheet');
        } else {
          console.log('No job found in Sheets for phone:', fromPhone);
        }
      }

      const respHeaders = { 'Content-Type': 'application/json' };
      if (validationToken) respHeaders['Validation-Token'] = validationToken;
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: respHeaders });

    } catch (e) {
      console.error('Error:', e.message);
      return new Response(JSON.stringify({ error: e.message }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getGSToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${encodeURIComponent(GS_CLIENT_ID)}&client_secret=${encodeURIComponent(GS_CLIENT_SECRET)}&refresh_token=${encodeURIComponent(GS_REFRESH_TOKEN)}&grant_type=refresh_token`
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Google token failed: ' + JSON.stringify(data));
  return data.access_token;
}

// NOTE: matches only the primary phone in column D. Replies from a customer's
// secondary number will not be found — see the Secondary Texting Number gap
// noted in the repo discussion.
async function findJobByPhoneInSheets(phone) {
  const clean = phone.replace(/\D/g, '').slice(-10);
  try {
    const token = await getGSToken();
    const sheetName = encodeURIComponent(GS_SHEET_NAME);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GS_SHEET_ID}/values/${sheetName}!A:K`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!data.values) return null;
    const rows = data.values.slice(1);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const rowPhone = (row[3] || '').replace(/\D/g, '').slice(-10);
      if (rowPhone === clean) {
        const jobNum = row[1] || '';
        const jobGuid = row[9] || '';
        const messageId = row[10] || '';
        console.log('Found phone in Sheets — Job#:', jobNum, 'GUID:', jobGuid, 'MessageID:', messageId);
        return { jobNum, jobGuid, messageId };
      }
    }
    return null;
  } catch (e) {
    console.error('Sheets lookup error:', e.message);
    return null;
  }
}

async function replyToAccuLynx(jobId, messageId, message) {
  const url = `https://api.acculynx.com/api/v2/jobs/${jobId}/messages/${messageId}/replies`;
  console.log('Replying to AccuLynx thread:', url);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCULYNX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message })
  });
  console.log('Reply status:', res.status);
  const txt = await res.text();
  console.log('Reply response:', txt);
  if (!res.ok) throw new Error(`AccuLynx reply failed: ${res.status} ${txt}`);
  return txt;
}

async function postToAccuLynx(jobId, message) {
  const url = `https://api.acculynx.com/api/v2/jobs/${jobId}/messages`;
  console.log('Posting to AccuLynx:', url);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCULYNX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message })
  });
  console.log('AccuLynx response status:', res.status);
  const txt = await res.text();
  console.log('AccuLynx response body:', txt);
  if (!res.ok) throw new Error(`AccuLynx post failed: ${res.status} ${txt}`);
  return txt;
}
