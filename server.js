'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const PORT        = 8000;
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ═══════════════════════════════════════════════════════════════════════════
// SUPABASE CLIENT
// Session and audit data is stored in the cloud instead of local JSON files.
// The Node.js server acts as the API bridge between the extension and Supabase.
// ═══════════════════════════════════════════════════════════════════════════
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── ANTI-TAMPER SHIELD: Canonical Username Helpers ────────────────────────
function getCanonicalUsername(username) {
  return (username || '').replace(/\s*\((Chrome|Edge|Brave|Firefox|Standard|Mobile)\)/gi, '').trim();
}

function getBrowserSuffix(username) {
  const m = (username || '').match(/\((Chrome|Edge|Brave|Firefox|Standard|Mobile)\)/i);
  return m ? m[0] : '';
}

// ── DB ROW CONVERSION HELPERS ─────────────────────────────────────────────
// camelCase JS objects ↔ snake_case Supabase rows

function sessionToRow(s) {
  return {
    username:         s.username,
    status:           s.status || 'Idle',
    is_blocked:       s.isBlocked || false,
    lockout_expiry:   s.lockoutExpiry || 0,
    unlock_requested: s.unlockRequested || false,
    appeal_reason:    s.appealReason || '',
    flags:            s.flags || 0,
    locks:            s.locks || 0,
    session_id:       s.sessionId || '',
    browser_suffix:   s.browserSuffix || ''
  };
}

function rowToSession(row) {
  if (!row) return null;
  return {
    username:        row.username,
    status:          row.status,
    isBlocked:       row.is_blocked,
    lockoutExpiry:   row.lockout_expiry,
    unlockRequested: row.unlock_requested,
    appealReason:    row.appeal_reason || '',
    flags:           row.flags,
    locks:           row.locks,
    sessionId:       row.session_id,
    browserSuffix:   row.browser_suffix || ''
  };
}

function recordToRow(r) {
  return {
    username:         r.username,
    cumulative_flags: r.cumulativeFlags || 0,
    violation_events: r.violationEvents || 0,
    flag_points:      r.flagPoints || 0,
    cumulative_locks: r.cumulativeLocks || 0,
    last_active:      r.lastActive || new Date().toISOString(),
    history:          JSON.stringify(r.history || [])
  };
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    username:        row.username,
    cumulativeFlags: row.cumulative_flags,
    violationEvents: row.violation_events,
    flagPoints:      row.flag_points,
    cumulativeLocks: row.cumulative_locks,
    lastActive:      row.last_active,
    history:         typeof row.history === 'string' ? JSON.parse(row.history) : (row.history || [])
  };
}

// ── SESSION HELPERS ───────────────────────────────────────────────────────

async function getSession(username) {
  const { data, error } = await supabase
    .from('proctor_sessions')
    .select('*')
    .eq('username', username)
    .maybeSingle();
  if (error) console.error('[DB] getSession error:', error.message);
  return rowToSession(data);
}

async function getAllSessions() {
  const { data, error } = await supabase
    .from('proctor_sessions')
    .select('*')
    .order('username');
  if (error) console.error('[DB] getAllSessions error:', error.message);
  return (data || []).map(rowToSession);
}

async function upsertSession(session) {
  const { error } = await supabase
    .from('proctor_sessions')
    .upsert(sessionToRow(session), { onConflict: 'username' });
  if (error) console.error('[DB] upsertSession error:', error.message);
}

async function deleteAllSessions() {
  const { error } = await supabase
    .from('proctor_sessions')
    .delete()
    .gte('username', '');
  if (error) console.error('[DB] deleteAllSessions error:', error.message);
}

// ── HALL OF FAME HELPERS ──────────────────────────────────────────────────

async function getStudentRecord(username) {
  const { data, error } = await supabase
    .from('hall_of_fame')
    .select('*')
    .eq('username', username)
    .maybeSingle();
  if (error) console.error('[DB] getStudentRecord error:', error.message);
  return rowToRecord(data);
}

async function upsertStudentRecord(record) {
  const { error } = await supabase
    .from('hall_of_fame')
    .upsert(recordToRow(record), { onConflict: 'username' });
  if (error) console.error('[DB] upsertStudentRecord error:', error.message);
}

async function getAllStudentRecords() {
  const { data, error } = await supabase
    .from('hall_of_fame')
    .select('*')
    .order('last_active', { ascending: false });
  if (error) console.error('[DB] getAllStudentRecords error:', error.message);
  return (data || []).map(rowToRecord);
}

async function deleteStudentRecord(username) {
  const { error } = await supabase
    .from('hall_of_fame')
    .delete()
    .eq('username', username);
  if (error) console.error('[DB] deleteStudentRecord error:', error.message);
}

async function deleteAllStudentRecords() {
  const { error } = await supabase
    .from('hall_of_fame')
    .delete()
    .gte('username', '');
  if (error) console.error('[DB] deleteAllStudentRecords error:', error.message);
}

// ── AUDIT RECORD WRITER ───────────────────────────────────────────────────

async function addHallOfFameRecord(username, type, detail, timestamp, sessionId = '', weight = 0) {
  try {
    let record = await getStudentRecord(username);
    if (!record) {
      record = { username, cumulativeFlags: 0, violationEvents: 0, flagPoints: 0, cumulativeLocks: 0, lastActive: timestamp, history: [] };
    }

    record.lastActive = timestamp;

    if (type === 'violation') {
      const points = weight || 1;
      record.violationEvents = (record.violationEvents || 0) + 1;
      record.flagPoints      = (record.flagPoints || 0) + points;
      record.cumulativeFlags = record.flagPoints;
    } else if (type === 'lockout') {
      record.cumulativeLocks = (record.cumulativeLocks || 0) + 1;
    }

    record.history.push({
      type,
      detail,
      timestamp,
      sessionId: sessionId || '',
      weight: type === 'violation' ? (weight || 1) : undefined
    });

    if (record.history.length > 100) record.history.shift();

    await upsertStudentRecord(record);
  } catch (err) {
    console.error('[DB] addHallOfFameRecord error:', err.message);
  }
}

// ── ANTI-TAMPER: Canonical Cross-Browser Lock Finder ─────────────────────
// Queries Supabase for any UNEXPIRED lockout under the same canonical name,
// regardless of which browser suffix was used when the lock was issued.

async function findActiveLockForUser(username) {
  const now       = Date.now();
  const canonical = getCanonicalUsername(username);

  const { data, error } = await supabase
    .from('proctor_sessions')
    .select('*')
    .eq('is_blocked', true)
    .gt('lockout_expiry', now);

  if (error) {
    console.error('[DB] findActiveLockForUser error:', error.message);
    return null;
  }

  for (const row of (data || [])) {
    const s = rowToSession(row);
    if (s.username === username || getCanonicalUsername(s.username) === canonical) {
      return s;
    }
  }

  return null;
}

// ANTI-TAMPER SHIELD: canonical (cross-browser) lookup of a user's session,
// regardless of block/expiry state. Used by check-lockout so appeal/admin
// lockouts (which may carry lockout_expiry === 0, i.e. "locked until an admin
// decides") are still recognized and can be cleared by admin approval.
async function findSessionForUser(username) {
  const canonical = getCanonicalUsername(username);

  const exact = await getSession(username);
  if (exact) return exact;

  const { data, error } = await supabase
    .from('proctor_sessions')
    .select('*');

  if (error) {
    console.error('[DB] findSessionForUser error:', error.message);
    return null;
  }

  for (const row of (data || [])) {
    const s = rowToSession(row);
    if (s.username === username || getCanonicalUsername(s.username) === canonical) {
      return s;
    }
  }

  return null;
}

// ── CONFIG (stays local — no cloud needed) ────────────────────────────────

const DEFAULT_CONFIG = {
  milestoneInterval: 5,
  baseDurationSeconds: 10,
  copyPasteAction: 'flag',
  strictLockout: false,
  noRestrictions: false,
  chatbotDuringExam: false,
  requireFullscreen: true,
  blockDevTools: true,
  blockTabSwitch: true,
  blockRightClick: true,
  limitExits: false,
  maxExits: 3
};

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading config:', err);
  }
  return DEFAULT_CONFIG;
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// All route handlers are async — Supabase calls use await.
// ═══════════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // Helper to collect POST body
  function readBody() {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end',  () => resolve(body));
      req.on('error', reject);
    });
  }

  try {

    // ── GET /api/config ───────────────────────────────────────────────────
    if (url === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getConfig()));
      return;
    }

    // ── POST /api/config ──────────────────────────────────────────────────
    if (url === '/api/config' && req.method === 'POST') {
      const body = await readBody();
      const data = JSON.parse(body);
      if (data.milestoneInterval !== undefined && data.baseDurationSeconds !== undefined && data.copyPasteAction !== undefined) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid parameters');
      }
      return;
    }

    // ── POST /api/session-status ──────────────────────────────────────────
    if (url === '/api/session-status' && req.method === 'POST') {
      const body = await readBody();
      const data = JSON.parse(body);
      const username = data.username || 'Anonymous';

      let session = await getSession(username);
      const previousStatus = session ? session.status : null;

      if (!session) {
        session = { username, status: 'Idle', isBlocked: false, lockoutExpiry: 0, unlockRequested: false, appealReason: '', flags: 0, locks: 0, sessionId: data.sessionId || '', browserSuffix: getBrowserSuffix(username) };
      }

      // The lock counter is owned exclusively by the lockout endpoints, so a
      // routine status heartbeat must never overwrite it (previously an
      // "Active Exam" ping carrying a stale locks:0 from client storage would
      // reset the admin's Locks count back to 0 right after a lockout).
      session.status = data.status || 'Idle';
      if (data.flags     !== undefined) session.flags     = data.flags;
      if (data.sessionId !== undefined) session.sessionId = data.sessionId;
      if (data.browserSuffix !== undefined) session.browserSuffix = data.browserSuffix;

      const now = new Date().toISOString();
      if (data.status === 'Active Exam' && previousStatus !== 'Active Exam') {
        addHallOfFameRecord(username, 'start',  'Exam session started',            now, data.sessionId || '').catch(() => {});
      } else if (data.status === 'Idle' && previousStatus === 'Active Exam') {
        addHallOfFameRecord(username, 'submit', 'Exam session ended / submitted',  now, data.sessionId || '').catch(() => {});
      }

      if (data.status === 'Idle') {
        session.isBlocked       = false;
        session.lockoutExpiry   = 0;
        session.unlockRequested = false;
        session.flags           = 0;
        session.locks           = 0;
        session.sessionId       = '';
      } else if (data.status === 'Lockout Active') {
        session.isBlocked = true;
        if (data.lockoutExpiry) {
          session.lockoutExpiry = data.lockoutExpiry;
        }
      }

      await upsertSession(session);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── POST /api/lockout ─────────────────────────────────────────────────
    if (url === '/api/lockout' && req.method === 'POST') {
      const body = await readBody();
      const data = JSON.parse(body);
      const username = data.username || 'Anonymous';

      // The server OWNS the lock counter so it can never be reset to a stale
      // value by the client. Look up the user's existing session (canonical,
      // cross-browser) and decide what this POST represents:
      //   • the SAME lockout window already recorded (re-affirmation) -> keep count
      //   • a genuinely NEW lockout (from the background worker)       -> count +1
      //   • a client re-affirmation healing a wiped/missing row        -> ensure >=1
      // This makes lockouts survive hard resets / external data wipes while
      // preventing double-counting when the background AND the overlay both post.
      const existing   = await findSessionForUser(username);
      const postExpiry = data.lockoutExpiry || 0;
      const newExpiry  = postExpiry || (existing && existing.lockoutExpiry) || 0;
      const sameWindow = !!(existing && existing.isBlocked &&
        postExpiry !== 0 && existing.lockoutExpiry === postExpiry);
      const isReaffirm = data.reaffirm === true;

      const session = existing || { username, locks: 0 };
      session.username      = username;
      session.status        = 'Locked Out';
      session.isBlocked     = true;
      session.lockoutExpiry = newExpiry;
      if (data.flags !== undefined)         session.flags         = data.flags;
      if (data.sessionId)                   session.sessionId     = data.sessionId;
      if (data.browserSuffix !== undefined) session.browserSuffix = data.browserSuffix;
      // Preserve any in-flight appeal across re-affirmations.
      if (session.unlockRequested === undefined) session.unlockRequested = false;
      if (session.appealReason    === undefined) session.appealReason    = '';
      if (!session.browserSuffix) session.browserSuffix = getBrowserSuffix(username);

      let countedNewLock = false;
      if (!sameWindow) {
        if (isReaffirm) {
          // Healing a wiped/missing row: show the student as locked without
          // inventing extra lockouts.
          session.locks = Math.max(session.locks || 0, 1);
        } else {
          // Authoritative new lockout (from the background service worker).
          session.locks = (session.locks || 0) + 1;
          countedNewLock = true;
        }
      }

      await upsertSession(session);

      if (countedNewLock) {
        const durationSec = newExpiry ? Math.round((newExpiry - Date.now()) / 1000) : 0;
        const msg = durationSec > 0 ? `Session suspended for ${durationSec} seconds` : 'Session suspended';
        addHallOfFameRecord(username, 'lockout', msg, new Date().toISOString(), data.sessionId || '').catch(() => {});
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── POST /api/unlock-request ──────────────────────────────────────────
    if (url === '/api/unlock-request' && req.method === 'POST') {
      const body = await readBody();
      const data = JSON.parse(body);
      const username    = data.username || 'Anonymous';
      const appealReason = (typeof data.appealReason === 'string') ? data.appealReason.slice(0, 1000) : '';

      let session = await getSession(username);
      if (!session) {
        session = { username, status: 'Locked Out', isBlocked: true, lockoutExpiry: 0, unlockRequested: true, appealReason, flags: 0, locks: 1, sessionId: data.sessionId || '', browserSuffix: getBrowserSuffix(username) };
      } else {
        session.unlockRequested = true;
        session.isBlocked       = true;
        session.status          = 'Locked Out';
        session.appealReason    = appealReason;
        if (data.sessionId) session.sessionId = data.sessionId;
        if (data.browserSuffix !== undefined) session.browserSuffix = data.browserSuffix;
      }

      await upsertSession(session);
      addHallOfFameRecord(username, 'unlock_request', appealReason ? ('Appeal: ' + appealReason) : 'Requested administrator unlock', new Date().toISOString(), data.sessionId || '').catch(() => {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── POST /api/reactivate (admin unlock) ───────────────────────────────
    if (url === '/api/reactivate' && req.method === 'POST') {
      const body = await readBody();
      const data = JSON.parse(body);
      const username = data.username;

      let sessionId = '';
      const session = await getSession(username);
      if (session) {
        sessionId = session.sessionId || '';
        session.isBlocked       = false;
        session.lockoutExpiry   = 0;
        session.unlockRequested = false;
        session.appealReason    = '';
        session.status          = 'Active Exam';
        await upsertSession(session);
      }

      addHallOfFameRecord(username, 'unlock', 'Unlocked by Administrator', new Date().toISOString(), sessionId).catch(() => {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── POST /api/deny-appeal ─────────────────────────────────────────────
    if (url === '/api/deny-appeal' && req.method === 'POST') {
      const body = await readBody();
      const data = JSON.parse(body);
      const username = data.username;

      let sessionId = '';
      const session = await getSession(username);
      if (session) {
        sessionId            = session.sessionId || '';
        session.unlockRequested = false;
        session.appealReason = '';
        session.isBlocked    = true;
        session.status       = 'Locked Out';
        await upsertSession(session);
      }

      addHallOfFameRecord(username, 'unlock_request', 'Appeal denied by Administrator', new Date().toISOString(), sessionId).catch(() => {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── GET /api/blocked-users ────────────────────────────────────────────
    if (url === '/api/blocked-users' && req.method === 'GET') {
      const sessions = await getAllSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
      return;
    }

    // ── GET /api/hall-of-fame ─────────────────────────────────────────────
    if (url === '/api/hall-of-fame' && req.method === 'GET') {
      const records = await getAllStudentRecords();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(records));
      return;
    }

    // ── POST /api/report-violation ────────────────────────────────────────
    if (url === '/api/report-violation' && req.method === 'POST') {
      const body = await readBody();
      const data = JSON.parse(body);
      const username  = data.username  || 'Anonymous';
      const reason    = data.reason    || 'Security infraction';
      const timestamp = data.timestamp || new Date().toISOString();
      const weight    = data.weight    || 1;
      const sessionId = data.sessionId || '';

      let session = await getSession(username);
      if (!session) {
        session = { username, status: 'Active Exam', isBlocked: false, lockoutExpiry: 0, unlockRequested: false, appealReason: '', flags: 0, locks: 0, sessionId, browserSuffix: data.browserSuffix || getBrowserSuffix(username) };
      }
      session.flags = (session.flags || 0) + weight;
      if (sessionId) session.sessionId = sessionId;
      if (data.browserSuffix !== undefined) session.browserSuffix = data.browserSuffix;
      await upsertSession(session);

      addHallOfFameRecord(username, 'violation', reason, timestamp, sessionId, weight).catch(() => {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── POST /api/clear-hall-of-fame ──────────────────────────────────────
    if (url === '/api/clear-hall-of-fame' && req.method === 'POST') {
      const body = await readBody();
      const data = JSON.parse(body);
      if (data.username) {
        await deleteStudentRecord(data.username);
      } else {
        await deleteAllStudentRecords();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── POST /api/reset-sessions ──────────────────────────────────────────
    // Clears ALL live session rows from the cloud database without restarting
    // the server. Useful for resetting between exam sessions.
    if (url === '/api/reset-sessions' && req.method === 'POST') {
      await deleteAllSessions();
      console.log('[Prodigy Shield] All sessions cleared via /api/reset-sessions');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ── GET /api/check-lockout ────────────────────────────────────────────
    // ANTI-TAMPER SHIELD: canonical (cross-browser) lockout lookup.
    // Look up the user's OWN session (not just an unexpired lock row) so that
    // admin-controlled / appeal lockouts — which may carry lockout_expiry === 0
    // ("locked until an administrator decides") — are still reported as blocked.
    // A session counts as blocked when is_blocked is true AND the lockout is
    // either indefinite (expiry 0) or not yet expired. This is what lets admin
    // approval or denial of an appeal actually reach the student.
    if (url === '/api/check-lockout' && req.method === 'GET') {
      const params   = new URL(req.url, `http://localhost:${PORT}`).searchParams;
      const username = params.get('username') || 'Anonymous';
      const now      = Date.now();

      const session   = await findSessionForUser(username);
      const isBlocked = !!(session && session.isBlocked &&
        (!session.lockoutExpiry || session.lockoutExpiry > now));

      if (!isBlocked) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          isBlocked:             false,
          lockoutExpiry:         (session && session.lockoutExpiry) || 0,
          unlockRequested:       !!(session && session.unlockRequested),
          sessionFound:          !!session,
          browserSwitchDetected: false
        }));
        return;
      }

      const connectingBrowser     = params.get('browserSuffix') || getBrowserSuffix(username);
      const lockedBrowser         = session.browserSuffix || getBrowserSuffix(session.username || '');
      const cleanConnecting       = (connectingBrowser || '').replace(/\s*\(Mobile\)/gi, '').trim();
      const cleanLocked           = (lockedBrowser || '').replace(/\s*\(Mobile\)/gi, '').trim();
      const browserSwitchDetected = !!(cleanConnecting && cleanLocked && cleanConnecting !== cleanLocked);

      if (browserSwitchDetected) {
        const evadeMsg = `Browser-switch evasion detected: locked on ${lockedBrowser || 'unknown'}, attempting access from ${connectingBrowser}`;
        console.log(`[Prodigy Shield] ${evadeMsg} — user: ${username}`);
        addHallOfFameRecord(username, 'violation', evadeMsg, new Date().toISOString(), session.sessionId || '', 10).catch(() => {});
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        isBlocked:             true,
        lockoutExpiry:         session.lockoutExpiry,
        unlockRequested:       !!session.unlockRequested,
        sessionFound:          true,
        browserSwitchDetected
      }));
      return;
    }

    // ── Static file serving ───────────────────────────────────────────────
    let safeUrl = url;
    if (safeUrl === '/' || safeUrl === '/admin') safeUrl = '/admin.html';
    else if (safeUrl === '/exam') safeUrl = '/test_exam.html';

    const filePath = path.join(__dirname, safeUrl);
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        let contentType = 'text/html';
        if (filePath.endsWith('.js'))   contentType = 'application/javascript';
        else if (filePath.endsWith('.css'))  contentType = 'text/css';
        else if (filePath.endsWith('.json')) contentType = 'application/json';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });

  } catch (err) {
    console.error('[Prodigy Shield] Unhandled route error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`✓ Supabase connected  : ${SUPABASE_URL}`);
  console.log(`✓ Exam server         : http://localhost:${PORT}/exam`);
  console.log(`✓ Admin panel         : http://localhost:${PORT}/admin`);
  console.log('  Press Ctrl+C to stop.');
});
