/* ==========================================================================
   PRODIGY SHIELD: CONTENT SCRIPT
   ========================================================================== */

// --------------------------------------------------------------------------
// 1. STATE & CONFIGURATION VARIABLES
// --------------------------------------------------------------------------
let localExamActive = false;
let overlayElement = null;
let activeIndicatorElement = null;
let activeBorderElement = null;
let examUrl = null;                      // URL when exam started
let urlCheckInterval = null;             // Interval to detect SPA navigation
let devToolsOpen = false;                // Tracks DevTools open state
let devToolsCheckInterval = null;
// DevTools detection baselines. DevTools is inferred from the gap between the
// window's OUTER size and the page viewport (all in CSS pixels). Browser chrome,
// OS display scaling, and page zoom all change that gap WITHOUT DevTools being
// open, so we calibrate a per-session baseline and only react to a large increase.
// devicePixelRatio moves when zoom/scale changes (but NOT when DevTools docks), so
// we rebaseline whenever it changes to avoid false positives.
let devToolsWidthBaseline = null;
let devToolsHeightBaseline = null;
let devToolsBaselineDpr = null;
let localCopyPasteAction = 'flag';       // Cached copy/paste action for synchronous blocking
let isUnloading = false;                  // Tracks if page is currently refreshing/unloading
let localLockoutExpiry = 0;               // Cached lockout expiry for synchronous pre-start checking
let localViolations = 0;                  // Cached violations count
let questionDivCheckInterval = null;
let questionDivMissingCount = 0;
let lockoutPollInterval = null;
let localRequireFullscreen = true;
let localBlockDevTools = true;
let localBlockTabSwitch = true;
let localBlockRightClick = true;
let localNoRestrictions = false;
let sessionStatusSyncInProgress = false;
let lastSessionStatus = null;
let tamperObserver = null;
let localLimitExits = false;         // Whether the exit-limit feature is enabled (admin)
let localMaxExits = 3;               // Max number of times a student may exit an exam
let cachedUsername = null;           // Cache the username to prevent 'Anonymous' fallback on reload before DOM is ready

function getBrowserSuffixOnly() {
  let browserSuffix = "";
  const ua = navigator.userAgent;

  if (navigator.brave !== undefined || (navigator.userAgentData && navigator.userAgentData.brands.some(b => b.brand === 'Brave'))) {
    browserSuffix = " (Brave)";
  } else if (ua.includes("Edg")) {
    browserSuffix = " (Edge)";
  } else if (ua.includes("Chrome")) {
    browserSuffix = " (Chrome)";
  } else if (ua.includes("Firefox")) {
    browserSuffix = " (Firefox)";
  } else {
    browserSuffix = " (Standard)";
  }

  return browserSuffix;
}

// Pre-fetch the cached username from storage as early as possible
chrome.storage.local.get(['examUsername'], (res) => {
  if (res.examUsername) cachedUsername = res.examUsername;
});

// Cache the current browser suffix for the background service worker
try {
  chrome.storage.local.set({ browserSuffix: getBrowserSuffixOnly() });
} catch (e) {}

function getStudentName() {
  // Prefer the stable username captured at exam start (this mirrors the value
  // the background service worker uses for violation reports and that the admin
  // panel displays). Using it everywhere guarantees the lockout, the appeal,
  // and the check-lockout poll all key to the SAME server session. Re-scraping
  // the DOM while the lockout overlay is up can yield a different or empty name,
  // which registers the lock under the wrong user — leaving the admin unable to
  // see the lock or release the student on appeal.
  if (cachedUsername) {
    const cachedClean = cachedUsername.replace(/\s*\((Chrome|Edge|Brave|Firefox|Standard|Mobile)\)/gi, '').trim();
    if (cachedClean) return cachedClean;
  }

  let baseName = "";
  const profileSelectors = [
    'span.text-sm.font-medium.text-gray-700',
    '.user-profile',
    '.profile-name',
    '.profile-initials + span',
    'header span',
    'nav span',
    '#student-name'
  ];
  for (let s of profileSelectors) {
    const el = document.querySelector(s);
    if (el && el.innerText.trim()) {
      baseName = el.innerText.trim();
      break;
    }
  }

  if (!baseName) {
    const allSpans = document.querySelectorAll('span, div');
    for (let i = 0; i < allSpans.length; i++) {
      const text = allSpans[i].textContent || '';
      if (text.includes('Student') && text.length < 30) {
        const clean = text.replace('(Student)', '').replace('Student', '').trim();
        if (clean) {
          baseName = clean;
          break;
        }
      }
    }
  }

  // If we still can't find a name on the page, use the cached one from previous loads
  if (!baseName && cachedUsername) {
    baseName = cachedUsername.replace(/\s*\((Chrome|Edge|Brave|Firefox|Standard|Mobile)\)/gi, '').trim();
  }

  if (!baseName) {
    baseName = "Anonymous";
  }

  return baseName;
}

function safeSendMessage(message, callback) {
  try {
    if (!chrome.runtime?.id) {
      updateShieldHealth('Config Offline');
      forceHideAllIndicators();
      return;
    }

    // Automatically attach student's name if message is an object
    if (message && typeof message === 'object') {
      if (!message.username) {
        message.username = getStudentName();
      }
    }

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        updateShieldHealth('Config Offline');
      }
      if (callback) callback(response);
    });
  } catch (err) {
    if (err.message && err.message.includes('Extension context invalidated')) {
      updateShieldHealth('Config Offline');
      forceHideAllIndicators();
    }
  }
}

let wasFullscreen = false;

function isContextInvalidated() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    cleanupAllExtensionContext();
    return true;
  }
  return false;
}

function cleanupAllExtensionContext() {
  localExamActive = false;
  if (websiteChatbotHideInterval) {
    clearInterval(websiteChatbotHideInterval);
    websiteChatbotHideInterval = null;
  }
  if (urlCheckInterval) {
    clearInterval(urlCheckInterval);
    urlCheckInterval = null;
  }
  if (devToolsCheckInterval) {
    clearInterval(devToolsCheckInterval);
    devToolsCheckInterval = null;
  }
  if (questionDivCheckInterval) {
    clearInterval(questionDivCheckInterval);
    questionDivCheckInterval = null;
  }
  clearLockoutPoll()
  if (typeof tamperObserver !== 'undefined' && tamperObserver) {
    try {
      tamperObserver.disconnect();
    } catch (e) { }
    tamperObserver = null;
  }

  // Remove event listeners
  try {
    window.removeEventListener('blur', handleBlur);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
    document.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('contextmenu', handleContextMenu, true);
    document.removeEventListener('copy', handleCopy);
    document.removeEventListener('cut', handleCut);
    document.removeEventListener('paste', handlePaste);
    document.removeEventListener('click', handleExamNavigationBlocker, true);
  } catch (e) { }
}

function safeHideElement(el) {
  if (!el) return;
  el.dataset.programmatic = 'true';
  el.classList.add('prodigy-hidden');
  setTimeout(() => {
    if (el) delete el.dataset.programmatic;
  }, 50);
}

function safeRemoveElement(el) {
  if (!el) return;
  el.dataset.programmatic = 'true';
  el.remove();
}

function isSessionPaused() {
  const lockoutEl = document.getElementById('prodigy-lockout-overlay');
  const warningEl = document.getElementById('prodigy-anti-cheat-overlay');
  const isLockoutActive = !!lockoutEl;
  const isWarningActive = warningEl && !warningEl.classList.contains('prodigy-hidden');
  return isLockoutActive || isWarningActive;
}

function syncSessionStatus(status, extra = {}) {
  if (sessionStatusSyncInProgress && lastSessionStatus === status) return;
  sessionStatusSyncInProgress = true;
  lastSessionStatus = status;

  const origin = window.location.origin.includes('localhost') ? window.location.origin : 'http://localhost:8000';
  const username = getStudentName();
  chrome.storage.local.get(['violations', 'lockouts', 'examSessionId'], (res) => {
    const payload = Object.assign({
      username,
      status,
      flags: res.violations || 0,
      locks: res.lockouts || 0,
      sessionId: res.examSessionId || '',
      browserSuffix: getBrowserSuffixOnly()
    }, extra);

    safeFetch(`${origin}/api/session-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .catch(err => console.log('Proctor sync status error:', err))
      .finally(() => {
        sessionStatusSyncInProgress = false;
      });
  });
}

function clearLockoutPoll() {
  if (lockoutPollInterval) {
    clearInterval(lockoutPollInterval);
    lockoutPollInterval = null;
  }
}

function safeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    if (isContextInvalidated()) {
      reject(new TypeError('Extension context invalidated'));
      return;
    }

    let timeoutId = setTimeout(() => {
      timeoutId = null;
      reject(new TypeError('safeFetch request timed out'));
    }, 5500);

    try {
      safeSendMessage({
        type: 'FETCH_API',
        url: url,
        options: options
      }, (response) => {
        if (!timeoutId) return; // already timed out
        clearTimeout(timeoutId);
        timeoutId = null;

        if (chrome.runtime.lastError) {
          reject(new TypeError(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.success) {
          resolve(response.data);
        } else {
          reject(new TypeError(response ? response.error : 'Network request failed'));
        }
      });
    } catch (err) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      reject(err);
    }
  });
}

function requestFullscreen() {
  if (isSessionPaused()) {
    return;
  }
  if (!document.fullscreenElement) {
    if (window.navigator?.userActivation && !window.navigator.userActivation.isActive) {
      showFullscreenRequiredModal();
      return;
    }
    const el = document.documentElement || document.body;
    el.requestFullscreen().catch((err) => {
      console.warn('Fullscreen request failed or was blocked: ', err);
      showFullscreenRequiredModal();
    });
  }
}

// --------------------------------------------------------------------------
// 3. STATE MONITORS & DETECTORS
// --------------------------------------------------------------------------
function startUrlMonitor() {
  examUrl = window.location.href;
  if (urlCheckInterval) clearInterval(urlCheckInterval);
  urlCheckInterval = setInterval(() => {
    if (isContextInvalidated()) return;
    if (!localExamActive) {
      clearInterval(urlCheckInterval);
      urlCheckInterval = null;
      return;
    }
    try {
      const currentBaseUrl = window.location.origin + window.location.pathname;
      const examBaseUrl = new URL(examUrl).origin + new URL(examUrl).pathname;
      if (currentBaseUrl !== examBaseUrl) {
        stopExamLocal();
        safeSendMessage({ type: 'SUBMIT_EXAM' });
      }
    } catch (e) {
      if (window.location.href !== examUrl) {
        stopExamLocal();
        safeSendMessage({ type: 'SUBMIT_EXAM' });
      }
    }
  }, 500);
}

// Stop URL checking
function stopUrlMonitor() {
  if (urlCheckInterval) {
    clearInterval(urlCheckInterval);
    urlCheckInterval = null;
  }
  examUrl = null;
}

function isQuestionDivPresent() {
  const regex = /Question\s+\d+\s+of\s+\d+/i;

  if (!document.body || !regex.test(document.body.innerText)) {
    return false;
  }

  const elements = document.querySelectorAll('span, h3, h2, p, div');
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.children.length <= 2 && regex.test(el.textContent)) {
      return true;
    }
  }
  return false;
}

function restoreExamDOMState() {
  const startSection = document.getElementById('start-section');
  const examSection = document.getElementById('exam-section');
  if (startSection && startSection.style.display !== 'none') {
    startSection.style.setProperty('display', 'none', 'important');
  }
  if (examSection && (examSection.style.display === 'none' || examSection.classList.contains('hidden'))) {
    examSection.style.setProperty('display', 'flex', 'important');
    examSection.classList.remove('hidden');
  }
}

function startQuestionDivMonitor() {
  if (questionDivCheckInterval) clearInterval(questionDivCheckInterval);
  questionDivMissingCount = 0;

  questionDivCheckInterval = setInterval(() => {
    if (isContextInvalidated()) return;
    if (!localExamActive) {
      clearInterval(questionDivCheckInterval);
      questionDivCheckInterval = null;
      return;
    }

    // Automatically recover the visual DOM state of the exam page on reloads
    restoreExamDOMState();

    // Do not check or increment missing count if currently locked out
    if (document.getElementById('prodigy-lockout-overlay')) {
      questionDivMissingCount = 0;
      return;
    }

    if (isQuestionDivPresent()) {
      questionDivMissingCount = 0;

      // Periodically enforce fullscreen requirement
      chrome.storage.local.get(['requireFullscreen'], (res) => {
        if (res.requireFullscreen !== false && !document.fullscreenElement && !isSessionPaused()) {
          showFullscreenRequiredModal();
        } else if (document.fullscreenElement) {
          hideFullscreenRequiredModal();
        }
      });
    } else {
      questionDivMissingCount++;
      if (questionDivMissingCount >= 3) {
        clearInterval(questionDivCheckInterval);
        questionDivCheckInterval = null;

        console.log("Prodigy Shield: Question container not found for 3 seconds. Auto-stopping exam mode.");
        stopExamLocal();
        safeSendMessage({ type: 'SUBMIT_EXAM' });
      }
    }
  }, 1000);
}

function stopQuestionDivMonitor() {
  if (questionDivCheckInterval) {
    clearInterval(questionDivCheckInterval);
    questionDivCheckInterval = null;
  }
  questionDivMissingCount = 0;
}

let websiteChatbotHideInterval = null;

function hideWebsiteChatbotElements() {
  if (isContextInvalidated()) return;
  if (!localExamActive) return;

  // 1. Target inputs/textareas with chatbot placeholders, hiding their widget containers
  const inputs = document.querySelectorAll('input, textarea');
  inputs.forEach(input => {
    if (input.id && input.id.startsWith('prodigy-')) return;

    const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
    if (placeholder.includes('ask') || placeholder.includes('tutor') || placeholder.includes('chat') || placeholder.includes('reply')) {
      input.style.setProperty('display', 'none', 'important');

      let parent = input.parentElement;
      while (parent && parent !== document.body) {
        const style = window.getComputedStyle(parent);
        if (style.position === 'fixed' || style.position === 'absolute' || parent.className.includes('chat') || parent.className.includes('widget') || parent.id.includes('chat')) {
          parent.style.setProperty('display', 'none', 'important');
          break;
        }
        parent = parent.parentElement;
      }
    }
  });

  // 2. Hide any buttons or fixed/absolute elements containing "chat" or "tutor" in classes/IDs
  const elements = document.querySelectorAll('button, div.fixed, div.absolute, [class*="fixed"], [class*="absolute"], [class*="chat"], [class*="tutor"], [id*="chat"], [id*="tutor"]');
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.id && el.id.startsWith('prodigy-')) continue;

    const idStr = (el.id || '').toLowerCase();

    let classStr = '';
    if (el.className) {
      if (typeof el.className === 'string') {
        classStr = el.className;
      } else if (typeof el.className === 'object' && el.className.baseVal) {
        classStr = el.className.baseVal;
      }
    }
    classStr = classStr.toLowerCase();

    const isMatch = idStr.includes('chat') ||
      idStr.includes('tutor') ||
      classStr.includes('chat') ||
      classStr.includes('tutor');

    if (isMatch) {
      el.style.setProperty('display', 'none', 'important');
      continue;
    }

    // 3. Fallback: bottom-right corner launcher check
    const style = window.getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'absolute') {
      const bottom = parseFloat(style.bottom);
      const right = parseFloat(style.right);

      // Bottom-right corner threshold (within 120px from edge)
      if (!isNaN(bottom) && !isNaN(right) && bottom >= 0 && bottom < 120 && right >= 0 && right < 120) {
        const width = parseFloat(style.width);
        const height = parseFloat(style.height);

        // Chatbot bubble is usually a small button or circle (width/height between 25px and 100px)
        if (width > 25 && width < 100 && height > 25 && height < 100) {
          el.style.setProperty('display', 'none', 'important');
        }
      }
    }
  }
}

function startWebsiteChatbotHider() {
  if (websiteChatbotHideInterval) clearInterval(websiteChatbotHideInterval);
  // Scan every 500ms for new elements added dynamically by React
  websiteChatbotHideInterval = setInterval(hideWebsiteChatbotElements, 500);
  hideWebsiteChatbotElements(); // run immediately
}

function stopWebsiteChatbotHider() {
  if (websiteChatbotHideInterval) {
    clearInterval(websiteChatbotHideInterval);
    websiteChatbotHideInterval = null;
  }
}

// SIZE-INDEPENDENT DevTools detector. Geometry heuristics are defeated by undocked
// DevTools (separate window) and by device/responsive mode (which sets
// window.innerWidth to the EMULATED device size). The `debugger` statement does not
// depend on window geometry: it is a genuine no-op (~0ms) when DevTools is CLOSED
// (so it never false-positives on an honest student), but pauses execution when
// DevTools is open in ANY mode (docked, undocked, device/responsive mode). The only
// residual bypass is manually deactivating breakpoints (Ctrl+F8), which requires a
// browser policy to fully close.
function detectDevToolsSizeIndependent() {
  try {
    const t0 = performance.now();
    (function () { debugger; })();
    // A real DevTools pause lasts far longer than any main-thread jank; 150ms
    // cleanly separates "paused" from "not paused" without false positives.
    return (performance.now() - t0) > 150;
  } catch (e) {
    return false;
  }
}

function startDevToolsDetection() {
  devToolsOpen = false;
  devToolsWidthBaseline = null;
  devToolsHeightBaseline = null;
  devToolsBaselineDpr = null;
  if (!localBlockDevTools || localNoRestrictions) return;
  if (devToolsCheckInterval) clearInterval(devToolsCheckInterval);
  devToolsCheckInterval = setInterval(() => {
    if (isContextInvalidated()) return;
    if (!localExamActive) return;
    if (!localBlockDevTools || localNoRestrictions) return;

    safeSendMessage({ type: 'PING' }, (response) => {
      if (isContextInvalidated() || !localExamActive) return;
      if (!localBlockDevTools || localNoRestrictions) return;

      const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

      let isSizeMismatch = false;
      let isSnappedOrResized = false;

      // DEVTOOLS DETECTION — measure ONLY window.outer* vs window.inner* (both in
      // CSS pixels). The old code compared chrome.windows dimensions (screen pixels)
      // against innerWidth/innerHeight (CSS pixels); with OS display scaling
      // (125%/150%) or non-100% page zoom those two units diverge and produced
      // FALSE positives, flagging DevTools when nothing was open.
      const dpr = window.devicePixelRatio || 1;
      const widthGap = window.outerWidth - window.innerWidth;
      const heightGap = window.outerHeight - window.innerHeight;

      // Zoom / display-scale changes move devicePixelRatio (docking DevTools does
      // NOT). When it moves, rebaseline instead of flagging — this is what prevents
      // false positives when the student zooms or is on a scaled display.
      if (devToolsBaselineDpr === null || Math.abs(dpr - devToolsBaselineDpr) > 0.01) {
        devToolsBaselineDpr = dpr;
        devToolsWidthBaseline = widthGap;
        devToolsHeightBaseline = heightGap;
      }
      // The smallest gap seen at this zoom level = browser chrome only (no dock).
      if (widthGap < devToolsWidthBaseline) devToolsWidthBaseline = widthGap;
      if (heightGap < devToolsHeightBaseline) devToolsHeightBaseline = heightGap;

      // A large INCREASE over that baseline means a panel opened: width => side dock
      // or side panel, height => bottom-docked DevTools.
      const sizeGrew =
        (widthGap - devToolsWidthBaseline) > 120 ||
        (heightGap - devToolsHeightBaseline) > 120;

      // SIZE-INDEPENDENT detection catches undocked DevTools and device/responsive
      // mode, which defeat all of the geometry checks above.
      const debuggerDetected = detectDevToolsSizeIndependent();

      isSizeMismatch = sizeGrew || debuggerDetected;

      // Snap / split-screen / not-maximized uses the window STATE (reliable), never
      // raw dimensions.
      if (response && response.success && response.windowState) {
        isSnappedOrResized =
          response.windowState !== 'maximized' &&
          response.windowState !== 'fullscreen';
      } else if (!isMobile) {
        isSnappedOrResized =
          window.outerWidth < (window.screen.availWidth * 0.85) ||
          window.outerHeight < (window.screen.availHeight * 0.85);
      }

      if (isSizeMismatch && !devToolsOpen) {
        devToolsOpen = true;
        updateShieldHealth('Interrupted');

        const reason = debuggerDetected
          ? 'Developer Tools opened'
          : (isSnappedOrResized
            ? 'Window snapped, split-screened, or not maximized'
            : 'Developer Tools or Side Panel opened');

        // ZERO-TOLERANCE for DevTools / side panels: force an immediate lockout
        // instead of merely adding flags. With a high milestoneInterval, a +5 flag
        // violation would never cross the lockout threshold, letting a student sit
        // in the exam with the inspector open. Snap/resize stays flag-based.
        safeSendMessage({
          type: 'REPORT_VIOLATION',
          reason: reason,
          forceLockout: debuggerDetected || !isSnappedOrResized
        });
      } else if (!isSizeMismatch) {
        if (devToolsOpen) {
          devToolsOpen = false;
          updateShieldHealth('Secure');
        }
      }
    });
  }, 1000);
}

function startTamperMonitor() {
  if (tamperObserver) stopTamperMonitor();

  // Create MutationObserver to watch document body for structural or attribute changes
  tamperObserver = new MutationObserver((mutations) => {
    if (isContextInvalidated()) return;
    if (!localExamActive) return;

    let detectedTampering = false;
    let tamperDetails = '';

    for (let mutation of mutations) {
      // 1. Check for removed nodes (Deletions)
      if (mutation.type === 'childList') {
        mutation.removedNodes.forEach((node) => {
          const hasProdigyPrefix = (node.id && node.id.startsWith('prodigy-')) ||
            (node.classList && Array.from(node.classList).some(c => c.startsWith('prodigy-')));
          if (hasProdigyPrefix) {
            // Check programmatic flag
            if (node.dataset && node.dataset.programmatic === 'true') {
              return;
            }

            // If the active indicator, active border, lockout overlay, or fullscreen overlay is removed
            if (node.id === 'prodigy-lockout-overlay' ||
              node.classList?.contains('prodigy-active-indicator') ||
              node.classList?.contains('prodigy-active-border') ||
              node.id === 'prodigy-fullscreen-required-overlay') {
              detectedTampering = true;
              tamperDetails = `Removed proctor element: #${node.id || node.className}`;
            }
          }
        });
      }

      // 2. Check for attribute changes (styles, classes) on proctor elements
      if (mutation.type === 'attributes' && mutation.attributeName) {
        const target = mutation.target;
        const hasProdigyPrefix = (target.id && target.id.startsWith('prodigy-')) ||
          (target.classList && Array.from(target.classList).some(c => c.startsWith('prodigy-')));

        if (hasProdigyPrefix) {
          // Only enforce anti-hiding on critical top-level overlays/indicators
          const isCriticalElement = target.id === 'prodigy-lockout-overlay' ||
            target.classList?.contains('prodigy-active-indicator') ||
            target.classList?.contains('prodigy-active-border') ||
            target.id === 'prodigy-fullscreen-required-overlay';

          if (!isCriticalElement) {
            continue;
          }

          // Check programmatic flag
          if (target.dataset && target.dataset.programmatic === 'true') {
            continue;
          }

          // Accurate hiding detection using ComputedStyle (catches both inline styles and classes)
          if (mutation.attributeName === 'style' || mutation.attributeName === 'class') {
            const style = window.getComputedStyle(target);
            const classes = target.className || '';

            const isStyleHidden = style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0;
            const isClassHidden = classes.includes('prodigy-hidden') && !target.id.includes('widget');

            if (isStyleHidden || isClassHidden) {
              detectedTampering = true;
              tamperDetails = `Hid proctor element: #${target.id || target.className}`;
            }
          }
        }

        // 3. Special Chatbot enforcement: Check if unhidden maliciously
        if (target.id === 'prodigy-chat-launcher' || target.id === 'prodigy-chat-widget') {
          chrome.storage.local.get(['chatbotDuringExam'], (res) => {
            if (!res.chatbotDuringExam) {
              const classes = target.className || '';
              if (!classes.includes('prodigy-hidden-force')) {
                // Violator tried to make chatbot visible by removing prodigy-hidden-force class!
                safeSendMessage({
                  type: 'REPORT_VIOLATION',
                  reason: `Tampering detected: Attempted to reveal Socratic AI chatbot`
                });
                // Force it back to hidden
                target.classList.add('prodigy-hidden-force');
              }
            }
          });
        }
      }
    } // End of mutations loop

    // If tampering was flagged anywhere during this mutation batch, take action here
    if (detectedTampering) {
  // Disconnect observer temporarily to prevent infinite loop while recreating elements
  tamperObserver.disconnect();

  console.warn("Prodigy Shield: Tampering detected!", tamperDetails);
  safeSendMessage({
    type: 'REPORT_VIOLATION',
    reason: `Tampering detected: ${tamperDetails}`
  });

  // Restore elements
  if (localExamActive) {
    showActiveIndicator();

    if (!document.fullscreenElement && !isSessionPaused() && isQuestionDivPresent()) {
      chrome.storage.local.get(['requireFullscreen'], (res) => {
        if (res.requireFullscreen !== false) {
          showFullscreenRequiredModal();
        }
      });
    }
  }

  // Reconnect observer
  tamperObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class']
  });
}
});

// Start observing the body
tamperObserver.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['style', 'class']
});
}

function stopTamperMonitor() {
  if (tamperObserver) {
    tamperObserver.disconnect();
    tamperObserver = null;
  }
}

// --------------------------------------------------------------------------
// 4. CORE EXAM LIFECYCLE MANAGEMENT
// --------------------------------------------------------------------------
function startExamLocal(initialViolations = 0) {
  if (localExamActive) return;
  localExamActive = true;
  isUnloading = false;
  wasFullscreen = !!document.fullscreenElement;

  chrome.storage.local.get([
    'copyPasteAction', 'noRestrictions', 'requireFullscreen',
    'blockDevTools', 'blockTabSwitch', 'blockRightClick', 'chatbotDuringExam',
    'limitExits', 'maxExits'
  ], (result) => {
    localNoRestrictions = !!result.noRestrictions;
    localLimitExits = result.limitExits === true;
    localMaxExits = (typeof result.maxExits === 'number' && result.maxExits > 0) ? result.maxExits : 3;
    localRequireFullscreen = result.requireFullscreen !== false;
    localBlockDevTools = result.blockDevTools !== false;
    localBlockTabSwitch = result.blockTabSwitch !== false;
    localBlockRightClick = result.blockRightClick !== false;
    // Hide AI Chatbot launcher and panels during an active exam session unless chatbotDuringExam is enabled
    if (!result.chatbotDuringExam) {
      if (chatLauncher) chatLauncher.classList.add('prodigy-hidden-force');
      if (chatWidget) chatWidget.classList.add('prodigy-hidden-force');
      removeSelectionTooltip();
    }

    if (result.noRestrictions) {
      showActiveIndicator();
      updateShieldHealth('Secure');

      syncSessionStatus('Active Exam');
      return;
    }

    localCopyPasteAction = result.copyPasteAction || 'flag';

    if (result.requireFullscreen !== false) {
      requestFullscreen();
    }

    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('contextmenu', handleContextMenu, true);
    document.addEventListener('copy', handleCopy);
    document.addEventListener('cut', handleCut);
    document.addEventListener('paste', handlePaste);
    document.addEventListener('click', handleExamNavigationBlocker, true);

    startDevToolsDetection();
    showActiveIndicator();
    updateShieldHealth('Secure');
    startUrlMonitor();
    startQuestionDivMonitor();
    startWebsiteChatbotHider();
    startTamperMonitor();

    // Notify server of active proctor session
    syncSessionStatus('Active Exam');

    if (initialViolations > 0) {
      showViolationOverlay(initialViolations, 'Exam session restored with existing flags.');
    }

    if (result.requireFullscreen !== false && !document.fullscreenElement && !isSessionPaused() && isQuestionDivPresent()) {
      showFullscreenRequiredModal();
    }
  });
}

function stopExamLocal() {
  if (!localExamActive) return;
  localExamActive = false;
  stopTamperMonitor();
  wasFullscreen = false;

  stopUrlMonitor();
  stopQuestionDivMonitor();
  stopWebsiteChatbotHider();
  if (devToolsCheckInterval) {
    clearInterval(devToolsCheckInterval);
    devToolsCheckInterval = null;
  }
  devToolsOpen = false;

  // Restore AI Chatbot launcher and panel when exam ends
  if (chatLauncher) chatLauncher.classList.remove('prodigy-hidden-force');
  if (chatWidget) chatWidget.classList.remove('prodigy-hidden-force');

  window.removeEventListener('blur', handleBlur);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  document.removeEventListener('fullscreenchange', handleFullscreenChange);
  document.removeEventListener('keydown', handleKeyDown, true);
  document.removeEventListener('contextmenu', handleContextMenu, true);
  document.removeEventListener('copy', handleCopy);
  document.removeEventListener('cut', handleCut);
  document.removeEventListener('paste', handlePaste);
  document.removeEventListener('click', handleExamNavigationBlocker, true);

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(err => console.log('Fullscreen exit error:', err));
  }

  forceHideAllIndicators({ syncIdle: false });

  if (overlayElement) {
    overlayElement.classList.add('prodigy-hidden');
  }

  hideFullscreenRequiredModal();

  // Notify server that the session has ended cleanly
  syncSessionStatus('Idle');
}

function forceHideAllIndicators(options = {}) {
  localExamActive = false;
  stopTamperMonitor();
  stopUrlMonitor();
  stopQuestionDivMonitor();
  stopWebsiteChatbotHider();
  if (devToolsCheckInterval) {
    clearInterval(devToolsCheckInterval);
    devToolsCheckInterval = null;
  }
  devToolsOpen = false;

  // Restore AI Chatbot launcher and panel when indicators are cleaned up
  if (chatLauncher) chatLauncher.classList.remove('prodigy-hidden-force');
  if (chatWidget) chatWidget.classList.remove('prodigy-hidden-force');

  document.removeEventListener('keydown', handleKeyDown, true);
  document.removeEventListener('contextmenu', handleContextMenu, true);
  document.removeEventListener('copy', handleCopy);
  document.removeEventListener('cut', handleCut);
  document.removeEventListener('paste', handlePaste);
  document.removeEventListener('click', handleExamNavigationBlocker, true);

  hideFullscreenRequiredModal();

  if (activeIndicatorElement) {
    activeIndicatorElement.remove();
    activeIndicatorElement = null;
  }
  if (activeBorderElement) {
    activeBorderElement.remove();
    activeBorderElement = null;
  }
  if (overlayElement) {
    overlayElement.classList.add('prodigy-hidden');
  }

  // Notify server that indicators are cleared
  if (options.syncIdle !== false) {
    syncSessionStatus('Idle');
  }
}

function restoreExamSession(result) {
  const now = Date.now();
  if (result.lockoutExpiry && now < result.lockoutExpiry) {
    startExamLocal(0);
    const remaining = Math.ceil((result.lockoutExpiry - now) / 1000);
    showLockoutOverlay(result.violations || 0, remaining);
  } else {
    startExamLocal(result.violations || 0);
  }
}

// --------------------------------------------------------------------------
// 5. SECURITY VIOLATION INTERCEPTORS & EVENT HANDLERS
// --------------------------------------------------------------------------
function handleKeyDown(e) {
  if (isContextInvalidated()) return;
  if (!localExamActive) return;
  if (localNoRestrictions) return;
  if (isSessionPaused()) return;
  const key = e.key;
  const ctrl = e.ctrlKey;
  const shift = e.shiftKey;

  let reason = null;

  if (key === 'F12') {
    reason = 'Developer Tools shortcut blocked (F12)';
  } else if (ctrl && shift && (key === 'I' || key === 'i')) {
    reason = 'Developer Tools shortcut blocked (Ctrl+Shift+I)';
  } else if (ctrl && shift && (key === 'J' || key === 'j')) {
    reason = 'Developer Tools shortcut blocked (Ctrl+Shift+J)';
  } else if (ctrl && (key === 'u' || key === 'U')) {
    reason = 'View Source blocked (Ctrl+U)';
  } else if (ctrl && (key === 'f' || key === 'F')) {
    reason = 'Find shortcut blocked (Ctrl+F)';
  } else if (key === 'PrintScreen') {
    reason = 'Screenshot attempted (Print Screen)';
  }

  if (reason) {
    const isDevToolsShortcut = reason.includes('Developer Tools') || reason.includes('Source');
    if (isDevToolsShortcut && !localBlockDevTools) return;
    e.preventDefault();
    e.stopPropagation();
    safeSendMessage({ type: 'REPORT_VIOLATION', reason });
  }
}

function handleContextMenu(e) {
  if (isContextInvalidated()) return;
  if (!localExamActive) return;
  if (localNoRestrictions || !localBlockRightClick) return;
  if (isSessionPaused()) return;
  e.preventDefault();
  e.stopPropagation();
}

function handleCopy(e) {
  if (isContextInvalidated()) return;
  if (!localExamActive) return;
  if (isSessionPaused()) return;
  if (localCopyPasteAction !== 'allow') {
    e.preventDefault();
    if (localCopyPasteAction === 'flag') {
      safeSendMessage({
        type: 'REPORT_VIOLATION',
        reason: 'Content copied during exam (Ctrl+C / Copy) - Blocked'
      });
    } else if (localCopyPasteAction === 'toast') {
      showToastNotification('Copying is not allowed during the exam.');
    }
  }
}

function handleCut(e) {
  if (isContextInvalidated()) return;
  if (!localExamActive) return;
  if (isSessionPaused()) return;
  if (localCopyPasteAction !== 'allow') {
    e.preventDefault();
    if (localCopyPasteAction === 'flag') {
      safeSendMessage({
        type: 'REPORT_VIOLATION',
        reason: 'Content cut during exam (Ctrl+X / Cut) - Blocked'
      });
    } else if (localCopyPasteAction === 'toast') {
      showToastNotification('Cutting text is not allowed during the exam.');
    }
  }
}

function handlePaste(e) {
  if (isContextInvalidated()) return;
  if (!localExamActive) return;
  if (isSessionPaused()) return;
  if (localCopyPasteAction !== 'allow') {
    e.preventDefault();
    if (localCopyPasteAction === 'flag') {
      safeSendMessage({
        type: 'REPORT_VIOLATION',
        reason: 'Paste detected during exam (Ctrl+V / Paste) - Blocked'
      });
    } else if (localCopyPasteAction === 'toast') {
      showToastNotification('Pasting is not allowed during the exam.');
    }
  }
}

function handleBlur() {
  if (isContextInvalidated()) return;
  if (!localExamActive || isUnloading) return;
  if (localNoRestrictions || !localBlockTabSwitch) return;
  if (isSessionPaused()) return;
  updateShieldHealth('Warning');
  safeSendMessage({
    type: 'REPORT_VIOLATION',
    reason: 'Window focus lost (Alt+Tab or click away)'
  });
}

function handleVisibilityChange() {
  if (isContextInvalidated()) return;
  if (!localExamActive || isUnloading) return;
  if (isSessionPaused()) return;
  if (document.visibilityState === 'hidden') {
    if (localNoRestrictions || !localBlockTabSwitch) return;
    updateShieldHealth('Warning');
    safeSendMessage({
      type: 'REPORT_VIOLATION',
      reason: 'Tab visibility hidden (Switched tab or minimized)'
    });
  }
}

function handleFullscreenChange() {
  if (isContextInvalidated()) return;
  if (!localExamActive || isUnloading) return;
  if (localNoRestrictions || !localRequireFullscreen) return;
  if (isSessionPaused()) return;
  {

    const isNowFullscreen = !!document.fullscreenElement;
    if (!isNowFullscreen && wasFullscreen) {
      updateShieldHealth('Fullscreen Required');
      safeSendMessage({
        type: 'REPORT_VIOLATION',
        reason: 'Fullscreen exited manually'
      });

      if (!isSessionPaused() && isQuestionDivPresent()) {
        showFullscreenRequiredModal();
      }
    } else if (!isNowFullscreen) {
      updateShieldHealth('Fullscreen Required');
      if (!isSessionPaused() && isQuestionDivPresent()) {
        showFullscreenRequiredModal();
      }
    } else {
      updateShieldHealth('Secure');
      hideFullscreenRequiredModal();
    }
    wasFullscreen = isNowFullscreen;
  }
}

function handleExamNavigationBlocker(event) {
  if (isContextInvalidated()) return;
  if (!localExamActive) return;
  if (localNoRestrictions) return;

  const target = event.target;
  if (!target) return;

  if (target.closest('[id^="prodigy-"]')) return;

  const link = target.closest('a');
  if (link) {
    const href = link.getAttribute('href');
    const isExitOrSubmit = link.textContent.toLowerCase().includes('exit') || link.textContent.toLowerCase().includes('submit');

    if (isExitOrSubmit && isActionConfirmed) {
      // Allow the programmatic click to pass through to the website's own handler.
      return;
    }

    if (isExitOrSubmit) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const isSubmit = link.textContent.toLowerCase().includes('submit');
      promptEndExam(isSubmit ? 'submit' : 'exit', link);
      return;
    }

    if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !isExitOrSubmit) {
      event.preventDefault();
      event.stopPropagation();
      showNavigationBlockedWarning();
      return;
    }
  }

  const navContainer = target.closest('nav') ||
    target.closest('aside') ||
    target.closest('header') ||
    target.closest('[class*="sidebar"]') ||
    target.closest('[class*="navbar"]') ||
    target.closest('[class*="menu"]');

  if (navContainer) {
    const interactive = target.closest('button') || target.closest('a');
    if (interactive) {
      const text = interactive.textContent ? interactive.textContent.trim().toLowerCase() : '';
      if (text.includes('exit') || text.includes('submit')) return;
    }

    event.preventDefault();
    event.stopPropagation();
    showNavigationBlockedWarning();
  }
}

// --------------------------------------------------------------------------
// 6. UI MODALS & OVERLAYS (HTML INJECTION)
// --------------------------------------------------------------------------
function showActiveIndicator() {
  if (!activeIndicatorElement) {
    activeIndicatorElement = document.createElement('div');
    activeIndicatorElement.className = 'prodigy-active-indicator';
    activeIndicatorElement.innerHTML = `
      <span class="prodigy-active-indicator-pulse"></span>
      <span class="prodigy-active-title">Prodigy Shield Active</span>
      <span class="prodigy-health-badge secure" id="prodigy-health-badge">Secure</span>
      <span class="prodigy-active-separator">|</span>
      <span class="prodigy-active-hint" id="prodigy-active-hint">Do not switch tabs, exit fullscreen, or snap windows to prevent flags.</span>
    `;
    document.body.appendChild(activeIndicatorElement);
  } else {
    activeIndicatorElement.style.display = 'flex';
  }

  if (!activeBorderElement) {
    activeBorderElement = document.createElement('div');
    activeBorderElement.className = 'prodigy-active-border';
    document.body.appendChild(activeBorderElement);
  } else {
    activeBorderElement.style.display = 'block';
  }
}

function updateShieldHealth(status) {
  const badge = document.getElementById('prodigy-health-badge');
  const hint = document.getElementById('prodigy-active-hint');
  if (!badge) return;

  badge.className = 'prodigy-health-badge';

  if (status === 'Secure') {
    badge.classList.add('secure');
    badge.textContent = 'Secure';
    if (hint) hint.textContent = 'Do not switch tabs, exit fullscreen, or snap windows to prevent flags.';
  } else if (status === 'Warning') {
    badge.classList.add('warning');
    badge.textContent = 'Warning';
    if (hint) hint.textContent = 'Focus lost or minor warning flagged. Refocus on exam.';
  } else if (status === 'Interrupted') {
    badge.classList.add('critical');
    badge.textContent = 'Interrupted';
    if (hint) hint.textContent = 'Proctor connection or window parameters snap mismatch.';
  } else if (status === 'Config Offline') {
    badge.classList.add('critical');
    badge.textContent = 'Config Offline';
    if (hint) hint.textContent = 'Extension context invalidated. Restart exam.';
  } else if (status === 'Fullscreen Required') {
    badge.classList.add('critical');
    badge.textContent = 'Fullscreen Required';
    if (hint) hint.textContent = 'Please re-enter fullscreen immediately to continue.';
  } else if (status === 'Lockout Active') {
    badge.classList.add('critical');
    badge.textContent = 'Lockout Active';
    if (hint) hint.textContent = 'Session suspended due to multiple proctor violations.';
  }
}

function hideActiveIndicator() {
  forceHideAllIndicators();
}

function showViolationOverlay(violationsCount, reason) {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(err => console.log('Fullscreen exit error during violation warning:', err));
  }
  if (!overlayElement) {
    overlayElement = document.createElement('div');
    overlayElement.id = 'prodigy-anti-cheat-overlay';
    overlayElement.className = 'prodigy-overlay';
    document.body.appendChild(overlayElement);
  }

  overlayElement.innerHTML = `
    <div class="prodigy-modal">
      <div class="prodigy-warning-icon">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </div>
      <h2 class="prodigy-modal-title">Keep Focused</h2>
      <p class="prodigy-modal-description">We've paused your session to help keep the exam fair for everyone.</p>
      
      <div class="prodigy-reason-box">
        <span class="prodigy-reason-label">Action Flagged:</span>
        <span class="prodigy-reason-text">${reason}</span>
      </div>

      <div class="prodigy-stat-card">
        <div class="prodigy-stat-label">TOTAL FLAGS</div>
        <div class="prodigy-stat-value">${violationsCount}</div>
      </div>

      <p class="prodigy-warning-subtext">
        Note: Please avoid tab switching, resizing windows, copy-pasting, or using shortcut hotkeys. Tap the button below to refocus and resume.
      </p>

      <button id="prodigy-acknowledge-btn" class="prodigy-btn">
        Resume Exam
      </button>
    </div>
  `;

  overlayElement.classList.remove('prodigy-hidden');

  const ackBtn = overlayElement.querySelector('#prodigy-acknowledge-btn');
  if (ackBtn) {
    ackBtn.addEventListener('click', () => {
      requestFullscreen();
      safeHideElement(overlayElement);
    });
  }
}

function showLockoutOverlay(violationsCount, duration, opts) {
  updateShieldHealth('Lockout Active');
  const lockoutDuration = duration || 10;
  opts = opts || {};
  const lockoutTitle = opts.title || 'SESSION PAUSED';
  const lockoutDescription = opts.description || `Your exam is temporarily paused because you reached <strong>${violationsCount} security flags</strong>. Take a moment to refocus.`;
  const lockoutStatLabel = opts.statLabel || 'TOTAL FLAGS';
  const lockoutStatValue = (opts.statValue !== undefined && opts.statValue !== null) ? opts.statValue : violationsCount;
  const lockoutReason = opts.reason || (violationsCount ? 'Security violations detected' : 'Exam rule enforcement');
  const LOCKOUT_TIPS = [
    "Alt+Tab / clicking away registers focus loss flags.",
    "Exiting fullscreen mode manually suspends access.",
    "Docking Developer Tools or Side Panels triggers block events.",
    "F12, Ctrl+Shift+I, or Ctrl+Shift+J is blocked.",
    "Right-clicking to 'Inspect Element' is disabled.",
    "Copying, cutting, or pasting text triggers security flags.",
    "Snapping the window (split screen) suspends access."
  ];

  if (document.getElementById('prodigy-lockout-overlay')) return;

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(err => console.log('Fullscreen exit error during lockout:', err));
  }

  const origin = window.location.origin.includes('localhost') ? window.location.origin : 'http://localhost:8000';

  // Re-affirm this lockout to the proctor server whenever the overlay is shown
  // (including on page-load restore). The authoritative, counted registration
  // happens in the background worker the instant a lockout triggers; this POST
  // is a self-healing safety net so that if the server row was wiped externally
  // (e.g. a hard reset of the exam app) the student still shows as locked. It is
  // flagged reaffirm:true so the server never double-counts a lockout, and it
  // sends the SAME stored lockoutExpiry the background used so both posts refer
  // to the same lock window. The server preserves any pending appeal.
  chrome.storage.local.get(['violations', 'examSessionId', 'lockoutExpiry'], (res) => {
    const username = getStudentName();
    const flags = res.violations || violationsCount || 0;
    const sessionId = res.examSessionId || '';
    const expiry = res.lockoutExpiry || (Date.now() + lockoutDuration * 1000);
    safeFetch(`${origin}/api/lockout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, lockoutExpiry: expiry, flags, sessionId, reaffirm: true, browserSuffix: getBrowserSuffixOnly() })
    }).catch(err => console.log('Proctor lockout sync error:', err));
  });

  const lockoutEl = document.createElement('div');
  lockoutEl.id = 'prodigy-lockout-overlay';
  lockoutEl.className = 'prodigy-lockout-overlay';
  const reviewedStr = new Date().toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const reactivateStr = new Date(Date.now() + lockoutDuration * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  lockoutEl.innerHTML = `
    <div class="prodigy-lockout-modal" style="max-width: 620px !important; width: 90% !important; box-sizing: border-box !important; background: #2b2b2b !important; border: 1px solid #3d3d3d !important; border-radius: 8px !important; padding: 36px 40px !important; box-shadow: 0 20px 60px rgba(0,0,0,0.6) !important; color: #cfcfcf !important; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif !important; text-align: left !important;">
      <div id="prodigy-lockout-notice-view">
      <h2 style="margin: 0 0 18px !important; font-size: 30px !important; font-weight: 700 !important; color: #f5f5f5 !important; letter-spacing: 0.2px !important;">${lockoutTitle}</h2>

      <p style="margin: 0 0 16px !important; font-size: 14px !important; line-height: 1.6 !important; color: #bcbcbc !important;">${lockoutDescription}</p>

      <p style="margin: 0 0 8px !important; font-size: 13px !important; color: #9a9a9a !important;"><strong style="color: #d6d6d6 !important;">Reviewed:</strong> ${reviewedStr}</p>

      <p style="margin: 0 0 18px !important; font-size: 13px !important; line-height: 1.6 !important; color: #9a9a9a !important;"><strong style="color: #d6d6d6 !important;">Proctor Note:</strong> Prodigy Shield does not permit leaving the secured exam environment beyond the number of exits allowed for this assessment.</p>

      <div style="border: 1px solid #474747 !important; border-radius: 6px !important; padding: 16px 18px !important; margin: 0 0 20px !important; background: #242424 !important;">
        <p style="margin: 0 0 8px !important; font-size: 13px !important; color: #bcbcbc !important;"><strong style="color: #f5f5f5 !important;">Reason:</strong> ${lockoutReason}</p>
        <p style="margin: 0 !important; font-size: 13px !important; color: #bcbcbc !important;"><strong style="color: #f5f5f5 !important;">${lockoutStatLabel}:</strong> ${lockoutStatValue}</p>
      </div>

      <p style="margin: 0 0 12px !important; font-size: 13px !important; line-height: 1.6 !important; color: #9a9a9a !important;">Please abide by the exam rules so Prodigy Shield can keep this assessment fair for everyone.</p>

      <p style="margin: 0 0 22px !important; font-size: 13px !important; line-height: 1.6 !important; color: #9a9a9a !important;">Your exam session has been locked. It will re-activate automatically at <strong style="color: #d6d6d6 !important;">${reactivateStr}</strong>.</p>

        <div style="border-top: 1px solid #3d3d3d !important; padding-top: 18px !important; margin: 0 !important;">
          <p style="margin: 0 0 12px !important; font-size: 13px !important; color: #9a9a9a !important;">Believe this lockout is a mistake? You can appeal to your administrator for review.</p>
          <button id="prodigy-lockout-appeal-open-btn" style="background: #3a3a3a !important; color: #f5f5f5 !important; border: 1px solid #565656 !important; padding: 9px 22px !important; font-size: 13px !important; border-radius: 4px !important; cursor: pointer !important; font-family: inherit !important;">Appeal this lockout</button>
        </div>
      </div>

      <div id="prodigy-lockout-appeal-view" style="display: none !important;">
        <h2 style="margin: 0 0 8px !important; font-size: 26px !important; font-weight: 700 !important; color: #f5f5f5 !important; letter-spacing: 0.2px !important;">Submit an Appeal</h2>
        <div id="prodigy-lockout-request-wrap" style="border-top: 1px solid #3d3d3d !important; padding-top: 18px !important; margin-top: 16px !important;">
          <p style="margin: 0 0 10px !important; font-size: 13px !important; line-height: 1.6 !important; color: #9a9a9a !important;">Explain what happened below. An administrator will review your reason and decide whether to unlock your exam.</p>
          <textarea id="prodigy-lockout-appeal-text" placeholder="Explain your reason here (e.g. my internet disconnected, the page reloaded by accident)..." style="width: 100% !important; box-sizing: border-box !important; min-height: 96px !important; resize: vertical !important; background: #242424 !important; color: #eaeaea !important; border: 1px solid #565656 !important; border-radius: 5px !important; padding: 10px 12px !important; font-size: 13px !important; font-family: inherit !important; line-height: 1.5 !important; outline: none !important;"></textarea>
          <div style="display: flex !important; align-items: center !important; gap: 12px !important; margin-top: 12px !important; flex-wrap: wrap !important;">
            <button id="prodigy-lockout-request-btn" style="background: #3a3a3a !important; color: #f5f5f5 !important; border: 1px solid #565656 !important; padding: 9px 22px !important; font-size: 13px !important; border-radius: 4px !important; cursor: pointer !important; font-family: inherit !important;">Submit Appeal</button>
            <button id="prodigy-lockout-appeal-back-btn" style="background: transparent !important; color: #bcbcbc !important; border: 1px solid #454545 !important; padding: 9px 18px !important; font-size: 13px !important; border-radius: 4px !important; cursor: pointer !important; font-family: inherit !important;">Back</button>
            <span id="prodigy-lockout-appeal-status" style="font-size: 12px !important; color: #9a9a9a !important; line-height: 1.4 !important;"></span>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(lockoutEl);

  // Injected draggable clock widget when locked out
  const clockEl = document.createElement('div');
  clockEl.id = 'prodigy-lockout-clock-widget';
  clockEl.className = 'prodigy-lockout-clock-widget';
  clockEl.innerHTML = `
    <div class="prodigy-lockout-clock-handle">
      <div class="prodigy-clock-premium">
        <svg viewBox="0 0 100 100" class="prodigy-clock-svg">
          <circle cx="50" cy="50" r="46" class="prodigy-clock-dial-border" />
          <circle cx="50" cy="50" r="43" class="prodigy-clock-dial-face" />
          <line x1="50" y1="12" x2="50" y2="7" class="prodigy-clock-tick" />
          <line x1="50" y1="88" x2="50" y2="93" class="prodigy-clock-tick" />
          <line x1="12" y1="50" x2="17" y2="50" class="prodigy-clock-tick" />
          <line x1="88" y1="50" x2="93" y2="50" class="prodigy-clock-tick" />
          <line x1="31" y1="18" x2="33.5" y2="22.3" class="prodigy-clock-tick sub" />
          <line x1="69" y1="18" x2="66.5" y2="22.3" class="prodigy-clock-tick sub" />
          <line x1="31" y1="82" x2="33.5" y2="77.7" class="prodigy-clock-tick sub" />
          <line x1="69" y1="82" x2="66.5" y2="77.7" class="prodigy-clock-tick sub" />
          <line x1="50" y1="50" x2="50" y2="24" class="prodigy-clock-hand minute" />
          <line x1="50" y1="50" x2="50" y2="32" class="prodigy-clock-hand hour" />
          <line x1="50" y1="50" x2="50" y2="18" class="prodigy-clock-hand second" />
          <circle cx="50" cy="50" r="3.5" class="prodigy-clock-pin" />
          <circle cx="50" cy="50" r="1.5" class="prodigy-clock-pin-inner" />
        </svg>
      </div>
      <div style="margin-top: 6px !important; text-align: center !important;">
        <span id="prodigy-lockout-clock-time" style="display: inline-block !important; background: #000000 !important; color: #ff6b81 !important; font-size: 13px !important; font-weight: 700 !important; letter-spacing: 0.6px !important; font-variant-numeric: tabular-nums !important; padding: 3px 8px !important; border-radius: 6px !important; line-height: 1.1 !important;">${formatClockTimeParts(lockoutDuration).value}</span>
        <div id="prodigy-lockout-clock-unit" style="margin-top: 3px !important; font-size: 10px !important; font-weight: 600 !important; letter-spacing: 1px !important; text-transform: uppercase !important; color: #ff6b81 !important; text-align: center !important; background: none !important;">${formatClockTimeParts(lockoutDuration).unit}</div>
      </div>
    </div>
  `;
  ensureClockAnimationStyles();
  document.body.appendChild(clockEl);
  // Clock is intentionally NOT draggable.
  setupClockSeeThrough(clockEl);

  let currentTipIndex = 0;
  const tipContentEl = lockoutEl.querySelector('#prodigy-lockout-tip-content');
  const nextTipBtn = lockoutEl.querySelector('#prodigy-lockout-tip-next');
  const requestBtn = lockoutEl.querySelector('#prodigy-lockout-request-btn');

  function rotateTip() {
    currentTipIndex = (currentTipIndex + 1) % LOCKOUT_TIPS.length;
    if (tipContentEl) {
      tipContentEl.textContent = LOCKOUT_TIPS[currentTipIndex];
    }
  }

  let tipRotationInterval = setInterval(rotateTip, 5000);

  if (nextTipBtn) {
    nextTipBtn.addEventListener('click', () => {
      rotateTip();
      clearInterval(tipRotationInterval);
      tipRotationInterval = setInterval(rotateTip, 5000);
    });
  }

  if (requestBtn) {
    const appealText = lockoutEl.querySelector('#prodigy-lockout-appeal-text');
    const appealStatus = lockoutEl.querySelector('#prodigy-lockout-appeal-status');
    requestBtn.addEventListener('click', () => {
      const reasonText = appealText ? appealText.value.trim() : '';
      if (!reasonText) {
        if (appealStatus) {
          appealStatus.textContent = 'Please type a reason before submitting your appeal.';
          appealStatus.style.setProperty('color', '#ff6b81', 'important');
        }
        if (appealText) appealText.focus();
        return;
      }
      chrome.storage.local.get(['examSessionId'], (res) => {
        const sessionId = res.examSessionId || '';
        const currentUsername = getStudentName();
        safeFetch(`${origin}/api/unlock-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: currentUsername, sessionId, appealReason: reasonText, browserSuffix: getBrowserSuffixOnly() })
        })
          .then(() => {
            requestBtn.disabled = true;
            requestBtn.textContent = 'Appeal Submitted';
            requestBtn.style.setProperty('background', '#7f8c8d', 'important');
            requestBtn.style.setProperty('cursor', 'not-allowed', 'important');
            if (appealText) {
              appealText.disabled = true;
              appealText.style.setProperty('opacity', '0.6', 'important');
            }
            if (appealStatus) {
              appealStatus.textContent = 'Your appeal was sent to the administrator for review.';
              appealStatus.style.setProperty('color', '#7ed6a5', 'important');
            }
            showToastNotification('Appeal sent to administrator for review.');
          })
          .catch(err => console.error('Appeal post error:', err));
      });
    });
  }

  // Two-step modal: notice view <-> appeal view
  const noticeView = lockoutEl.querySelector('#prodigy-lockout-notice-view');
  const appealView = lockoutEl.querySelector('#prodigy-lockout-appeal-view');
  const appealOpenBtn = lockoutEl.querySelector('#prodigy-lockout-appeal-open-btn');
  const appealBackBtn = lockoutEl.querySelector('#prodigy-lockout-appeal-back-btn');
  const appealTextEl = lockoutEl.querySelector('#prodigy-lockout-appeal-text');
  if (appealOpenBtn) {
    appealOpenBtn.addEventListener('click', () => {
      if (noticeView) noticeView.style.setProperty('display', 'none', 'important');
      if (appealView) appealView.style.setProperty('display', 'block', 'important');
      if (appealTextEl) appealTextEl.focus();
    });
  }
  if (appealBackBtn) {
    appealBackBtn.addEventListener('click', () => {
      if (appealView) appealView.style.setProperty('display', 'none', 'important');
      if (noticeView) noticeView.style.setProperty('display', 'block', 'important');
    });
  }

  let remaining = lockoutDuration;

  const countdown = setInterval(() => {
    remaining--;

    const clockTimeEl = document.getElementById('prodigy-lockout-clock-time');
    const clockUnitEl = document.getElementById('prodigy-lockout-clock-unit');
    if (clockTimeEl || clockUnitEl) {
      const clockParts = formatClockTimeParts(remaining);
      if (clockTimeEl) clockTimeEl.textContent = clockParts.value;
      if (clockUnitEl) clockUnitEl.textContent = clockParts.unit;
    }

    if (remaining <= 0) {
      clearInterval(countdown);
      if (clockEl) safeRemoveElement(clockEl);
      // Countdown finished: return to notice view and drop the appeal UI
      const noticeViewEnd = lockoutEl.querySelector('#prodigy-lockout-notice-view');
      if (noticeViewEnd) noticeViewEnd.style.setProperty('display', 'block', 'important');
      const appealViewEnd = lockoutEl.querySelector('#prodigy-lockout-appeal-view');
      if (appealViewEnd) appealViewEnd.remove();
      const appealOpenBtnEnd = lockoutEl.querySelector('#prodigy-lockout-appeal-open-btn');
      if (appealOpenBtnEnd && appealOpenBtnEnd.parentElement) appealOpenBtnEnd.parentElement.remove();

      const resumeHost = lockoutEl.querySelector('.prodigy-lockout-modal') || lockoutEl;
      const resumeWrap = document.createElement('div');
      resumeWrap.style.textAlign = 'center';
      resumeWrap.innerHTML = `
        <button id="prodigy-lockout-resume-btn" class="prodigy-btn" style="background: #0e639c !important; width: auto !important; padding: 10px 24px !important; margin: 10px auto !important; font-size: 13px !important; border-radius: 4px !important;">
          Resume Exam
        </button>
      `;
      resumeHost.appendChild(resumeWrap);

      {
        const resumeBtn = resumeWrap.querySelector('#prodigy-lockout-resume-btn');
        if (resumeBtn) {
          resumeBtn.addEventListener('click', () => {
            clearLockoutPoll();
            chrome.storage.local.set({ lockoutExpiry: 0 });
            syncSessionStatus('Active Exam');
            clearInterval(tipRotationInterval);

            const activeClock = document.getElementById('prodigy-lockout-clock-widget');
            if (activeClock) safeRemoveElement(activeClock);

            safeRemoveElement(lockoutEl);
            syncSessionStatus('Active Exam');

            // Only enter fullscreen if we are actually still on the exam question page.
            // If they are on the landing or home page, terminate the exam mode completely.
            if (isQuestionDivPresent()) {
              requestFullscreen();
              updateShieldHealth('Secure');
            } else {
              stopExamLocal();
              safeSendMessage({ type: 'SUBMIT_EXAM' });
            }
          });
        }
      }
    }
  }, 1000);

  // Poll server to check if admin reactivated the user.
  // IMPORTANT: only release EARLY when the server has first confirmed this
  // lockout as active and then reports it cleared (a genuine admin unlock).
  // If the server never registered the lock (POST failed, DB error, or the row
  // isn't active yet), a bare isBlocked:false must NOT free the student — the
  // local countdown stays the source of truth. This is what previously lifted
  // DevTools-triggered lockouts after ~1 second without any admin action.
  let serverConfirmedLock = false;
  lockoutPollInterval = setInterval(() => {
    const currentUsername = getStudentName();
    const suffix = getBrowserSuffixOnly();
    safeFetch(`${origin}/api/check-lockout?username=${encodeURIComponent(currentUsername)}&browserSuffix=${encodeURIComponent(suffix)}`)
      .then(data => {
        if (data && data.isBlocked) {
          serverConfirmedLock = true;
          return;
        }

        // Server reports not blocked. Only honor this as an early release if the
        // server had previously confirmed the lock (i.e. admin reactivated it).
        // Otherwise the local countdown governs the lockout duration.
        if (!serverConfirmedLock) {
          return;
        }

        {
          clearInterval(lockoutPollInterval);
          clearInterval(countdown);
          clearInterval(tipRotationInterval);

          chrome.storage.local.set({ lockoutExpiry: 0 });
          syncSessionStatus('Active Exam');

          const activeClock = document.getElementById('prodigy-lockout-clock-widget');
          if (activeClock) safeRemoveElement(activeClock);

          if (lockoutEl && document.body.contains(lockoutEl)) {
            safeRemoveElement(lockoutEl);
          }

          if (isQuestionDivPresent()) {
            requestFullscreen();
            updateShieldHealth('Secure');
          } else {
            stopExamLocal();
            safeSendMessage({ type: 'SUBMIT_EXAM' });
          }
        }
      })
      .catch(err => console.error('Lockout status check poll error:', err));
  }, 2000);
}

function showMaximizeWarningModal() {
  if (!overlayElement) {
    overlayElement = document.createElement('div');
    overlayElement.id = 'prodigy-anti-cheat-overlay';
    overlayElement.className = 'prodigy-overlay';
    document.body.appendChild(overlayElement);
  }

  overlayElement.innerHTML = `
    <div class="prodigy-modal" style="border-color: #d97706 !important;">
      <div class="prodigy-warning-icon" style="color: #d97706 !important;">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v16.5h16.5V3.75H3.75zm1.5 1.5h13.5v13.5H5.25V5.25z" />
        </svg>
      </div>
      <h2 class="prodigy-modal-title" style="color: #d97706 !important;">Maximize Window Required</h2>
      <p class="prodigy-modal-description">For exam security, please run your browser in full-size mode before starting.</p>
      
      <p class="prodigy-warning-subtext">
        Please maximize this window, close any side panels, and click "Start Diagnostic Exam" again to proceed.
      </p>

      <button id="prodigy-dismiss-warning-btn" class="prodigy-btn" style="background: #d97706 !important;">
        I Understand
      </button>
    </div>
  `;

  overlayElement.classList.remove('prodigy-hidden');

  const dismissBtn = overlayElement.querySelector('#prodigy-dismiss-warning-btn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      safeHideElement(overlayElement);
    });
  }
}

function showNavigationBlockedWarning() {
  if (!overlayElement) {
    overlayElement = document.createElement('div');
    overlayElement.id = 'prodigy-anti-cheat-overlay';
    overlayElement.className = 'prodigy-overlay';
    document.body.appendChild(overlayElement);
  }

  overlayElement.innerHTML = `
    <div class="prodigy-modal">
      <div class="prodigy-warning-icon">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
      </div>
      <h2 class="prodigy-modal-title">Navigation Locked</h2>
      <p class="prodigy-modal-description">Side links and menus are locked during the active exam session.</p>
      
      <p class="prodigy-warning-subtext">
        If you need to leave the exam, please use the official "Exit" or "Submit" buttons inside the test workspace.
      </p>

      <button id="prodigy-dismiss-nav-warning-btn" class="prodigy-btn">
        Return to Exam
      </button>
    </div>
  `;

  overlayElement.classList.remove('prodigy-hidden');

  const dismissBtn = overlayElement.querySelector('#prodigy-dismiss-nav-warning-btn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      requestFullscreen();
      safeHideElement(overlayElement);
    });
  }
}

function showCloseDevToolsWarningModal() {
  if (!overlayElement) {
    overlayElement = document.createElement('div');
    overlayElement.id = 'prodigy-anti-cheat-overlay';
    overlayElement.className = 'prodigy-overlay';
    document.body.appendChild(overlayElement);
  }

  overlayElement.innerHTML = `
    <div class="prodigy-modal" style="border-color: #ef4444 !important;">
      <div class="prodigy-warning-icon" style="color: #ef4444 !important;">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </div>
      <h2 class="prodigy-modal-title" style="color: #ef4444;">Developer Tools Detected</h2>
      <p class="prodigy-modal-description">Developer tools or docked panels are currently open.</p>
      
      <p class="prodigy-warning-subtext">
        Please close any docked inspector windows or side panels (such as bookmarks, reading lists, or assistants) to proceed.
      </p>

      <button id="prodigy-dismiss-devtools-warning-btn" class="prodigy-btn" style="background: #ef4444 !important;">
        Got It
      </button>
    </div>
  `;

  overlayElement.classList.remove('prodigy-hidden');

  const dismissBtn = overlayElement.querySelector('#prodigy-dismiss-devtools-warning-btn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      safeHideElement(overlayElement);
    });
  }
}

function showFullscreenRequiredModal() {
  // If we're actually in fullscreen, never show the prompt (guards against races
  // where an enforcement tick fires while fullscreen is still engaging).
  if (document.fullscreenElement) {
    hideFullscreenRequiredModal();
    return;
  }

  if (isSessionPaused()) {
    hideFullscreenRequiredModal();
    return;
  }

  let overlay = document.getElementById('prodigy-fullscreen-required-overlay');

  // If the prompt is already on screen, leave it as-is. Rebuilding its innerHTML
  // on every enforcement tick / mutation / fullscreenchange is what made it
  // "keep popping" (flicker + focus steal). Only build it once per appearance.
  if (overlay && !overlay.classList.contains('prodigy-hidden')) {
    return;
  }

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'prodigy-fullscreen-required-overlay';
    overlay.className = 'prodigy-overlay';
    document.body.appendChild(overlay);
  }

  const isEnabled = document.fullscreenEnabled;
  const description = isEnabled
    ? "To ensure a secure exam environment, this test must be taken in fullscreen mode."
    : "Fullscreen mode is blocked by your browser settings. Please click the site settings icon in the browser address bar (lock/tune icon next to the URL) and enable 'Fullscreen' permission for this site.";

  const subtext = isEnabled
    ? "Please click the button below to re-enter fullscreen and continue your exam."
    : "Once allowed, refresh this page to resume your exam.";

  const btnStyle = isEnabled
    ? "background: #3b82f6 !important;"
    : "background: #858585 !important; cursor: not-allowed !important; pointer-events: none !important;";

  overlay.innerHTML = `
    <div class="prodigy-modal" style="border-color: #3b82f6 !important;">
      <div class="prodigy-warning-icon" style="color: #3b82f6 !important;">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v16.5h16.5V3.75H3.75zm1.5 1.5h13.5v13.5H5.25V5.25z" />
        </svg>
      </div>
      <h2 class="prodigy-modal-title" style="color: #3b82f6 !important;">Fullscreen Required</h2>
      <p class="prodigy-modal-description">${description}</p>
      
      <p class="prodigy-warning-subtext">
        ${subtext}
      </p>

      <button id="prodigy-enter-fullscreen-btn" class="prodigy-btn" style="${btnStyle}">
        ${isEnabled ? 'Enter Fullscreen' : 'Fullscreen Blocked'}
      </button>
    </div>
  `;

  overlay.classList.remove('prodigy-hidden');

  if (isEnabled) {
    const btn = overlay.querySelector('#prodigy-enter-fullscreen-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        requestFullscreen();
      });
    }
  }
}

function hideFullscreenRequiredModal() {
  const overlay = document.getElementById('prodigy-fullscreen-required-overlay');
  if (overlay) {
    safeHideElement(overlay);
  }
}

function showRefreshDetectedPrompt() {
  if (document.getElementById('prodigy-refresh-prompt')) return;

  const el = document.createElement('div');
  el.id = 'prodigy-refresh-prompt';
  el.className = 'prodigy-overlay';
  el.innerHTML = `
    <div class="prodigy-modal" style="border-color: #f59e0b !important;">
      <div class="prodigy-warning-icon" style="color: #f59e0b !important;">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
        </svg>
      </div>
      <h2 class="prodigy-modal-title" style="color: #f59e0b !important;">Page Refreshed During Exam</h2>
      <p class="prodigy-modal-description">
        A page refresh was detected while your exam session was active. Your exam session has been <strong>ended</strong> and this incident has been flagged.
      </p>
      <p class="prodigy-warning-subtext">
        Refreshing the page is not allowed during an active exam. Please contact your proctor if this was accidental.
      </p>
      <button id="prodigy-refresh-prompt-dismiss" class="prodigy-btn" style="background: #f59e0b !important;">
        I Understand
      </button>
    </div>
  `;
  document.body.appendChild(el);

  const btn = el.querySelector('#prodigy-refresh-prompt-dismiss');
  if (btn) {
    btn.addEventListener('click', () => el.remove());
  }
}

function showToastNotification(message) {
  let toastEl = document.getElementById('prodigy-toast-notification');
  if (toastEl) toastEl.remove();

  toastEl = document.createElement('div');
  toastEl.id = 'prodigy-toast-notification';
  toastEl.className = 'prodigy-toast';
  toastEl.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:16px; height:16px; color:#f59e0b;">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
    <span>${message}</span>
  `;
  document.body.appendChild(toastEl);

  setTimeout(() => {
    if (toastEl && document.body.contains(toastEl)) {
      toastEl.classList.add('prodigy-toast-fade-out');
      setTimeout(() => {
        if (toastEl && document.body.contains(toastEl)) {
          toastEl.remove();
        }
      }, 100);
    }
  }, 1000);
}

function runPreflightChecks(callback) {
  chrome.storage.local.get([
    'requireFullscreen',
    'blockDevTools',
    'blockTabSwitch',
    'noRestrictions',
    'copyPasteAction'
  ], (res) => {
    const requireFullscreen = res.requireFullscreen !== false;
    const blockDevTools = res.blockDevTools !== false;
    const blockTabSwitch = res.blockTabSwitch !== false;
    const noRestrictions = !!res.noRestrictions;

    const checks = [
      { id: 'fullscreen', label: 'Fullscreen Available', passed: false, advice: 'Fullscreen is blocked by your browser settings. Please enable it in site settings.' },
      { id: 'maximized', label: 'Browser Window Maximized', passed: false, advice: 'Please maximize your browser window or close side panels.' },
      { id: 'devtools', label: 'DevTools / Side Panel Closed', passed: false, advice: 'Please close Developer Tools or Side Panel.' },
      { id: 'background', label: 'Extension Background Worker Responding', passed: false, advice: 'Extension connection lost. Please reload the extension.' },
      { id: 'config', label: 'Remote Config Synced', passed: false, advice: 'Failed to retrieve remote proctor config.' },
      { id: 'tab', label: 'Exam Tab Recognized', passed: false, advice: 'Background worker could not trace active tab.' },
      { id: 'question', label: 'Question Area Detected', passed: false, advice: 'Not on a valid exam landing page.' },
      { id: 'lockout', label: 'No Active Lockout', passed: false, advice: 'You are currently locked out of this session.' },
      { id: 'clipboard', label: 'Clipboard Policy Loaded', passed: false, advice: 'Proctor copy/paste policy not loaded.' },
      { id: 'navlock', label: 'Navigation Lock Ready', passed: false, advice: 'Listeners not ready.' }
    ];

    let completedCount = 0;
    function checkDone() {
      completedCount++;
      if (completedCount === checks.length) {
        callback(checks);
      }
    }

    // 1. Fullscreen Available (bypass if requireFullscreen is false or noRestrictions is true)
    checks[0].passed = (!requireFullscreen || noRestrictions) ? true : document.fullscreenEnabled;
    checkDone();

    // 4, 5, 6, 2, 1. Background, Config, Tab, DevTools, and Maximize Checks via Ping message
    safeSendMessage({ type: 'PING' }, (response) => {
      const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

      if (response && response.success) {
        checks[3].passed = true; // Connection alive
        checks[4].passed = !!response.config; // Config loaded
        checks[5].passed = response.tabId !== undefined; // Tab recognized

        // Check if maximized
        if (!blockTabSwitch || noRestrictions) {
          checks[1].passed = true;
        } else if (isMobile && !response.windowWidth) {
          checks[1].passed = true;
        } else if (response.isWindowMaximized !== undefined) {
          checks[1].passed = response.isWindowMaximized;
        } else {
          const isSnapped =
            window.outerWidth < (window.screen.availWidth * 0.85) ||
            window.outerHeight < (window.screen.availHeight * 0.85);
          checks[1].passed = !isSnapped;
        }

        // DevTools detection: measure ONLY window.outer* vs window.inner* (both CSS
        // pixels) so OS display scaling and page zoom can't create a false positive.
        // Width gap = side dock / side panel (no browser chrome on this axis).
        // Height gap includes the whole browser chrome, so use a chrome-aware
        // threshold that only trips on a real bottom-docked panel.
        if (!blockDevTools || noRestrictions) {
          checks[2].passed = true;
        } else {
          const widthGap = window.outerWidth - window.innerWidth;
          const heightGap = window.outerHeight - window.innerHeight;
          const isDevToolsOpen = widthGap > 160 || heightGap > 220 || detectDevToolsSizeIndependent();
          checks[2].passed = !isDevToolsOpen;
        }
      } else {
        checks[3].passed = false;
        checks[4].passed = false;
        checks[5].passed = false;

        if (!blockTabSwitch || noRestrictions) {
          checks[1].passed = true;
        } else {
          const isSnapped = !isMobile && (
            window.outerWidth < (window.screen.availWidth * 0.85) ||
            window.outerHeight < (window.screen.availHeight * 0.85)
          );
          checks[1].passed = !isSnapped;
        }

        if (!blockDevTools || noRestrictions) {
          checks[2].passed = true;
        } else {
          const widthGap = window.outerWidth - window.innerWidth;
          const heightGap = window.outerHeight - window.innerHeight;
          const isDevToolsOpen = widthGap > 160 || heightGap > 220 || detectDevToolsSizeIndependent();
          checks[2].passed = !isDevToolsOpen;
        }
      }

      checkDone(); // check 1 (Window Maximized)
      checkDone(); // check 2 (DevTools / Side Panel Closed)
      checkDone(); // check 3 (Background worker)
      checkDone(); // check 4 (Config synced)
      checkDone(); // check 5 (Exam tab recognized)
    });

    // 7. Question Area Detected
    checks[6].passed = noRestrictions ? true : (!!document.getElementById('start-btn') || document.body.innerText.includes('Diagnostic Exam'));
    checkDone();

    // 8. No Active Lockout
    const now = Date.now();
    checks[7].passed = noRestrictions ? true : !(localLockoutExpiry && now < localLockoutExpiry);
    checkDone();

    // 9. Clipboard Policy Loaded
    checks[8].passed = noRestrictions ? true : !!res.copyPasteAction;
    checkDone();

    // 10. Navigation Lock Ready
    checks[9].passed = true;
    checkDone();
  });
}

function showPreflightCheckModal(onSuccess) {
  let overlay = document.getElementById('prodigy-preflight-overlay');
  if (overlay) return;

  let preflightPollInterval = null;
  // SECURITY: authoritative pass/fail state kept in a closure the page cannot
  // reach. The Start button's `disabled` attribute and styling live in the DOM
  // and can be stripped from the console; this variable cannot be, so the click
  // handler trusts THIS flag, never the DOM state.
  let lastChecksPassed = false;

  overlay = document.createElement('div');
  overlay.id = 'prodigy-preflight-overlay';
  overlay.className = 'prodigy-overlay';

  overlay.innerHTML = `
    <div class="prodigy-preflight-modal">
      <h2 class="prodigy-preflight-title">Security Preflight Check</h2>
      <p class="prodigy-preflight-desc">
        Prodigy Shield is verifying your device environment to ensure a secure exam environment.
      </p>
      
      <div class="prodigy-preflight-list" id="prodigy-preflight-list-container">
        <!-- Check items will be dynamically generated here -->
      </div>
      
      <div class="prodigy-preflight-actions">
        <button id="prodigy-preflight-retry-btn" class="prodigy-btn" style="background: #2d2d2d !important; border: 1px solid #3c3c3c !important; color: #ffffff !important; width: auto !important; padding: 8px 18px !important;">
          Re-run Checks
        </button>
        <button id="prodigy-preflight-start-btn" class="prodigy-btn" style="background: #555555 !important; color: #aaaaaa !important; cursor: not-allowed !important; pointer-events: none !important; width: auto !important; padding: 8px 18px !important;" disabled>
          Enter Secure Exam Mode
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const retryBtn = overlay.querySelector('#prodigy-preflight-retry-btn');
  const startBtn = overlay.querySelector('#prodigy-preflight-start-btn');

  function executeChecks() {
    if (preflightPollInterval) {
      clearInterval(preflightPollInterval);
      preflightPollInterval = null;
    }

    const container = document.getElementById('prodigy-preflight-list-container');
    if (!container) return;

    lastChecksPassed = false;
    retryBtn.disabled = true;
    retryBtn.style.opacity = '0.5';
    startBtn.disabled = true;
    startBtn.style.background = '#555555 !important';
    startBtn.style.color = '#aaaaaa !important';
    startBtn.style.cursor = 'not-allowed !important';
    startBtn.style.pointerEvents = 'none !important';

    container.innerHTML = `
      <div style="text-align: center; padding: 20px 0; color: #858585;">
        Checking proctor parameters...
      </div>
    `;

    setTimeout(() => {
      runPreflightChecks((results) => {
        container.innerHTML = '';
        let allPassed = true;

        results.forEach((check) => {
          if (!check.passed) allPassed = false;

          const itemEl = document.createElement('div');
          itemEl.className = `prodigy-preflight-item ${check.passed ? 'passed' : 'failed'}`;

          let adviceHtml = '';
          if (!check.passed) {
            if (check.id === 'lockout') {
              adviceHtml = `
                <div class="prodigy-preflight-advice" style="display: flex; flex-direction: column; gap: 8px;">
                  <span>${check.advice}</span>
                  <button id="prodigy-preflight-request-btn" class="prodigy-btn" style="background: #e59866 !important; width: auto !important; padding: 6px 12px !important; font-size: 11px !important; border-radius: 4px !important; cursor: pointer !important; align-self: flex-start !important; margin-top: 4px;">
                    Request Administrator Unlock
                  </button>
                </div>
              `;
            } else {
              adviceHtml = `<div class="prodigy-preflight-advice">${check.advice}</div>`;
            }
          }

          itemEl.innerHTML = `
            <div class="prodigy-preflight-row">
              <span class="prodigy-preflight-label">${check.label}</span>
              <span class="prodigy-preflight-status ${check.passed ? 'passed' : 'failed'}">
                ${check.passed ? '&#10004; Ready' : '&#10008; Action Required'}
              </span>
            </div>
            ${adviceHtml}
          `;
          container.appendChild(itemEl);
        });

        // Attach event listener for the unlock request button if present
        const preflightRequestBtn = container.querySelector('#prodigy-preflight-request-btn');
        if (preflightRequestBtn) {
          preflightRequestBtn.addEventListener('click', () => {
            const origin = window.location.origin.includes('localhost') ? window.location.origin : 'http://localhost:8000';
            const username = getStudentName();

            chrome.storage.local.get(['examSessionId'], (res) => {
              const sessionId = res.examSessionId || '';
              safeFetch(`${origin}/api/unlock-request`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, sessionId, browserSuffix: getBrowserSuffixOnly() })
              })
                .then(() => {
                  preflightRequestBtn.disabled = true;
                  preflightRequestBtn.textContent = 'Unlock Requested';
                  preflightRequestBtn.style.setProperty('background', '#7f8c8d', 'important');
                  preflightRequestBtn.style.setProperty('cursor', 'not-allowed', 'important');
                  showToastNotification('Unlock request sent to administrator.');
                })
                .catch(err => console.error('Unlock request post error:', err));
            });
          });
        }

        retryBtn.disabled = false;
        retryBtn.style.opacity = '1';

        if (allPassed) {
          lastChecksPassed = true;
          startBtn.disabled = false;
          startBtn.style.setProperty('background', '#22c55e', 'important');
          startBtn.style.setProperty('color', '#ffffff', 'important');
          startBtn.style.setProperty('cursor', 'pointer', 'important');
          startBtn.style.setProperty('pointer-events', 'auto', 'important');
        } else {
          lastChecksPassed = false;
          // If lockout failed, poll to automatically re-run checks once admin unlocks
          if (!results[7].passed) {
            const origin = window.location.origin.includes('localhost') ? window.location.origin : 'http://localhost:8000';
            const username = getStudentName();
            preflightPollInterval = setInterval(() => {
              const suffix = getBrowserSuffixOnly();
              safeFetch(`${origin}/api/check-lockout?username=${encodeURIComponent(username)}&browserSuffix=${encodeURIComponent(suffix)}`)
                .then(data => {
                  if (!data.isBlocked) {
                    clearInterval(preflightPollInterval);
                    preflightPollInterval = null;
                    executeChecks();
                  }
                })
                .catch(err => console.error(err));
            }, 2000);
          }
        }
      });
    }, 400);
  }

  retryBtn.addEventListener('click', executeChecks);
  startBtn.addEventListener('click', () => {
    // SECURITY: never trust the DOM here. A student can run, from the console:
    //   const b = document.getElementById('prodigy-preflight-start-btn');
    //   b.removeAttribute('disabled'); b.click();
    // to fire this handler even while checks are failing. Guard on the closure
    // flag (unreachable from the page) AND re-validate synchronously before
    // entering exam mode.
    if (!lastChecksPassed) {
      showToastNotification('Security checks not passed. Close DevTools / side panels, then re-run checks.');
      executeChecks();
      return;
    }
    runPreflightChecks((results) => {
      const stillAllPassed = results.every((c) => c.passed);
      if (!stillAllPassed) {
        lastChecksPassed = false;
        showToastNotification('Security violation detected \u2014 cannot enter exam mode.');
        executeChecks();
        return;
      }
      if (preflightPollInterval) {
        clearInterval(preflightPollInterval);
        preflightPollInterval = null;
      }
      overlay.remove();
      onSuccess();
    });
  });

  executeChecks();
}

// --------------------------------------------------------------------------
// 7. INITIALIZATION & LISTENERS
// --------------------------------------------------------------------------
const isPageReload = (performance.getEntriesByType('navigation')[0]?.type === 'reload');

try {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'VIOLATION_TRIGGERED' || message.type === 'LOCKOUT_TRIGGERED') {
      if (!localExamActive) return;
    }

    if (message.type === 'VIOLATION_TRIGGERED') {
      showViolationOverlay(message.violations, message.reason);
    } else if (message.type === 'LOCKOUT_TRIGGERED') {
      showLockoutOverlay(message.violations, message.duration);
    } else if (message.type === 'HIDE_INDICATORS') {
      forceHideAllIndicators();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.examModeActive) {
        if (changes.examModeActive.newValue === false) {
          forceHideAllIndicators();
        } else if (changes.examModeActive.newValue === true) {
          chrome.storage.local.get(['chatbotDuringExam'], (res) => {
            if (!res.chatbotDuringExam) {
              if (chatLauncher) chatLauncher.classList.add('prodigy-hidden-force');
              if (chatWidget) chatWidget.classList.add('prodigy-hidden-force');
            }
          });
        }
      }
      if (changes.copyPasteAction) {
        localCopyPasteAction = changes.copyPasteAction.newValue || 'flag';
      }
      if (changes.noRestrictions) {
        localNoRestrictions = !!changes.noRestrictions.newValue;
      }
      if (changes.requireFullscreen) {
        localRequireFullscreen = changes.requireFullscreen.newValue !== false;
      }
      if (changes.blockDevTools) {
        localBlockDevTools = changes.blockDevTools.newValue !== false;
      }
      if (changes.blockTabSwitch) {
        localBlockTabSwitch = changes.blockTabSwitch.newValue !== false;
      }
      if (changes.blockRightClick) {
        localBlockRightClick = changes.blockRightClick.newValue !== false;
      }
      if (changes.limitExits) {
        localLimitExits = changes.limitExits.newValue === true;
      }
      if (changes.maxExits) {
        localMaxExits = (typeof changes.maxExits.newValue === 'number' && changes.maxExits.newValue > 0) ? changes.maxExits.newValue : 3;
      }
      if (changes.lockoutExpiry) {
        localLockoutExpiry = changes.lockoutExpiry.newValue || 0;
      }
      if (changes.violations) {
        localViolations = changes.violations.newValue || 0;
      }
    }
  });

  window.addEventListener('beforeunload', () => {
    isUnloading = true;
  });
} catch (err) {
  console.warn('Prodigy Shield: could not attach listeners (context invalidated)', err);
}

let isPreflightPassed = false;
let isActionConfirmed = false;

document.addEventListener('click', (event) => {
  // Completely disable any proctor click interception on the admin console
  if (window.location.pathname.includes('/admin') || window.location.pathname.includes('admin.html')) return;

  const target = event.target;
  if (!target) return;

  if (target.closest('[id^="prodigy-"]')) return;

  const button = target.closest('button');
  if (!button) return;

  const rawText = button.textContent ? button.textContent.trim().toLowerCase() : '';
  const text = rawText.replace(/\s+/g, ' ');

  const isSubmitBtn = text.includes('submit exam') || text === 'submit';
  const isExitBtn = text === 'exit' || text.includes('exit exam');

  // If the action was already confirmed, allow the programmatic click to pass
  // through to the website's own handler so the exam actually closes/submits.
  if (isActionConfirmed && (isSubmitBtn || isExitBtn)) {
    return;
  }

  if (isSubmitBtn || isExitBtn) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    promptEndExam(isSubmitBtn ? 'submit' : 'exit', button);
    return;
  }

  if (text.includes('start diagnostic exam')) {
    if (isPreflightPassed) {
      return; // Allow the programmatically triggered click to propagate to the website
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    showPreflightCheckModal(() => {
      isPreflightPassed = true;
      requestFullscreen();
      safeSendMessage({ type: 'START_EXAM' }, (response) => {
        if (response && response.success) {
          startExamLocal(response.violations || 0);

          // Only reset the exit counter for a genuinely NEW attempt — NOT when
          // re-entering the exam after an exit. Re-entries must preserve the
          // running exit count, otherwise the limit never enforces (the count
          // would reset to 0 every time the student re-opens the exam).
          chrome.storage.local.get(['examAttemptActive'], (attemptRes) => {
            if (attemptRes.examAttemptActive !== true) {
              chrome.storage.local.set({ examExitCount: 0, examAttemptActive: true });
            } else {
              chrome.storage.local.set({ examAttemptActive: true });
            }
          });

          // Re-trigger the click event so that the website's own listener handles it
          button.click();

          // Reset the flag after a short delay for future sessions
          setTimeout(() => {
            isPreflightPassed = false;
          }, 1000);
        }
      });
    });
  }

}, true);

// --------------------------------------------------------------------------
// 8. FLOATING AI CHATBOT & SELECTION HELPER
// --------------------------------------------------------------------------
let chatLauncher = null;
let chatWidget = null;
let selectionTooltip = null;

function initChatbot(isExamActive = false) {
  if (document.getElementById('prodigy-chat-launcher')) return;

  // 1. Create floating launcher button
  chatLauncher = document.createElement('div');
  chatLauncher.id = 'prodigy-chat-launcher';
  chatLauncher.className = 'prodigy-chat-launcher';
  chatLauncher.innerHTML = `
    <div class="prodigy-chat-launcher-logo-wrap">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="prodigy-chat-launcher-logo-svg">
        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" fill="#3b82f6" />
        <text x="12" y="15" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" font-weight="900" font-size="9" text-anchor="middle" dominant-baseline="middle">P</text>
      </svg>
    </div>
  `;
  document.body.appendChild(chatLauncher);

  // 2. Create chat widget panel
  chatWidget = document.createElement('div');
  chatWidget.id = 'prodigy-chat-widget';
  chatWidget.className = 'prodigy-chat-widget prodigy-hidden';

  chrome.storage.local.get(['chatbotDuringExam'], (res) => {
    if ((isExamActive || localExamActive) && !res.chatbotDuringExam) {
      chatLauncher.classList.add('prodigy-hidden-force');
      chatWidget.classList.add('prodigy-hidden-force');
    }
  });
  chatWidget.innerHTML = `
    <div class="prodigy-chat-header" id="prodigy-chat-header">
      <div class="prodigy-chat-header-title">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" style="width:16px; height:16px;">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 21l8.982-11.795H14.19C15.828 4.28 9.813 3 9.813 3L10.5 8.136H3.5l6.313 7.768z" />
        </svg>
        <span>AI Tutor (English)</span>
      </div>
      <button class="prodigy-chat-close-btn" id="prodigy-chat-close-btn">&times;</button>
    </div>
    <div class="prodigy-chat-body" id="prodigy-chat-body">
      <div class="prodigy-chat-message ai">
        Ask me anything about this question! I'll guide you using the Socratic method.
      </div>
    </div>
    <div class="prodigy-chat-footer">
      <div class="prodigy-chat-input-wrapper">
        <input type="text" class="prodigy-chat-input" id="prodigy-chat-input" placeholder="Ask in English..." autocomplete="off">
      </div>
      <button class="prodigy-chat-send-btn" id="prodigy-chat-send-btn">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:16px; height:16px; transform: rotate(45deg); margin-left:-2px; margin-top:-2px;">
          <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
        </svg>
      </button>
    </div>
  `;
  document.body.appendChild(chatWidget);

  setupChatbotListeners();
}

function makeDraggable(element, handle) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  let hasDragged = false;
  let startX = 0, startY = 0;

  const dragHandle = handle || element;

  dragHandle.addEventListener('mousedown', dragMouseDown);
  dragHandle.addEventListener('touchstart', dragTouchStart, { passive: false });

  // Add click interceptor to suppress click if we dragged
  element.addEventListener('click', (e) => {
    if (hasDragged) {
      e.preventDefault();
      e.stopPropagation();
      hasDragged = false;
    }
  }, true);

  function dragMouseDown(e) {
    e = e || window.event;
    if (e.target.closest('.prodigy-chat-close-btn') || e.target.closest('button, input, textarea')) return;

    startX = e.clientX;
    startY = e.clientY;
    hasDragged = false;

    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;

    document.addEventListener('mouseup', closeDragElement);
    document.addEventListener('mousemove', elementDrag);
  }

  function dragTouchStart(e) {
    if (e.target.closest('.prodigy-chat-close-btn') || e.target.closest('button, input, textarea')) return;

    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    hasDragged = false;

    pos3 = e.touches[0].clientX;
    pos4 = e.touches[0].clientY;

    document.addEventListener('touchend', closeDragElement);
    document.addEventListener('touchmove', elementTouchDrag, { passive: false });
  }

  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();

    if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
      hasDragged = true;
    }

    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;

    const topPos = element.offsetTop - pos2;
    const leftPos = element.offsetLeft - pos1;

    const maxTop = window.innerHeight - element.offsetHeight;
    const maxLeft = window.innerWidth - element.offsetWidth;

    element.style.top = Math.max(10, Math.min(topPos, maxTop - 10)) + "px";
    element.style.left = Math.max(10, Math.min(leftPos, maxLeft - 10)) + "px";
    element.style.bottom = "auto";
    element.style.right = "auto";
  }

  function elementTouchDrag(e) {
    e.preventDefault();

    if (Math.abs(e.touches[0].clientX - startX) > 4 || Math.abs(e.touches[0].clientY - startY) > 4) {
      hasDragged = true;
    }

    pos1 = pos3 - e.touches[0].clientX;
    pos2 = pos4 - e.touches[0].clientY;
    pos3 = e.touches[0].clientX;
    pos4 = e.touches[0].clientY;

    const topPos = element.offsetTop - pos2;
    const leftPos = element.offsetLeft - pos1;

    const maxTop = window.innerHeight - element.offsetHeight;
    const maxLeft = window.innerWidth - element.offsetWidth;

    element.style.top = Math.max(10, Math.min(topPos, maxTop - 10)) + "px";
    element.style.left = Math.max(10, Math.min(leftPos, maxLeft - 10)) + "px";
    element.style.bottom = "auto";
    element.style.right = "auto";
  }

  function closeDragElement() {
    document.removeEventListener('mouseup', closeDragElement);
    document.removeEventListener('mousemove', elementDrag);
    document.removeEventListener('touchend', closeDragElement);
    document.removeEventListener('touchmove', elementTouchDrag);

    setTimeout(() => {
      hasDragged = false;
    }, 50);
  }
}

function handleTextSelection() {
  document.addEventListener('mouseup', (e) => {
    // Disable selection helper tooltips during the active exam session
    if (localExamActive) return;

    if (e.target.closest('#prodigy-chat-widget') || e.target.closest('.prodigy-selection-tooltip') || e.target.closest('[id^="prodigy-"]')) {
      return;
    }

    setTimeout(() => {
      const selection = window.getSelection();
      const selectedText = selection.toString().trim();

      if (!selectedText) {
        removeSelectionTooltip();
        return;
      }

      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        createSelectionTooltip(rect.right + window.scrollX, rect.top + window.scrollY - 36, selectedText);
      } catch (err) {
        // Range selection error -- ignore
      }
    }, 10);
  });

  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (selection.toString().trim() === '') {
      setTimeout(() => {
        const activeSel = window.getSelection().toString().trim();
        if (!activeSel) removeSelectionTooltip();
      }, 100);
    }
  });
}

function createSelectionTooltip(x, y, text) {
  removeSelectionTooltip();

  selectionTooltip = document.createElement('div');
  selectionTooltip.className = 'prodigy-selection-tooltip';
  selectionTooltip.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" style="width:12px; height:12px;">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 21l8.982-11.795H14.19C15.828 4.28 9.813 3 9.813 3L10.5 8.136H3.5l6.313 7.768z" />
    </svg>
    <span>Ask Prodigy AI</span>
  `;
  selectionTooltip.style.top = y + 'px';
  selectionTooltip.style.left = (x - 50) + 'px';
  document.body.appendChild(selectionTooltip);

  selectionTooltip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    chatWidget.classList.remove('prodigy-hidden');
    askAIQuery(text);

    window.getSelection().removeAllRanges();
    removeSelectionTooltip();
  });
}

function removeSelectionTooltip() {
  if (selectionTooltip) {
    selectionTooltip.remove();
    selectionTooltip = null;
  }
}

function appendChatMessage(sender, text) {
  const body = document.getElementById('prodigy-chat-body');
  if (!body) return;

  const msg = document.createElement('div');
  msg.className = `prodigy-chat-message ${sender}`;
  msg.textContent = text;
  body.appendChild(msg);

  body.scrollTop = body.scrollHeight;
}

function showTypingIndicator() {
  const body = document.getElementById('prodigy-chat-body');
  if (!body) return null;

  const indicator = document.createElement('div');
  indicator.className = 'prodigy-chat-message ai';
  indicator.id = 'prodigy-chat-typing';
  indicator.innerHTML = `
    <div class="prodigy-chat-typing-dots">
      <div class="prodigy-chat-typing-dot"></div>
      <div class="prodigy-chat-typing-dot"></div>
      <div class="prodigy-chat-typing-dot"></div>
    </div>
  `;
  body.appendChild(indicator);
  body.scrollTop = body.scrollHeight;
  return indicator;
}

function removeTypingIndicator() {
  const indicator = document.getElementById('prodigy-chat-typing');
  if (indicator) indicator.remove();
}

function askAIQuery(queryText) {
  appendChatMessage('user', queryText);
  showTypingIndicator();

  setTimeout(() => {
    removeTypingIndicator();

    let reply = "";
    const lower = queryText.toLowerCase();

    if (lower.includes('explain') || lower.length < 50) {
      reply = `To help you understand this concept, let's break it down. What does this term mean in the context of the question? Let's identify the core components first.`;
    } else {
      reply = `That is an interesting observation! Before I give you the direct answer, what do you think is the main idea behind this concept? How does it apply here?`;
    }

    appendChatMessage('ai', reply);
  }, 1000);
}

function handleUserMsgSend() {
  const input = document.getElementById('prodigy-chat-input');
  if (!input) return;

  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  askAIQuery(text);
}

function setupChatbotListeners() {
  const header = document.getElementById('prodigy-chat-header');
  makeDraggable(chatWidget, header);
  if (chatLauncher) {
    makeDraggable(chatLauncher, chatLauncher);
  }

  const closeBtn = document.getElementById('prodigy-chat-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      chatWidget.classList.add('prodigy-hidden');
    });
  }

  const sendBtn = document.getElementById('prodigy-chat-send-btn');
  if (sendBtn) {
    sendBtn.addEventListener('click', handleUserMsgSend);
  }

  const input = document.getElementById('prodigy-chat-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleUserMsgSend();
      }
    });
  }

  if (chatLauncher) {
    chatLauncher.addEventListener('click', () => {
      chatWidget.classList.toggle('prodigy-hidden');
      if (!chatWidget.classList.contains('prodigy-hidden')) {
        const input = document.getElementById('prodigy-chat-input');
        if (input) input.focus();
      }
    });
  }

  handleTextSelection();
}

try {
  if (window.location.pathname.includes('/admin') || window.location.pathname.includes('admin.html')) {
    console.log("Prodigy Shield: Admin panel page detected. Anti-cheat inactive.");
  } else {
    chrome.storage.local.get(['examModeActive', 'violations', 'lockoutExpiry', 'copyPasteAction'], (result) => {
      if (!chrome.runtime?.id) return;

      const username = getStudentName();

      // -----------------------------------------------------------------------
      // ANTI-TAMPER SHIELD: Cross-Browser Lockout Sync
      // -----------------------------------------------------------------------
      // Route the check through background.js so it benefits from:
      //   1. Canonical username matching (strips browser suffix) for cross-browser locks
      //   2. Browser-switch evasion detection with extended penalty
      //   3. Audit trail logging directly on the server
      // -----------------------------------------------------------------------
      safeSendMessage({ type: 'CHECK_SERVER_LOCKOUT', username }, (serverData) => {
        if (serverData && serverData.isBlocked && serverData.lockoutExpiry && serverData.lockoutExpiry > Date.now()) {
          localCopyPasteAction = result.copyPasteAction || 'flag';
          localLockoutExpiry = serverData.lockoutExpiry;
          localViolations = result.violations || 0;

          chrome.storage.local.set({
            examModeActive: true,
            lockoutExpiry: serverData.lockoutExpiry
          });

          initChatbot(true);
          startExamLocal(0);
          const remaining = Math.max(0, Math.ceil((serverData.lockoutExpiry - Date.now()) / 1000));

          if (serverData.browserSwitchDetected) {
            // Show a special browser-switch evasion lockout overlay
            showLockoutOverlay(result.violations || 0, remaining, {
              title: 'EVASION DETECTED',
              description: `Prodigy Shield detected that you switched browsers to bypass an active lockout. ` +
                `This action has been flagged as a high-severity integrity violation and logged. ` +
                `An extended lockout penalty has been applied.`,
              reason: 'Browser-switch evasion: attempted to bypass active lockout',
              statLabel: 'EVASION PENALTY',
              statValue: `${Math.ceil(remaining / 60)} min`
            });
          } else {
            // Standard restored lockout (refresh / new tab / same browser switch)
            showLockoutOverlay(result.violations || 0, remaining);
          }
          return;
        }

        // No server-side lock — fall back to local storage state
        runOriginalInit(result);
      });

      function runOriginalInit(res) {
        initChatbot(res.examModeActive);

        localCopyPasteAction = res.copyPasteAction || 'flag';
        localLockoutExpiry = res.lockoutExpiry || 0;
        localViolations = res.violations || 0;

        if (!res.examModeActive) return;

        const now = Date.now();
        const isLockedOut = res.lockoutExpiry && now < res.lockoutExpiry;

        if (isLockedOut) {
          // Enforce the lockout: do NOT allow bypassing via refresh/navigation!
          startExamLocal(0);
          const remaining = Math.ceil((res.lockoutExpiry - now) / 1000);
          showLockoutOverlay(res.violations || 0, remaining);
          return;
        }

        if (isPageReload) {
          safeSendMessage({ type: 'REPORT_VIOLATION', reason: 'Page refreshed during exam' });
          safeSendMessage({ type: 'SUBMIT_EXAM' });
          showRefreshDetectedPrompt();
          return;
        }

        // Always restore the exam session on load if active, and let the question monitor loop
        // bounds check and recover the layout or auto-submit if genuinely missing for >3s.
        restoreExamSession(res);
      }
    });
  }
} catch (err) {
  // Context invalidated -- ignore
}


// --------------------------------------------------------------------------
// CUSTOM CONFIRM / EXIT MODALS
// --------------------------------------------------------------------------
function showCustomConfirmModal(title, message, confirmText, confirmAction, cancelAction) {
  let overlay = document.getElementById('prodigy-confirm-overlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'prodigy-confirm-overlay';
  overlay.className = 'prodigy-overlay';
  overlay.style.zIndex = '99999999';

  overlay.innerHTML = `
    <div class="prodigy-modal" style="border-color: #3b82f6 !important; max-width: 450px !important;">
      <div class="prodigy-warning-icon" style="color: #3b82f6 !important;">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="48" height="48">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
        </svg>
      </div>
      <h2 class="prodigy-warning-title">${title}</h2>
      <p class="prodigy-warning-desc" style="color: #e2e8f0 !important; font-size: 15px !important; margin-bottom: 24px !important;">${message}</p>
      <div style="display: flex; gap: 12px; width: 100%;">
        <button id="prodigy-confirm-cancel-btn" class="prodigy-btn" style="background: #334155 !important; color: white !important; flex: 1;">Cancel</button>
        <button id="prodigy-confirm-ok-btn" class="prodigy-btn" style="background: #3b82f6 !important; color: white !important; flex: 1;">${confirmText}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const cancelBtn = document.getElementById('prodigy-confirm-cancel-btn');
  const okBtn = document.getElementById('prodigy-confirm-ok-btn');

  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    overlay.remove();
    if (cancelAction) cancelAction();
  });

  if (okBtn) okBtn.addEventListener('click', () => {
    overlay.remove();
    if (confirmAction) confirmAction();
  });
}

function showExamClosedModal() {
  let overlay = document.getElementById('prodigy-closed-overlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'prodigy-closed-overlay';
  overlay.className = 'prodigy-overlay';
  overlay.style.zIndex = '99999999';

  overlay.innerHTML = `
    <div class="prodigy-modal" style="border-color: #10b981 !important; max-width: 450px !important;">
      <div class="prodigy-warning-icon" style="color: #10b981 !important;">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="48" height="48">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
      </div>
      <h2 class="prodigy-warning-title">Exam Successfully Closed</h2>
      <p class="prodigy-warning-desc" style="color: #e2e8f0 !important; font-size: 14px !important; margin-bottom: 20px !important;">
        You have securely exited the exam environment. All Prodigy Shield monitoring and security restrictions have been deactivated.
        <br><br>
        You are now free to use your browser normally.
      </p>
      <button id="prodigy-closed-dismiss-btn" class="prodigy-btn" style="background: #10b981 !important; color: white !important;">Back to Dashboard</button>
    </div>
  `;

  document.body.appendChild(overlay);

  const dismissBtn = document.getElementById('prodigy-closed-dismiss-btn');
  if (dismissBtn) dismissBtn.addEventListener('click', () => {
    overlay.remove();
  });
}


// --------------------------------------------------------------------------
// EXAM EXIT / SUBMIT FLOW + EXIT LIMIT ENFORCEMENT
// --------------------------------------------------------------------------
function finalizeEndExam(triggerEl) {
  // Turn off exam security immediately, notify server, then trigger the
  // website's own exit/submit control so the exam actually closes.
  isActionConfirmed = true;
  stopExamLocal();
  safeSendMessage({ type: 'SUBMIT_EXAM' });

  setTimeout(() => {
    if (triggerEl) triggerEl.click();
    setTimeout(() => {
      showExamClosedModal();
      isActionConfirmed = false;
    }, 200);
  }, 50);
}

function promptEndExam(kind, triggerEl) {
  const isSubmit = kind === 'submit';

  // Submitting is final and always allowed. Only exits are rate-limited.
  if (isSubmit || !localLimitExits) {
    const title = isSubmit ? "Submit Exam?" : "Exit Exam?";
    const message = isSubmit
      ? "Are you sure you want to submit your exam? You cannot undo this action."
      : "Are you sure you want to exit the exam? Exam security will be temporarily disabled.";
    const btnText = isSubmit ? "Submit" : "Exit";
    showCustomConfirmModal(title, message, btnText, () => {
      // Submitting ends the attempt: clear the exit counter so a future
      // brand-new attempt starts fresh.
      if (isSubmit) {
        chrome.storage.local.set({ examAttemptActive: false, examExitCount: 0 });
      }
      finalizeEndExam(triggerEl);
    }, () => {});
    return;
  }

  // Exit-limit feature is enabled: check remaining exits.
  chrome.storage.local.get(['maxExits', 'examExitCount'], (res) => {
    const max = (typeof res.maxExits === 'number' && res.maxExits > 0) ? res.maxExits : localMaxExits;
    const used = res.examExitCount || 0;

    if (used >= max) {
      // Student has burned through every allowed exit — lock the session down.
      triggerExitLockdown(used, max);
      return;
    }

    const remaining = max - used;
    const message = `Are you sure you want to exit? Exam security will be temporarily disabled.<br><br>` +
      `<strong>You have ${remaining} of ${max} exit${max === 1 ? '' : 's'} remaining.</strong> ` +
      `Once you run out, you will not be able to exit again and must complete your exam.`;

    showCustomConfirmModal("Exit Exam?", message, `Exit (${remaining} left)`, () => {
      // Consume one exit before ending the exam.
      chrome.storage.local.set({ examExitCount: used + 1 });
      finalizeEndExam(triggerEl);
    }, () => {});
  });
}

function showExitLimitReachedModal(max) {
  let overlay = document.getElementById('prodigy-exit-limit-overlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'prodigy-exit-limit-overlay';
  overlay.className = 'prodigy-overlay';
  overlay.style.zIndex = '99999999';

  overlay.innerHTML = `
    <div class="prodigy-modal" style="border-color: #ef4444 !important; max-width: 450px !important;">
      <div class="prodigy-warning-icon" style="color: #ef4444 !important;">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="48" height="48">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
        </svg>
      </div>
      <h2 class="prodigy-warning-title">Exit Limit Reached</h2>
      <p class="prodigy-warning-desc" style="color: #e2e8f0 !important; font-size: 14px !important; margin-bottom: 20px !important;">
        You have used all <strong>${max}</strong> of your allowed exits for this exam. To protect exam integrity, exiting is now disabled.
        <br><br>
        Please finish and submit your exam.
      </p>
      <button id="prodigy-exit-limit-dismiss-btn" class="prodigy-btn" style="background: #ef4444 !important; color: white !important;">Return to Exam</button>
    </div>
  `;

  document.body.appendChild(overlay);

  const dismissBtn = document.getElementById('prodigy-exit-limit-dismiss-btn');
  if (dismissBtn) dismissBtn.addEventListener('click', () => {
    overlay.remove();
  });
}


// --------------------------------------------------------------------------
// EXIT-LIMIT LOCKDOWN
// Triggered when a student has used up every allowed exit and tries to leave
// the exam again. Reuses the standard lockout overlay (with server-side
// registration + auto-resume) but with exit-specific wording, and persists a
// lockoutExpiry so the lockdown survives refresh / navigation.
// --------------------------------------------------------------------------
function triggerExitLockdown(usedExits, maxExits) {
  const LOCKDOWN_SECONDS = 60;
  const expiry = Date.now() + LOCKDOWN_SECONDS * 1000;

  // Persist locally so a refresh/navigation re-enforces the lockdown.
  // Also reset the exit counter: the lockdown IS the penalty, so once it is
  // applied the student's exit allowance is refreshed (they get a fresh
  // {maxExits}/{maxExits} once the lockout ends).
  localLockoutExpiry = expiry;
  chrome.storage.local.set({ lockoutExpiry: expiry, examExitCount: 0 });

  showLockoutOverlay(0, LOCKDOWN_SECONDS, {
    title: 'EXAM LOCKED',
    description: `You have exited the exam too many times ` +
      `(<strong>${usedExits}/${maxExits}</strong> exits used). ` +
      `To protect exam integrity, your session has been locked. It will unlock ` +
      `automatically, or you can request an administrator unlock.`,
    reason: 'Exceeded the allowed number of exam exits',
    statLabel: 'EXITS USED',
    statValue: `${usedExits}/${maxExits}`
  });
}


// --------------------------------------------------------------------------
// LOCKOUT CLOCK WIDGET ENHANCEMENTS
// 1. Animate the clock hands so the widget looks alive (hands rotate).
// 2. When hovered, fade the widget out and make it click-through so the
//    student can interact with whatever is behind it. Because a click-through
//    element can no longer fire its own mouseleave, we watch the cursor at the
//    document level and restore it once the pointer leaves the widget's box.
// Styles are injected here (not content.css) so this is fully self-contained.
// --------------------------------------------------------------------------
function ensureClockAnimationStyles() {
  if (document.getElementById('prodigy-clock-anim-style')) return;
  const style = document.createElement('style');
  style.id = 'prodigy-clock-anim-style';
  style.textContent = `
    @keyframes prodigy-clock-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    @keyframes prodigy-clock-pulse {
      0%   { transform: scale(1); }
      50%  { transform: scale(1.09); }
      100% { transform: scale(1); }
    }
    .prodigy-lockout-clock-widget {
      transition: opacity 0.25s ease !important;
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      padding: 0 !important;
      -webkit-backdrop-filter: none !important;
      backdrop-filter: none !important;
    }
    .prodigy-lockout-clock-widget .prodigy-clock-premium {
      animation: prodigy-clock-pulse 1s ease-in-out infinite !important;
      transform-origin: center center !important;
    }
    .prodigy-lockout-clock-widget .prodigy-clock-hand {
      transform-box: view-box !important;
      transform-origin: 50px 50px !important;
    }
    .prodigy-lockout-clock-widget .prodigy-clock-hand.second {
      animation: prodigy-clock-spin 60s steps(60, end) infinite;
    }
    .prodigy-lockout-clock-widget .prodigy-clock-hand.minute {
      animation: prodigy-clock-spin 60s linear infinite;
    }
    .prodigy-lockout-clock-widget .prodigy-clock-hand.hour {
      animation: prodigy-clock-spin 720s linear infinite;
    }
    .prodigy-lockout-clock-widget.prodigy-clock-seethrough {
      opacity: 0.12 !important;
      pointer-events: none !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function setupClockSeeThrough(clockEl) {
  if (!clockEl) return;
  let isSeeThrough = false;

  const watch = (e) => {
    const r = clockEl.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right ||
        e.clientY < r.top || e.clientY > r.bottom) {
      isSeeThrough = false;
      clockEl.classList.remove('prodigy-clock-seethrough');
      document.removeEventListener('mousemove', watch, true);
    }
  };

  clockEl.addEventListener('mouseenter', () => {
    if (isSeeThrough) return;
    isSeeThrough = true;
    clockEl.classList.add('prodigy-clock-seethrough');
    // Widget is now click-through, so it can't fire its own mouseleave.
    document.addEventListener('mousemove', watch, true);
  });
}


// --------------------------------------------------------------------------
// CLOCK TIME FORMATTER
// Formats a remaining-seconds value for the floating lockout clock:
//   >= 1 hour  ->  "HH:MM Hrs"  (e.g. 01:32 Hrs)
//   < 1 hour   ->  "MM:SS min"  (e.g. 05:30 min)
// --------------------------------------------------------------------------
function formatClockTimeParts(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return { value: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, unit: 'Hrs' };
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return { value: `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`, unit: 'min' };
}
