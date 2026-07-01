document.addEventListener('DOMContentLoaded', () => {
  const statusBadge = document.getElementById('status-badge');
  const violationsCount = document.getElementById('violations-count');
  const violationLog = document.getElementById('violation-log');

  function formatTime(isoString) {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderLog(log) {
    if (!log || log.length === 0) {
      violationLog.innerHTML = '<p class="log-empty">No violations recorded.</p>';
      return;
    }
    // Show last 5, most recent first
    const recent = log.slice(-5).reverse();
    violationLog.innerHTML = recent.map(entry => `
      <div class="log-entry">
        <div class="log-entry-header">
          <span class="log-time">${formatTime(entry.timestamp)}</span>
          <span class="log-flag-num">Flag #${entry.count}</span>
        </div>
        <span class="log-reason">${entry.reason}</span>
      </div>
    `).join('');
  }

  function updateUI() {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError || !response) return;

      if (response.examModeActive) {
        statusBadge.textContent = 'Active';
        statusBadge.className = 'status-badge active';
      } else {
        statusBadge.textContent = 'Idle';
        statusBadge.className = 'status-badge idle';
      }

      const count = response.violations || 0;
      violationsCount.textContent = count;
      violationsCount.classList.toggle('flagged', count > 0);
    });

    // Load violation log separately from storage
    chrome.storage.local.get(['violationLog'], (result) => {
      renderLog(result.violationLog || []);
    });
  }

  updateUI();

  // Live updates when storage changes (violations, exam state, or log)
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && (
      changes.examModeActive || changes.violations || changes.violationLog
    )) {
      updateUI();
    }
  });
});
