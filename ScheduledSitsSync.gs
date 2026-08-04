// ============================================================
// Peachtree Roofing — Scheduled Sits CSV → GitHub Sync
// Finds the daily AcuLynx "Scheduled Sits" report in Gmail, pulls the
// CSV attachment, and commits it to the portal repo as appointments.csv.
// The Scheduled Sits calendar tab reads that file directly, so a
// successful run refreshes the calendar with no other action.
//
// SETUP:
// 1. Extensions → Apps Script → paste this file
// 2. Create a GitHub fine-grained personal access token:
//      github.com → Settings → Developer settings →
//      Personal access tokens → Fine-grained tokens → Generate new
//      Repository access: ONLY peachtree-roofing-automation
//      Permissions: Repository permissions → Contents → Read and write
//    (Contents is the only permission it needs. Do not grant more.)
// 3. Project Settings → Script Properties, add:
//      GITHUB_TOKEN → the token from step 2
// 4. Triggers → Add Trigger:
//      Function: syncScheduledSits
//      Event source: Time-driven
//      Type: Day timer
//      Time: an hour or two AFTER the report email lands
//      Timezone: America/New_York (Eastern Time)
// 5. Run syncScheduledSits once by hand and check Executions /
//    Logger output before trusting the trigger.
//
// SAFETY: the run aborts without committing if the attachment is
// missing, is missing its expected columns, or has fewer than
// MIN_DATA_ROWS rows — so a truncated or empty export can never
// replace a good calendar with a blank one.
// ============================================================

// ── CONFIG — adjust GMAIL_QUERY to match the actual report email ──
var GH_OWNER   = 'M-W-Johnson-Holdco';
var GH_REPO    = 'peachtree-roofing-automation';
var GH_PATH    = 'appointments.csv';
var GH_BRANCH  = 'main';

// Narrow this to the real sender/subject once you've seen one arrive.
// Check it first in Gmail's search box — it should return only the report.
var GMAIL_QUERY = 'subject:"Scheduled Sits" has:attachment filename:csv newer_than:2d';

// A healthy export has ~25 rows. Anything under this is treated as broken.
var MIN_DATA_ROWS = 5;

// Columns the calendar needs; the export is rejected if any are absent.
var REQUIRED_COLUMNS = ['scheduled sit date', 'job name'];


function syncScheduledSits() {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    Logger.log('ERROR: Missing Script Property GITHUB_TOKEN.');
    return;
  }

  var csv = findLatestSitsCsv_();
  if (!csv) return;  // findLatestSitsCsv_ logs the reason

  if (!csvLooksValid_(csv)) return;  // csvLooksValid_ logs the reason

  var current = getRepoFile_(token);
  if (current && current.text === csv) {
    Logger.log('No change — appointments.csv already matches the newest export. Nothing committed.');
    return;
  }

  commitRepoFile_(token, csv, current ? current.sha : null);
}


// Returns the CSV text from the newest matching email, or null.
function findLatestSitsCsv_() {
  var threads = GmailApp.search(GMAIL_QUERY, 0, 10);
  if (!threads.length) {
    Logger.log('No email matched GMAIL_QUERY — nothing to sync. Query: ' + GMAIL_QUERY);
    return null;
  }

  // Walk newest-first and take the first CSV attachment found.
  var newest = null;
  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(msg) {
      msg.getAttachments().forEach(function(att) {
        if (!/\.csv$/i.test(att.getName())) return;
        if (!newest || msg.getDate() > newest.date) {
          newest = { date: msg.getDate(), name: att.getName(), blob: att };
        }
      });
    });
  });

  if (!newest) {
    Logger.log('Matched ' + threads.length + ' thread(s) but none had a .csv attachment.');
    return null;
  }

  Logger.log('Using attachment "' + newest.name + '" from ' + newest.date);
  return newest.blob.getDataAsString();
}


// Rejects an export that would blank out or break the calendar.
function csvLooksValid_(csv) {
  var lines = csv.split('\n').filter(function(l) { return l.trim() !== ''; });
  if (!lines.length) {
    Logger.log('ABORT: attachment is empty.');
    return false;
  }

  var header = lines[0].toLowerCase();
  var missing = REQUIRED_COLUMNS.filter(function(c) { return header.indexOf(c) === -1; });
  if (missing.length) {
    Logger.log('ABORT: export is missing expected column(s): ' + missing.join(', ') +
               ' — header was: ' + lines[0]);
    return false;
  }

  var dataRows = lines.length - 1;
  if (dataRows < MIN_DATA_ROWS) {
    Logger.log('ABORT: only ' + dataRows + ' data row(s), below MIN_DATA_ROWS of ' +
               MIN_DATA_ROWS + '. Refusing to overwrite good data with a short export.');
    return false;
  }

  Logger.log('Export looks valid: ' + dataRows + ' data rows.');
  return true;
}


// Current appointments.csv in the repo, as {text, sha}, or null if absent.
function getRepoFile_(token) {
  var resp = UrlFetchApp.fetch(contentsUrl_() + '?ref=' + GH_BRANCH, {
    method: 'get',
    headers: ghHeaders_(token),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() === 404) {
    Logger.log('appointments.csv not in repo yet — it will be created.');
    return null;
  }
  if (resp.getResponseCode() !== 200) {
    Logger.log('ERROR reading current file: HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText());
    return null;
  }

  var json = JSON.parse(resp.getContentText());
  // GitHub wraps base64 at 60 chars; strip the newlines before decoding.
  var text = Utilities.newBlob(
    Utilities.base64Decode(String(json.content).replace(/\s/g, ''))
  ).getDataAsString();

  return { text: text, sha: json.sha };
}


function commitRepoFile_(token, csv, sha) {
  var payload = {
    message: 'Update scheduled sits data from AcuLynx export',
    content: Utilities.base64Encode(csv, Utilities.Charset.UTF_8),
    branch:  GH_BRANCH
  };
  if (sha) payload.sha = sha;  // omitted on first create

  var resp = UrlFetchApp.fetch(contentsUrl_(), {
    method: 'put',
    headers: ghHeaders_(token),
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  if (code === 200 || code === 201) {
    Logger.log('Committed appointments.csv. GitHub Pages will redeploy in about a minute.');
  } else {
    Logger.log('ERROR committing: HTTP ' + code + ' ' + resp.getContentText());
  }
}


function contentsUrl_() {
  return 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/' + GH_PATH;
}

function ghHeaders_(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}
