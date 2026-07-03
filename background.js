let examModeActive = false;
let examTabId = null;
let examWindowId = null;

// Initialize state from storage in case of service worker restart
chrome.storage.local.get(['examModeActive', 'examTabId', 'examWindowId'], (result) => {
  if (result.examModeActive) {
    examModeActive = true;
    examTabId = result.examTabId;
    examWindowId = result.examWindowId;
  }
});

let remoteConfigSynced = false;

// Remote config sync helper
function syncRemoteConfig(callback) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

  fetch('http://localhost:8000/api/config', { signal: controller.signal })
    .then(res => {
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error('Sync failed');
      return res.json();
    })
    .then(data => {
      if (data.milestoneInterval !== undefined && data.baseDurationSeconds !== undefined) {
        chrome.storage.local.set({
          milestoneInterval: data.milestoneInterval,
          baseDurationSeconds: data.baseDurationSeconds,
          copyPasteAction: data.copyPasteAction || 'flag',
          strictLockout: !!data.strictLockout,
          noRestrictions: !!data.noRestrictions,
          chatbotDuringExam: !!data.chatbotDuringExam,
          requireFullscreen: data.requireFullscreen !== false,
          blockDevTools: data.blockDevTools !== false,
          blockTabSwitch: data.blockTabSwitch !== false,
          blockRightClick: data.blockRightClick !== false,
          limitExits: !!data.limitExits,
          maxExits: (typeof data.maxExits === 'number' && data.maxExits > 0) ? data.maxExits : 3
        }, () => {
          remoteConfigSynced = true;
          if (callback) callback(true);
        });
      } else {
        remoteConfigSynced = false;
        if (callback) callback(false);
      }
    })
    .catch(err => {
      clearTimeout(timeoutId);
      console.warn('Prodigy Shield: Could not sync remote config. Using stored settings.', err);
      remoteConfigSynced = false;
      if (callback) callback(false);
    });
}

// Initial sync on startup
syncRemoteConfig();

// ---------------------------------------------------------------------------
// ANTI-TAMPER SHIELD: Server-Side Lockout Sync
// ---------------------------------------------------------------------------
// Queries the server for any UNEXPIRED lockout tied to this canonical username
// (cross-browser). If found, syncs the lockoutExpiry into chrome.storage.local
// so the content script will enforce the lockout even on a fresh browser install.
// If the server also reports a browser-switch evasion, this function logs it
// as a high-weight violation AND applies a fresh penalty lockout.
function getBrowserSuffixOnly(callback) {
  chrome.storage.local.get(['browserSuffix'], (res) => {
    if (res.browserSuffix) {
      callback(res.browserSuffix);
      return;
    }
    const ua = navigator.userAgent || '';
    let browserSuffix = " (Standard)";
    if (ua.includes("Edg")) {
      browserSuffix = " (Edge)";
    } else if (ua.includes("Firefox")) {
      browserSuffix = " (Firefox)";
    } else if (ua.includes("Chrome")) {
      browserSuffix = " (Chrome)";
    }
    callback(browserSuffix);
  });
}

function checkServerLockoutForUser(username, callback) {
  if (!username) {
    if (callback) callback(null);
    return;
  }

  getBrowserSuffixOnly((suffix) => {
    const encoded = encodeURIComponent(username);
    const encodedSuffix = encodeURIComponent(suffix);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    fetch(`http://localhost:8000/api/check-lockout?username=${encoded}&browserSuffix=${encodedSuffix}`, { signal: controller.signal })
      .then(r => {
        clearTimeout(timeoutId);
        if (!r.ok) throw new Error('check-lockout request failed');
        return r.json();
      })
      .then(data => {
        if (data && data.isBlocked && data.lockoutExpiry && data.lockoutExpiry > Date.now()) {

          if (data.browserSwitchDetected) {
            // ▸ ANTI-TAMPER: Browser-switch evasion — apply a fresh EXTENDED lockout
            // as a penalty and report the violation.
            const EVASION_PENALTY_SECONDS = 300; // 5 minute penalty for switching browsers
            const penaltyExpiry = Date.now() + (EVASION_PENALTY_SECONDS * 1000);

            // Use the longer of: original lock or penalty
            const finalExpiry = Math.max(data.lockoutExpiry, penaltyExpiry);

            chrome.storage.local.set({
              lockoutExpiry: finalExpiry,
              examModeActive: true
            });

            // Report the evasion as a violation so it appears in Hall of Fame flags
            fetch('http://localhost:8000/api/report-violation', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                username: username,
                reason: 'Browser-switch evasion detected [Critical] (+10): Attempted to bypass active lockout by switching browsers',
                weight: 10,
                sessionId: '',
                timestamp: new Date().toISOString(),
                browserSuffix: suffix
              })
            }).catch(() => {});

            if (callback) callback({ isBlocked: true, lockoutExpiry: finalExpiry, browserSwitchDetected: true });
          } else {
            // Normal cross-browser lockout restore — sync the expiry and restore exam mode
            chrome.storage.local.set({
              lockoutExpiry: data.lockoutExpiry,
              examModeActive: true
            });
            if (callback) callback(data);
          }
        } else {
          // No active lock — nothing to sync
          if (callback) callback({ isBlocked: false, lockoutExpiry: 0, browserSwitchDetected: false });
        }
      })
      .catch(() => {
        clearTimeout(timeoutId);
        // Server unreachable — silently proceed; local state is authoritative
        if (callback) callback(null);
      });
  });
}

// Run the cross-browser lockout check on extension startup.
// We need a username — read from storage (set when a student starts an exam).
chrome.storage.local.get(['examUsername'], (res) => {
  if (res.examUsername) {
    checkServerLockoutForUser(res.examUsername);
  }
});

// Helper to update state and storage
function setExamMode(active, tabId = null, windowId = null) {
  examModeActive = active;
  examTabId = tabId;
  examWindowId = windowId;
  chrome.storage.local.set({
    examModeActive: active,
    examTabId: tabId,
    examWindowId: windowId
  });
}

// Send HIDE_INDICATORS to a tab's content script
function sendHideIndicators(tabId) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'HIDE_INDICATORS' }, () => {
    if (chrome.runtime.lastError) { /* safe to ignore — tab may have navigated */ }
  });
}

function getViolationWeight(reason) {
  const lower = reason.toLowerCase();
  
  // High Severity (+5 flags)
  if (
    lower.includes('tab change') ||
    lower.includes('visibility') ||
    lower.includes('focus lost') ||
    lower.includes('devtools') ||
    lower.includes('developer tools') ||
    lower.includes('side panel') ||
    lower.includes('split-screen') ||
    lower.includes('snapped')
  ) {
    return 5;
  }
  
  // Medium Severity (+2 flags)
  if (
    lower.includes('fullscreen') ||
    lower.includes('copied') ||
    lower.includes('cut') ||
    lower.includes('paste') ||
    lower.includes('clipboard')
  ) {
    return 2;
  }
  
  // Low Severity (+1 flag)
  return 1;
}

// Helper to log a violation with timestamp and trigger lockout at threshold
function logViolation(reason, username, callback, forceLockout) {
  // If the second argument is a callback (e.g. logViolation(reason, callback)), shift parameters
  if (typeof username === 'function') {
    callback = username;
    username = null;
  }

  if (!examModeActive) return;

  chrome.storage.local.get([
    'violations', 
    'violationLog', 
    'milestoneInterval', 
    'baseDurationSeconds', 
    'lockoutExpiry', 
    'lockouts', 
    'examUsername', 
    'strictLockout', 
    'noRestrictions',
    'blockTabSwitch',
    'blockDevTools',
    'requireFullscreen',
    'examSessionId',
    'examTabId'
  ], (result) => {
    if (result.noRestrictions) {
      if (callback) callback(result.violations || 0);
      return;
    }

    // If the student is currently suspended, ignore any new violation flags
    if (result.lockoutExpiry && Date.now() < result.lockoutExpiry) {
      if (callback) callback(result.violations || 0);
      return;
    }

    // Check if this specific category of violation is disabled by admin settings
    const lower = reason.toLowerCase();
    if (lower.includes('tab') || lower.includes('visibility') || lower.includes('focus')) {
      if (result.blockTabSwitch === false) {
        if (callback) callback(result.violations || 0);
        return;
      }
    }
    if (lower.includes('devtools') || lower.includes('developer tools') || lower.includes('side panel') || lower.includes('window snapped') || lower.includes('split-screen')) {
      if (result.blockDevTools === false) {
        if (callback) callback(result.violations || 0);
        return;
      }
    }
    if (lower.includes('fullscreen')) {
      if (result.requireFullscreen === false) {
        if (callback) callback(result.violations || 0);
        return;
      }
    }

    const current = result.violations || 0;
    const weight = getViolationWeight(reason);
    const updated = current + weight;
    const resolvedUsername = username || result.examUsername || 'Anonymous';
    const sessionId = result.examSessionId || '';

    let severity = 'Low';
    if (weight === 5) severity = 'High';
    else if (weight === 2) severity = 'Medium';

    const formattedReason = `${reason} [${severity}] (+${weight})`;

    getBrowserSuffixOnly((suffix) => {
      // Report violation to server immediately (including sessionId and weight!)
      fetch('http://localhost:8000/api/report-violation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: resolvedUsername,
          reason: formattedReason,
          weight: weight,
          sessionId: sessionId,
          timestamp: new Date().toISOString(),
          browserSuffix: suffix
        })
      }).catch(err => console.warn('Failed to send violation to server:', err));
    });

    // Load dynamic config settings (defaulting to 5 flags / 10s if not loaded yet)
    const milestone = result.milestoneInterval || 5;
    const baseSeconds = result.baseDurationSeconds || 10;

    // Build timestamped log entry (capped at 50 entries)
    const log = result.violationLog || [];
    log.push({ reason: formattedReason, timestamp: new Date().toISOString(), count: updated });
    if (log.length > 50) log.shift();

    chrome.storage.local.set({ violations: updated, violationLog: log }, () => {
      // MV3 SERVICE-WORKER SURVIVAL: the worker can be torn down at any time
      // (idle, or when the student hard-resets the page), which wipes the
      // in-memory `examTabId`. When that happened this entire lockout block was
      // skipped — the violation count above still climbed, but no lockout was
      // registered, so admin saw Flags rising while Locks stayed at 0. Read the
      // persisted tab id from storage so lockouts survive a worker restart.
      const activeTabId = result.examTabId || examTabId;
      if (activeTabId) examTabId = activeTabId;
      if (activeTabId) {
        let triggerLockout = Math.floor(updated / milestone) > Math.floor(current / milestone);
        if (result.strictLockout && updated >= milestone) {
          triggerLockout = true;
        }
        // ZERO-TOLERANCE: some violations (DevTools / side panel opened) must lock
        // the student out immediately, regardless of the flag milestone. Otherwise,
        // with a high milestoneInterval a student could open DevTools (only +5 flags)
        // and never cross the threshold, sitting in the exam with the inspector open.
        if (forceLockout) {
          triggerLockout = true;
        }

        if (triggerLockout) {
          const duration = forceLockout
            ? baseSeconds
            : (result.strictLockout && updated >= milestone
              ? baseSeconds
              : Math.floor(updated / milestone) * baseSeconds);
          const lockoutExpiry = Date.now() + (duration * 1000);
          const currentLockouts = result.lockouts || 0;
          const updatedLockouts = currentLockouts + 1;
          
          chrome.storage.local.set({ lockoutExpiry: lockoutExpiry, lockouts: updatedLockouts }, () => {
            // Milestone reached — send suspension signal with duration
            chrome.tabs.sendMessage(activeTabId, {
              type: 'LOCKOUT_TRIGGERED',
              violations: updated,
              lockouts: updatedLockouts,
              duration: duration
            }, () => { if (chrome.runtime.lastError) {} });

            // ▸ REAL-TIME SERVER REGISTRATION
            // Register the lockout with the proctor server the INSTANT it is
            // triggered, straight from the background service worker — the same
            // reliable path used for violation reports. Previously the server was
            // only told about a lockout when the on-page overlay ran its own POST,
            // which in practice did not land until the student refreshed. That is
            // why the admin panel showed the student as "not locked" and the Locks
            // counter only advanced on refresh. Registering here makes the lock
            // appear in admin immediately, under the same stable username used for
            // the violation flags.
            getBrowserSuffixOnly((suffix) => {
              fetch('http://localhost:8000/api/lockout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  username: resolvedUsername,
                  lockoutExpiry: lockoutExpiry,
                  flags: updated,
                  locks: updatedLockouts,
                  sessionId: sessionId,
                  browserSuffix: suffix
                })
              }).catch((err) => console.warn('[Prodigy Shield] Real-time lockout registration failed:', err));
            });
          });
        } else {
          // Normal violation — show dismissable modal
          chrome.tabs.sendMessage(activeTabId, {
            type: 'VIOLATION_TRIGGERED',
            violations: updated,
            reason: formattedReason
          }, () => { if (chrome.runtime.lastError) {} });
        }
      }
      if (callback) callback(updated);
    });
  });
}

// Handle message commands from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_EXAM') {
    const tabId = sender.tab.id;
    const windowId = sender.tab.windowId;
    
    // Sync the config settings right before the exam session begins
    syncRemoteConfig();
    
    setExamMode(true, tabId, windowId);
    
    // Generate a unique sessionId per exam attempt!
    const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    // Reset flags and logs to 0/empty to start the new exam session fresh!
    chrome.storage.local.set({ 
      violations: 0, 
      lockoutExpiry: 0, 
      lockouts: 0, 
      violationLog: [],
      examUsername: message.username, 
      examStartUrl: sender.tab.url,
      examSessionId: sessionId
    }, () => {
      sendResponse({ success: true, violations: 0, sessionId: sessionId });
    });
    return true; // keep channel open for async response
  } else if (message.type === 'SUBMIT_EXAM') {
    setExamMode(false);
    // Reset flags and lockouts ONLY on legal exit/submit
    chrome.storage.local.set({ violations: 0, lockoutExpiry: 0, lockouts: 0, examUsername: '', examStartUrl: '', examSessionId: '' });
    sendResponse({ success: true });
  } else if (message.type === 'GET_STATUS') {
    chrome.storage.local.get(['examModeActive', 'violations', 'examTabId'], (result) => {
      sendResponse({
        examModeActive: result.examModeActive || false,
        violations: result.violations || 0,
        examTabId: result.examTabId || null
      });
    });
    return true; // Keep channel open for async response
  } else if (message.type === 'GET_CURRENT_TAB_ID') {
    // Respond with the sender's own tab ID so content scripts can self-identify
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
  } else if (message.type === 'PING') {
    syncRemoteConfig((synced) => {
      if (sender.tab && sender.tab.windowId) {
        chrome.windows.get(sender.tab.windowId, (win) => {
          const isMaximizedOrFullscreen = win ? (win.state === 'maximized' || win.state === 'fullscreen') : false;
          sendResponse({
            success: true,
            tabId: sender.tab ? sender.tab.id : null,
            config: synced,
            isWindowMaximized: isMaximizedOrFullscreen,
            windowWidth: win ? win.width : null,
            windowHeight: win ? win.height : null,
            windowState: win ? win.state : null
          });
        });
      } else {
        sendResponse({
          success: true,
          tabId: null,
          config: synced,
          isWindowMaximized: false,
          windowWidth: null,
          windowHeight: null,
          windowState: null
        });
      }
    });
    return true; // Keep channel open for async response
  } else if (message.type === 'REPORT_VIOLATION') {
    logViolation(message.reason, message.username, (count) => {
      sendResponse({ success: true, violations: count });
    }, message.forceLockout === true);
    return true; // Async response
  } else if (message.type === 'FETCH_API') {
    const fetchOptions = message.options || {};
    fetchOptions.method = fetchOptions.method || 'GET';
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    fetchOptions.signal = controller.signal;
    
    fetch(message.url, fetchOptions)
      .then(async (res) => {
        clearTimeout(timeoutId);
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        const text = await res.text();
        try {
          const json = JSON.parse(text);
          sendResponse({ success: true, data: json });
        } catch (e) {
          sendResponse({ success: true, data: text });
        }
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep channel open for async response
  } else if (message.type === 'CHECK_SERVER_LOCKOUT') {
    // ▸ ANTI-TAMPER SHIELD: Content script calls this on every page load to
    //   pull down any cross-browser lockout from the server and apply it locally.
    const usernameToCheck = message.username;
    checkServerLockoutForUser(usernameToCheck, (result) => {
      sendResponse(result || { isBlocked: false, lockoutExpiry: 0, browserSwitchDetected: false });
    });
    return true; // Keep channel open for async response
  }
});

// Enforce tab lock: switch back if another tab is activated
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (examModeActive && examTabId && activeInfo.tabId !== examTabId) {
    chrome.storage.local.get(['noRestrictions', 'blockTabSwitch'], (res) => {
      if (res.noRestrictions || res.blockTabSwitch === false) return;
      // Switch back to the exam tab immediately
      chrome.tabs.update(examTabId, { active: true }, () => {
        if (chrome.runtime.lastError) {
          // Suppress warning if tab update fails (e.g. user is dragging the tab)
          console.warn('Prodigy Shield: Tab update skipped:', chrome.runtime.lastError.message);
        }
        logViolation('Tab change detected');
      });
    });
  }
});

// Enforce window focus lock: detect if browser loses focus (Alt+Tab or click away)
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (examModeActive && examWindowId) {
    chrome.storage.local.get(['noRestrictions', 'blockTabSwitch'], (res) => {
      if (res.noRestrictions || res.blockTabSwitch === false) return;
      if (windowId !== examWindowId) {
        logViolation('Window focus lost (Alt+Tab or system interaction detected)');
      }
    });
  }
});

// Auto-clear exam mode if the exam tab navigates away from the exam page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!examModeActive || tabId !== examTabId) return;
  // Only act when the URL actually changes (not just loading state changes)
  if (changeInfo.url) {
    chrome.storage.local.get(['examStartUrl'], (res) => {
      const examStartUrl = res.examStartUrl;
      if (examStartUrl) {
        try {
          const oldUrl = new URL(examStartUrl);
          const newUrl = new URL(changeInfo.url);
          // Compare origin and pathname prefix to allow query param, hash, and minor SPA path transitions.
          // Note: If they navigated away from the exam page/portal path, clear proctor mode.
          if (oldUrl.origin !== newUrl.origin || oldUrl.pathname !== newUrl.pathname) {
            const prevTabId = examTabId;
            setExamMode(false);
            sendHideIndicators(prevTabId);
          }
        } catch (e) {
          if (changeInfo.url !== examStartUrl) {
            const prevTabId = examTabId;
            setExamMode(false);
            sendHideIndicators(prevTabId);
          }
        }
      } else {
        const prevTabId = examTabId;
        setExamMode(false);
        sendHideIndicators(prevTabId);
      }
    });
  }
});

// Auto-clear exam mode if the exam tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (examModeActive && tabId === examTabId) {
    setExamMode(false);
  }
});

// Strip Permissions-Policy and Feature-Policy headers to enable fullscreen
function setupHeaderRules() {
  if (typeof chrome.declarativeNetRequest === 'undefined') return;

  const RULE_ID = 1;
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "Permissions-Policy", operation: "remove" },
            { header: "Feature-Policy", operation: "remove" }
          ]
        },
        condition: {
          urlFilter: "*://*.prodigyreview.ph/*",
          resourceTypes: ["main_frame", "sub_frame"]
        }
      }
    ]
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Prodigy Shield: Failed to update declarativeNetRequest rules: ', chrome.runtime.lastError);
    } else {
      console.log('Prodigy Shield: Fullscreen header-override rules loaded successfully.');
    }
  });
}

setupHeaderRules();
