/**
 * AliDocs Data Source Probe — injected into MAIN world via chrome.scripting
 * CSP allows chrome-extension:// scripts on alidocs.dingtalk.com
 */
window.__obsidianProbe = function () {
  'use strict';

  const iframe = document.getElementById('wiki-doc-iframe');
  const iWin = iframe && (iframe.contentWindow || iframe.contentDocument && iframe.contentDocument.defaultView);
  if (!iWin) {
    console.error('[probe] Cannot access iframe');
    return;
  }

  const report = {};

  // ── 1. Interesting window keys (state/store/model patterns) ──
  const interesting = [];
  const keyPatterns = /store|state|model|data|doc|content|page|editor|collab|model/;
  try {
    for (const key of Object.getOwnPropertyNames(iWin)) {
      if (keyPatterns.test(key) && !/^(window|document|location|navigator|parent|top|self|frames|on\w+)$/i.test(key)) {
        const type = typeof iWin[key];
        let preview = type;
        try {
          if (type === 'string') preview = iWin[key].substring(0, 200);
          else if (type === 'object' && iWin[key] !== null) preview = JSON.stringify(iWin[key]).substring(0, 300);
          else if (type === 'function') preview = 'fn ' + (iWin[key].name || '');
        } catch (e) { preview = type + ' (error: ' + e.message + ')'; }
        interesting.push({ key, type, preview });
      }
    }
  } catch (e) { interesting.push({ error: e.message }); }
  report.interestingKeys = interesting;

  // ── 2. Known state containers ──
  const patterns = ['__INITIAL_STATE__', '__NEXT_DATA__', '__DATA__', '__REDUX_STATE__',
    '__STORE__', '__PREFETCHED_STATE__', '__APOLLO_STATE__', '__NUXT__',
    'pageData', 'appData', 'initialData', 'globalData'];
  const hits = [];
  for (const name of patterns) {
    try {
      if (iWin[name] !== undefined) {
        const s = JSON.stringify(iWin[name]);
        hits.push({ name, jsonSize: s.length, preview: s.substring(0, 500) });
      }
    } catch (e) { /* nope */ }
  }
  report.stateHits = hits;

  // ── 3. AliDocs/DingTalk specific globals ──
  const aliKeys = [];
  try {
    for (const key of Object.getOwnPropertyNames(iWin)) {
      if (/alidoc|dingtalk|dingdoc|we.?word|lippi|collab|doc|model|editor/i.test(key)) {
        aliKeys.push({ key, type: typeof iWin[key] });
      }
    }
  } catch (e) {}
  report.alidocsKeys = aliKeys;

  // ── 4. Large JSON objects in global scope ──
  const largeObj = [];
  try {
    const seen = new Set(['window', 'document', 'location', 'navigator', 'parent', 'top', 'self', 'frames', 'console']);
    for (const key of Object.getOwnPropertyNames(iWin)) {
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const val = iWin[key];
        if (typeof val === 'object' && val !== null && !(val instanceof Node)) {
          const s = JSON.stringify(val);
          if (s.length > 200) {
            largeObj.push({ key, jsonLen: s.length, preview: s.substring(0, 300) });
          }
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) {}
  report.largeObjects = largeObj.slice(0, 30);

  // ── 5. React fiber detection ──
  try {
    const root = iWin.document.getElementById('layout_body') || iWin.document.body;
    const fiberKey = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (fiberKey) report.reactFiberKey = fiberKey;
    // Try to walk up the fiber tree to find state
    let fiber = root[fiberKey];
    let depth = 0;
    while (fiber && depth < 30) {
      if (fiber.memoizedState && fiber.memoizedState.memoizedState) {
        report.fiberStateFound = { depth, hasQueue: !!fiber.memoizedState.queue };
      }
      if (fiber.stateNode && fiber.stateNode !== root) {
        try {
          const stateKeys = Object.keys(fiber.stateNode).filter(k => /store|state|model|data|doc/.test(k));
          if (stateKeys.length) {
            report.fiberStateNode = { depth, tag: fiber.tag, stateKeys };
            break;
          }
        } catch (e) {}
      }
      fiber = fiber.return;
      depth++;
    }
  } catch (e) { report.reactFiberError = e.message; }

  // ── 6. Search for MobX / observable stores ──
  try {
    const mobxKeys = Object.getOwnPropertyNames(iWin).filter(k =>
      /mobx|observable|store|\$mobx/i.test(k) && typeof iWin[k] === 'object'
    );
    if (mobxKeys.length) report.mobxKeys = mobxKeys;
  } catch (e) {}

  // ── 7. Inspect iframe document for data attributes ──
  try {
    const dataAttrs = [];
    for (const el of iWin.document.querySelectorAll('[id]')) {
      const id = el.id;
      if (/data|store|model|state|content|doc|editor/i.test(id)) {
        dataAttrs.push({ tag: el.tagName, id, hasChildren: el.children.length });
      }
    }
    if (dataAttrs.length) report.dataElements = dataAttrs.slice(0, 20);

    // Check for data- attributes that might hold serialized state
    const bodyEl = iWin.document.body;
    for (const attr of bodyEl.attributes) {
      if (/data-/.test(attr.name) && attr.value.length > 100) {
        report.bodyDataAttrs = report.bodyDataAttrs || [];
        report.bodyDataAttrs.push({ name: attr.name, valueLen: attr.value.length, preview: attr.value.substring(0, 200) });
      }
    }
  } catch (e) {}

  console.log('%c[ObsidianClipper:probe] %cData source report',
    'color:#a6e3a1;font-weight:bold', 'color:#cdd6f4');
  console.log(JSON.stringify(report, null, 2));
  console.log('%c[ObsidianClipper:probe] %cDone. Copy the JSON above.',
    'color:#a6e3a1;font-weight:bold', 'color:#cdd6f4');
  return report;
};

console.log('%c[ObsidianClipper] %cProbe ready. Type %c__obsidianProbe()%c to scan AliDocs data sources.',
  'color:#a6e3a1','color:#cdd6f4','color:#89b4fa;font-weight:bold','color:#cdd6f4');

