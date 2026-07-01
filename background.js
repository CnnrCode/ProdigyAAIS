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
          blockRightClick: data.blockRightClick !== false
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
function logViolation(reason, username, callback) {
  // If the second argument is a callback (e.g. logViolation(reason, callback)), shift parameters
  if (typeof username === 'function') {
    callback = username;
    username = null;
  }

  if (!examModeActive) return;

  chrome.storage.local.get(['violations', 'violationLog', 'milestoneInterval', 'baseDurationSeconds', 'lockoutExpiry', 'lockouts', 'examUsername', 'strictLockout', 'noRestrictions'], (result) => {
    if (result.noRestrictions) {
      if (callback) callback(result.violations || 0);
      return;
    }

    // If the student is currently suspended, ignore any new violation flags
    if (result.lockoutExpiry && Date.now() < result.lockoutExpiry) {
      if (callback) callback(result.violations || 0);
      return;
    }

    const current = result.violations || 0;
    const weight = getViolationWeight(reason);
    const updated = current + weight;
    const resolvedUsername = username || result.examUsername || 'Zen Student';

    let severity = 'Low';
    if (weight === 5) severity = 'High';
    else if (weight === 2) severity = 'Medium';

    const formattedReason = `${reason} [${severity}] (+${weight})`;

    // Report violation to server immediately
    fetch('http://localhost:8000/api/report-violation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: resolvedUsername,
        reason: formattedReason,
        timestamp: new Date().toISOString()
      })
    }).catch(err => console.warn('Failed to send violation to server:', err));

    // Load dynamic config settings (defaulting to 5 flags / 10s if not loaded yet)
    const milestone = result.milestoneInterval || 5;
    const baseSeconds = result.baseDurationSeconds || 10;

    // Build timestamped log entry (capped at 50 entries)
    const log = result.violationLog || [];
    log.push({ reason: formattedReason, timestamp: new Date().toISOString(), count: updated });
    if (log.length > 50) log.shift();

    chrome.storage.local.set({ violations: updated, violationLog: log }, () => {
      if (examTabId) {
        let triggerLockout = Math.floor(updated / milestone) > Math.floor(current / milestone);
        if (result.strictLockout && updated >= milestone) {
          triggerLockout = true;
        }

        if (triggerLockout) {
          const duration = result.strictLockout && updated >= milestone
            ? baseSeconds
            : Math.floor(updated / milestone) * baseSeconds;
          const lockoutExpiry = Date.now() + (duration * 1000);
          const currentLockouts = result.lockouts || 0;
          const updatedLockouts = currentLockouts + 1;
          
          chrome.storage.local.set({ lockoutExpiry: lockoutExpiry, lockouts: updatedLockouts }, () => {
            // Milestone reached — send suspension signal with duration
            chrome.tabs.sendMessage(examTabId, {
              type: 'LOCKOUT_TRIGGERED',
              violations: updated,
              lockouts: updatedLockouts,
              duration: duration
            }, () => { if (chrome.runtime.lastError) {} });
          });
        } else {
          // Normal violation — show dismissable modal
          chrome.tabs.sendMessage(examTabId, {
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
    
    // Reset flags and logs to 0/empty to start the new exam session fresh!
    chrome.storage.local.set({ 
      violations: 0, 
      lockoutExpiry: 0, 
      lockouts: 0, 
      violationLog: [],
      examUsername: message.username, 
      examStartUrl: sender.tab.url 
    }, () => {
      sendResponse({ success: true, violations: 0 });
    });
    return true; // keep channel open for async response
  } else if (message.type === 'SUBMIT_EXAM') {
    setExamMode(false);
    // Reset flags and lockouts ONLY on legal exit/submit
    chrome.storage.local.set({ violations: 0, lockoutExpiry: 0, lockouts: 0, examUsername: '', examStartUrl: '' });
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
            isWindowMaximized: isMaximizedOrFullscreen
          });
        });
      } else {
        sendResponse({
          success: true,
          tabId: null,
          config: synced,
          isWindowMaximized: false
        });
      }
    });
    return true; // Keep channel open for async response
  } else if (message.type === 'REPORT_VIOLATION') {
    logViolation(message.reason, message.username, (count) => {
      sendResponse({ success: true, violations: count });
    });
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
