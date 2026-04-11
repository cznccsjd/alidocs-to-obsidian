/**
 * Obsidian Web Clipper - Popup Script
 */

'use strict';

// ─── DOM Elements ─────────────────────────────────────────────────────────────

const elNoApiKey = document.getElementById('noApiKey');
const elMainBody = document.getElementById('mainBody');
const elSiteBadge = document.getElementById('siteBadge');
const elPageTitle = document.getElementById('pageTitle');
const elPageUrl = document.getElementById('pageUrl');
const elSaveFolder = document.getElementById('saveFolder');
const elCustomTitle = document.getElementById('customTitle');
const elTagsInput = document.getElementById('tagsInput');
const elBtnSave = document.getElementById('btnSave');
const elBtnIcon = document.getElementById('btnIcon');
const elBtnText = document.getElementById('btnText');
const elStatus = document.getElementById('status');
const elProgressSteps = document.getElementById('progressSteps');
const elConnDot = document.getElementById('connDot');
const elConnText = document.getElementById('connText');
const elBtnSettings = document.getElementById('btnSettings');
const elOpenOptions = document.getElementById('openOptions');

const steps = [
  document.getElementById('step1'),
  document.getElementById('step2'),
  document.getElementById('step3'),
];

// ─── State ────────────────────────────────────────────────────────────────────

let currentTab = null;
let settings = null;
let isSaving = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Get settings
  settings = await chrome.runtime.sendMessage({ action: 'getSettings' });

  if (!settings.apiKey) {
    elMainBody.style.display = 'none';
    elNoApiKey.style.display = 'block';
    return;
  }

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  // Prefill folder from settings
  elSaveFolder.value = settings.saveFolder || 'Clippings';

  // Ensure content script is injected, then get page info
  try {
    let info = null;
    // Try ping first
    try {
      info = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
    } catch {
      // Not injected yet — inject now
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_script.js'] });
        await new Promise(r => setTimeout(r, 300));
        info = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      } catch (injErr) {
        console.warn('Script injection failed:', injErr);
      }
    }
    if (info) {
      elPageTitle.textContent = info.title || tab.title || 'Untitled';
      elPageUrl.textContent = tab.url;
      elSiteBadge.textContent = info.site || 'generic';
    } else {
      elPageTitle.textContent = tab.title || 'Untitled';
      elPageUrl.textContent = tab.url;
      elSiteBadge.textContent = 'generic';
    }
  } catch (err) {
    elPageTitle.textContent = tab.title || 'Untitled';
    elPageUrl.textContent = tab.url;
    elSiteBadge.textContent = 'generic';
  }

  // Test Obsidian connection
  checkConnection();
}

async function checkConnection() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'testConnection',
      apiKey: settings.apiKey,
      port: settings.port || 27123,
    });

    if (result.success) {
      elConnDot.className = 'conn-dot connected';
      elConnText.textContent = 'Obsidian 已连接';
    } else {
      elConnDot.className = 'conn-dot disconnected';
      elConnText.textContent = 'Obsidian 未连接';
    }
  } catch {
    elConnDot.className = 'conn-dot disconnected';
    elConnText.textContent = '连接失败';
  }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setStatus(type, message) {
  elStatus.className = `status ${type}`;
  elStatus.textContent = message;
}

function clearStatus() {
  elStatus.className = 'status';
  elStatus.textContent = '';
}

function setStep(index, state) {
  const el = steps[index];
  if (!el) return;

  const icons = {
    pending: '⬜',
    active: '🔄',
    done: '✅',
    failed: '❌',
    skipped: '⏭️',
  };

  el.className = `step ${state === 'active' ? 'active' : state === 'done' ? 'done' : state === 'failed' ? 'failed' : ''}`;
  el.querySelector('.step-icon').textContent = icons[state] || '⬜';
}

function showProgress() {
  elProgressSteps.style.display = 'block';
  steps.forEach((_, i) => setStep(i, 'pending'));
}

function hideProgress() {
  elProgressSteps.style.display = 'none';
}

function setSaving(saving) {
  isSaving = saving;
  elBtnSave.disabled = saving;

  if (saving) {
    elBtnIcon.textContent = '';
    elBtnText.textContent = '保存中...';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    elBtnIcon.appendChild(spinner);
  } else {
    elBtnIcon.textContent = '💾';
    elBtnText.textContent = '保存到 Obsidian';
  }
}

// ─── Save Handler ─────────────────────────────────────────────────────────────

elBtnSave.addEventListener('click', async () => {
  if (isSaving || !currentTab) return;

  clearStatus();
  setSaving(true);
  showProgress();

  const folder = elSaveFolder.value.trim() || settings.saveFolder || 'Clippings';
  const tags = elTagsInput.value.trim()
    ? elTagsInput.value.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  setStep(0, 'active');

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'clip',
      tabId: currentTab.id,
      options: {
        folder,
        tags,
        customTitle: elCustomTitle.value.trim() || null,
      },
    });

    if (result.success) {
      setStep(0, 'done');
      setStep(1, result.imageCount > 0 ? 'done' : 'skipped');
      setStep(2, 'done');

      const msg = result.imageCount > 0
        ? `✅ 已保存！下载了 ${result.imageSuccess}/${result.imageCount} 张图片\n📁 ${result.filePath}`
        : `✅ 已保存！\n📁 ${result.filePath}`;

      setStatus('success', msg);
    } else {
      setStep(0, 'failed');
      setStep(1, 'failed');
      setStep(2, 'failed');
      setStatus('error', `❌ 保存失败：${result.error}`);
    }
  } catch (err) {
    setStep(0, 'failed');
    setStatus('error', `❌ 错误：${err.message}`);
  } finally {
    setSaving(false);
  }
});

// ─── Settings Button ──────────────────────────────────────────────────────────

elBtnSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

if (elOpenOptions) {
  elOpenOptions.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

init().catch(err => {
  elPageTitle.textContent = '加载失败';
  setStatus('error', err.message);
});
