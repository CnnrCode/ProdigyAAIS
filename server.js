const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8000;
const CONFIG_PATH = path.join(__dirname, 'config.json');

const SESSIONS_PATH = path.join(__dirname, 'sessions.json');
const HALL_OF_FAME_PATH = path.join(__dirname, 'hall_of_fame.json');

// Helper to get active proctoring sessions safely
function getActiveSessions() {
  try {
    if (fs.existsSync(SESSIONS_PATH)) {
      const data = fs.readFileSync(SESSIONS_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading active sessions:', err);
  }
  return {};
}

// Helper to save active proctoring sessions safely
function saveActiveSessions(sessions) {
  try {
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing active sessions:', err);
  }
}

// Load session state from file
let activeSessions = getActiveSessions();

// Helper to get Hall of Fame safely
function getHallOfFame() {
  try {
    if (fs.existsSync(HALL_OF_FAME_PATH)) {
      const data = fs.readFileSync(HALL_OF_FAME_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading hall of fame:', err);
  }
  return {};
}

// Helper to save Hall of Fame safely
function saveHallOfFame(data) {
  try {
    fs.writeFileSync(HALL_OF_FAME_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing hall of fame:', err);
  }
}

// Helper to record an event in the Hall of Fame
function addHallOfFameRecord(username, type, detail, timestamp) {
  const fame = getHallOfFame();
  if (!fame[username]) {
    fame[username] = {
      username: username,
      cumulativeFlags: 0,
      cumulativeLocks: 0,
      lastActive: timestamp,
      history: []
    };
  }
  
  fame[username].lastActive = timestamp;
  
  if (type === 'violation') {
    fame[username].cumulativeFlags += 1;
  } else if (type === 'lockout') {
    fame[username].cumulativeLocks += 1;
  }
  
  fame[username].history.push({
    type: type,
    detail: detail,
    timestamp: timestamp
  });
  
  // Cap history at 100 entries per student to avoid bloating
  if (fame[username].history.length > 100) {
    fame[username].history.shift();
  }
  
  saveHallOfFame(fame);
}


// Default config
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
  blockRightClick: true
};

// Helper to get config safely
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

const server = http.createServer((req, res) => {
  // CORS Headers so the Chrome extension can fetch config from local/live server
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // API Route: GET config
  if (url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getConfig()));
    return;
  }

  // API Route: POST config
  if (url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.milestoneInterval !== undefined && data.baseDurationSeconds !== undefined && data.copyPasteAction !== undefined) {
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid parameters');
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
      }
    });
    return;
  }

  // API Route: POST session status
  if (url === '/api/session-status' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const username = data.username || 'Zen Student';
        const previousStatus = activeSessions[username] ? activeSessions[username].status : null;
        
        if (!activeSessions[username]) {
          activeSessions[username] = { username, isBlocked: false, lockoutExpiry: 0, unlockRequested: false, flags: 0, locks: 0 };
        }
        activeSessions[username].status = data.status || 'Idle';
        if (data.flags !== undefined) activeSessions[username].flags = data.flags;
        if (data.locks !== undefined) activeSessions[username].locks = data.locks;
        
        // Log start and submit events
        if (data.status === 'Active Exam' && previousStatus !== 'Active Exam') {
          addHallOfFameRecord(username, 'start', 'Exam session started', new Date().toISOString());
        } else if (data.status === 'Idle' && previousStatus === 'Active Exam') {
          addHallOfFameRecord(username, 'submit', 'Exam session ended / submitted', new Date().toISOString());
        }

        if (data.status === 'Idle') {
          activeSessions[username].isBlocked = false;
          activeSessions[username].lockoutExpiry = 0;
          activeSessions[username].unlockRequested = false;
          activeSessions[username].flags = 0;
          activeSessions[username].locks = 0;
        }
        
        saveActiveSessions(activeSessions);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400); res.end('Bad Request');
      }
    });
    return;
  }

  // API Route: POST lockout
  if (url === '/api/lockout' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const username = data.username || 'Zen Student';
        activeSessions[username] = {
          username,
          status: 'Locked Out',
          isBlocked: true,
          lockoutExpiry: data.lockoutExpiry || 0,
          unlockRequested: false,
          flags: data.flags !== undefined ? data.flags : 0,
          locks: data.locks !== undefined ? data.locks : 0
        };
        
        const durationSec = data.lockoutExpiry ? Math.round((data.lockoutExpiry - Date.now()) / 1000) : 0;
        const lockoutMsg = durationSec > 0 ? `Session suspended for ${durationSec} seconds` : 'Session suspended';
        addHallOfFameRecord(username, 'lockout', lockoutMsg, new Date().toISOString());

        saveActiveSessions(activeSessions);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400); res.end('Bad Request');
      }
    });
    return;
  }

  // API Route: POST unlock request
  if (url === '/api/unlock-request' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const username = data.username || 'Zen Student';
        if (!activeSessions[username]) {
          activeSessions[username] = {
            username,
            status: 'Locked Out',
            isBlocked: true,
            lockoutExpiry: 0,
            unlockRequested: true,
            flags: 0,
            locks: 1 // If requesting unlock and session wasn't found, assume at least 1 lock
          };
        } else {
          activeSessions[username].unlockRequested = true;
          activeSessions[username].isBlocked = true;
          activeSessions[username].status = 'Locked Out';
        }
        
        addHallOfFameRecord(username, 'unlock_request', 'Requested administrator unlock', new Date().toISOString());

        saveActiveSessions(activeSessions);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400); res.end('Bad Request');
      }
    });
    return;
  }

  // API Route: POST reactivate (admin unlock)
  if (url === '/api/reactivate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const username = data.username;
        if (activeSessions[username]) {
          activeSessions[username].isBlocked = false;
          activeSessions[username].lockoutExpiry = 0;
          activeSessions[username].unlockRequested = false;
          activeSessions[username].status = 'Active Exam';
        }
        
        addHallOfFameRecord(username, 'unlock', 'Unlocked by Administrator', new Date().toISOString());

        saveActiveSessions(activeSessions);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400); res.end('Bad Request');
      }
    });
    return;
  }

  // API Route: GET blocked users
  if (url === '/api/blocked-users' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Object.values(activeSessions)));
    return;
  }

  // API Route: GET hall of fame
  if (url === '/api/hall-of-fame' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Object.values(getHallOfFame())));
    return;
  }

  // API Route: POST report violation
  if (url === '/api/report-violation' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const username = data.username || 'Zen Student';
        const reason = data.reason || 'Security infraction';
        const timestamp = data.timestamp || new Date().toISOString();
        addHallOfFameRecord(username, 'violation', reason, timestamp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400); res.end('Bad Request');
      }
    });
    return;
  }

  // API Route: POST clear hall of fame
  if (url === '/api/clear-hall-of-fame' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const username = data.username;
        const fame = getHallOfFame();
        if (username) {
          if (fame[username]) {
            delete fame[username];
            saveHallOfFame(fame);
          }
        } else {
          saveHallOfFame({});
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400); res.end('Bad Request');
      }
    });
    return;
  }

  // API Route: GET check lockout status
  if (url === '/api/check-lockout' && req.method === 'GET') {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const username = params.get('username') || 'Zen Student';
    const session = activeSessions[username] || { isBlocked: false, lockoutExpiry: 0 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ isBlocked: session.isBlocked, lockoutExpiry: session.lockoutExpiry }));
    return;
  }

  // Route: /admin -> serve admin.html
  let safeUrl = url;
  if (safeUrl === '/' || safeUrl === '/admin') {
    safeUrl = '/admin.html';
  } else if (safeUrl === '/exam') {
    safeUrl = '/test_exam.html';
  }
  
  const filePath = path.join(__dirname, safeUrl);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    } else {
      let contentType = 'text/html';
      if (filePath.endsWith('.js')) {
        contentType = 'application/javascript';
      } else if (filePath.endsWith('.css')) {
        contentType = 'text/css';
      } else if (filePath.endsWith('.json')) {
        contentType = 'application/json';
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Test server running at http://localhost:${PORT}/exam`);
  console.log(`Admin Panel running at http://localhost:${PORT}/admin`);
  console.log('Press Ctrl+C to stop.');
});
