/**
 * AliDocs to Obsidian - Options Script
 */

'use strict';

const DEFAULTS = {
  apiKey: '',
  port: 27123,
  saveFolder: 'Clippings',
  attachmentsFolder: 'Clippings/attachments',
  addFrontmatter: true,
  addCreatedDate: true,
};

// ─── DOM Elements ─────────────────────────────────────────────────────────────

const elApiKey = document.getElementById('apiKey');
const elPort = document.getElementById('port');
const elSaveFolder = document.getElementById('saveFolder');
const elAttachmentsFolder = document.getElementById('attachmentsFolder');
const elAddFrontmatter = document.getElementById('addFrontmatter');
const elAddCreatedDate = document.getElementById('addCreatedDate');
const elBtnSave = document.getElementById('btnSave');
const elBtnReset = document.getElementById('btnReset');
const elBtnTest = document.getElementById('btnTest');
const elTestResult = document.getElementById('testResult');
const elStatusBar = document.getElementById('statusBar');

// ─── Load Settings ────────────────────────────────────────────────────────────

function loadSettings() {
  chrome.storage.local.get(DEFAULTS, (settings) => {
    elApiKey.value = settings.apiKey || '';
    elPort.value = settings.port || 27123;
    elSaveFolder.value = settings.saveFolder || 'Clippings';
    elAttachmentsFolder.value = settings.attachmentsFolder || 'Clippings/attachments';
    elAddFrontmatter.checked = settings.addFrontmatter !== false;
    elAddCreatedDate.checked = settings.addCreatedDate !== false;
  });
}

// ─── Save Settings ────────────────────────────────────────────────────────────

function saveSettings() {
  const settings = {
    apiKey: elApiKey.value.trim(),
    port: parseInt(elPort.value) || 27123,
    saveFolder: elSaveFolder.value.trim() || 'Clippings',
    attachmentsFolder: elAttachmentsFolder.value.trim() || 'Clippings/attachments',
    addFrontmatter: elAddFrontmatter.checked,
    addCreatedDate: elAddCreatedDate.checked,
  };

  chrome.storage.local.set(settings, () => {
    showStatus('success', chrome.i18n.getMessage('options_saved'));
    setTimeout(clearStatus, 3000);
  });
}

// ─── Reset Settings ───────────────────────────────────────────────────────────

function resetSettings() {
  if (!confirm(chrome.i18n.getMessage('options_reset_prompt'))) return;

  chrome.storage.local.set(DEFAULTS, () => {
    loadSettings();
    showStatus('success', chrome.i18n.getMessage('options_reset_done'));
    setTimeout(clearStatus, 3000);
  });
}

// ─── Test Connection ──────────────────────────────────────────────────────────

async function testConnection() {
  const apiKey = elApiKey.value.trim();
  const port = parseInt(elPort.value) || 27123;

  if (!apiKey) {
    elTestResult.className = 'test-result error';
    elTestResult.textContent = chrome.i18n.getMessage('options_test_no_api_key');
    return;
  }

  elTestResult.className = 'test-result';
  elTestResult.textContent = chrome.i18n.getMessage('options_testing');

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'testConnection',
      apiKey,
      port,
    });

    if (result.success) {
      elTestResult.className = 'test-result success';
      elTestResult.textContent = chrome.i18n.getMessage('options_test_success');
    } else {
      elTestResult.className = 'test-result error';
      elTestResult.textContent = chrome.i18n.getMessage('options_test_fail', [String(result.status || result.error || 'no response')]);
    }
  } catch (err) {
    elTestResult.className = 'test-result error';
    elTestResult.textContent = chrome.i18n.getMessage('options_test_error', [err.message]);
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

function showStatus(type, message) {
  elStatusBar.className = `status-bar ${type}`;
  elStatusBar.textContent = message;
}

function clearStatus() {
  elStatusBar.className = 'status-bar';
  elStatusBar.textContent = '';
}

// ─── Events ───────────────────────────────────────────────────────────────────

elBtnSave.addEventListener('click', saveSettings);
elBtnReset.addEventListener('click', resetSettings);
elBtnTest.addEventListener('click', testConnection);

// Auto-save on Enter in any field
[elApiKey, elPort, elSaveFolder, elAttachmentsFolder].forEach(el => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveSettings();
  });
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadSettings();
