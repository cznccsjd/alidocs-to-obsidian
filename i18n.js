/**
 * Runtime i18n — replaces data-i18n attributes with chrome.i18n.getMessage()
 * Works in popup and options pages without relying on Chrome's __MSG__ HTML processing.
 */
(function () {
  'use strict';

  // Replace text content of elements with data-i18n="key"
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = chrome.i18n.getMessage(key) || key;
  });

  // Replace placeholder attributes with data-i18n-placeholder="key"
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = chrome.i18n.getMessage(key) || key;
  });

  // Replace title attributes
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    el.title = chrome.i18n.getMessage(key) || key;
  });
})();
