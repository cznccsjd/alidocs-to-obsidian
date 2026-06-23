/**
 * Obsidian Web Clipper - Content Script v4.0
 *
 * AliDocs DOM structure (confirmed via live inspection):
 *
 *  The document is inside:  iframe#wiki-doc-iframe  (same-origin)
 *  Main scroll container:   div#layout_body          (virtual scroll, scrollHeight > clientHeight)
 *
 *  Content elements inside iframe:
 *    - Headings:  standard h1–h6 tags
 *    - Paragraphs & lists:  div[data-listid]
 *        data-level:     indentation depth (0=top, 1=sub, 2=sub-sub…)
 *        data-isordered: "true" = ordered list / "false" = unordered
 *        data-format:    "decimal" | "lowerLetter" | "bullet" | …
 *        innerText:      may contain bullet prefix (●, ○, 1., a., etc.)
 *    - Tables:    standard <table> tags (virtual-scrolled, may recreate DOM nodes)
 *    - Images:    standard <img> tags (may appear at multiple positions in doc)
 *    - Quotes:    standard <blockquote> tags
 *
 *  Key bugs fixed in v4.0:
 *    - Dedup key for tables now normalises whitespace → prevents duplicate tables
 *      from virtual-scroll DOM recreation
 *    - ●○◆◇★☆ Unicode bullet chars stripped from list item text
 *    - Icons (display size < 32px) excluded from image collection
 *    - Same image URL at different doc positions captured separately
 *    - Invisible Unicode characters (ZWS, BOM, etc.) stripped from title
 */

(function () {
  'use strict';

  if (window.__obsidianClipperInjected) return;
  window.__obsidianClipperInjected = true;

  const wait = ms => new Promise(r => setTimeout(r, ms));

  // ─── Site Detection ──────────────────────────────────────────────────────

  function detectSite() {
    const h = location.hostname;
    if (/alidocs\.dingtalk\.com|docs\.dingtalk\.com/.test(h)) return 'alidocs';
    if (/yuque\.com/.test(h)) return 'yuque';
    if (/feishu\.cn|larksuite\.com/.test(h)) return 'feishu';
    if (/notion\.so/.test(h)) return 'notion';
    return 'generic';
  }

  // ─── Title Cleanup ───────────────────────────────────────────────────────

  // Strip invisible / zero-width Unicode characters from document title
  const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u00AD\u034F\u2028\u2029]/g;

  function cleanTitle(raw) {
    return raw
      .replace(INVISIBLE_CHARS, '')
      .replace(/\s*·\s*钉钉文档\s*$/i, '')
      .replace(/\s*[-|—·]\s*(钉钉|DingTalk|AliDocs|飞书|语雀|Notion|Google).*$/i, '')
      .replace(/[/\\:*?"<>|]/g, '_')
      .trim() || 'Untitled';
  }

  // ─── Dedup Key Helpers ───────────────────────────────────────────────────

  /**
   * Build a stable deduplication key for a DOM element.
   * Tables normalise internal whitespace to prevent duplicates from
   * virtual-scroll DOM recreation (same logical table, slightly different
   * whitespace in innerText at different scroll positions).
   *
   * Images use a position-bucketed key so the same image URL appearing at
   * two different vertical positions in the document is captured both times.
   */
  function dedupKey(el, absTop) {
    const tag = el.tagName;

    if (tag === 'IMG') {
      const src = el.src || el.dataset.src || el.getAttribute('data-original') || '';
      // Bucket by 200px increments so same image at different positions → different keys
      // while re-renders of same element at same logical position → same key
      const bucket = Math.round(absTop / 200);
      return `IMG:${src}:${bucket}`;
    }

    if (tag === 'TABLE') {
      // Normalise all whitespace sequences to a single space for stable key
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      return `TABLE:${text.substring(0, 200)}`;
    }

    const text = (el.innerText || '').trim();
    return `${tag}:${text.substring(0, 150)}`;
  }

  // ─── AliDocs: Scroll & Collect ───────────────────────────────────────────

  async function scrollAndCollectAlidocs() {
    const iframe = document.getElementById('wiki-doc-iframe');
    if (!iframe) return null;

    let iDoc;
    try {
      iDoc = iframe.contentDocument || iframe.contentWindow.document;
    } catch { return null; }

    const scrollEl = iDoc.getElementById('layout_body');
    if (!scrollEl) return null;

    const savedScrollTop = scrollEl.scrollTop;

    // Scroll to top and wait for render
    scrollEl.scrollTop = 0;
    await wait(700);

    // All discovered content blocks, keyed for deduplication
    const seen = new Map(); // key → { el, absTop }

    // Combined selector for all AliDocs content types
    const SELECTOR = [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      '[data-listid]',
      'table',
      'img',
      'blockquote',
      'pre',
    ].join(',');

    let totalSeenInScroll = 0;
    let totalPassedFilters = 0;
    let totalDeduped = 0;
    // Per-filter rejection counters
    const filterStats = { tableInternal: 0, imgInListId: 0, listIdWrapsHeading: 0, headingInListId: 0, smallIcon: 0, emptyTextAndSrc: 0, deduped: 0 };
    // Per-step [data-listid] census
    const perStepListIdCounts = [];

    function captureFrame() {
      const allEls = iDoc.querySelectorAll(SELECTOR);
      totalSeenInScroll += allEls.length;

      // Count [data-listid] elements currently in the DOM at this scroll position
      perStepListIdCounts.push(iDoc.querySelectorAll('[data-listid]').length);

      allEls.forEach(el => {
        if (el.tagName !== 'TABLE' && el.closest('table')) { filterStats.tableInternal++; return; }
        if (el.tagName === 'IMG' && el.closest('[data-listid]')) { filterStats.imgInListId++; return; }
        if (el.hasAttribute('data-listid') &&
            el.querySelector(':scope > * > h1, :scope > * > h2, :scope > * > h3, :scope > * > h4, :scope > * > h5, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5')) { filterStats.listIdWrapsHeading++; return; }
        if (/^H[1-6]$/.test(el.tagName) && el.closest('[data-listid]')) { filterStats.headingInListId++; return; }

        if (el.tagName === 'IMG') {
          const dispW = el.width || el.offsetWidth || 0;
          const dispH = el.height || el.offsetHeight || 0;
          if (dispW > 0 && dispH > 0 && dispW < 32 && dispH < 32) { filterStats.smallIcon++; return; }
        }

        const text = (el.innerText || '').trim();
        const src = el.tagName === 'IMG'
          ? (el.src || el.dataset.src || el.getAttribute('data-original') || '')
          : '';

        if (!text && !src) { filterStats.emptyTextAndSrc++; return; }

        totalPassedFilters++;
        const rect = el.getBoundingClientRect();
        const absTop = scrollEl.scrollTop + rect.top;
        const key = dedupKey(el, absTop);

        if (seen.has(key)) { totalDeduped++; filterStats.deduped++; return; }
        seen.set(key, { el, absTop });
      });
    }

    // Step through the document
    let prevScrollTop = -1;
    const step = Math.max(150, scrollEl.clientHeight * 0.55);
    const maxIter = 80;
    let iter = 0;

    while (iter++ < maxIter) {
      captureFrame();

      const cur = scrollEl.scrollTop;
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;

      if (cur >= maxScroll - 2 || cur === prevScrollTop) {
        captureFrame(); // final pass at bottom
        break;
      }

      prevScrollTop = cur;
      scrollEl.scrollTop = Math.min(cur + step, maxScroll);
      await wait(380);
    }

    // Restore scroll position
    scrollEl.scrollTop = savedScrollTop;

    // Sort by vertical position to maintain reading order
    const blocks = [...seen.values()].sort((a, b) => a.absTop - b.absTop);

    // ── Diagnostic ──
    const byTag = {};
    let totalTextChars = 0;
    for (const b of blocks) {
      const t = b.el.tagName.toLowerCase();
      byTag[t] = (byTag[t] || 0) + 1;
      if (t !== 'img') totalTextChars += (b.el.innerText || '').length;
    }
    console.log('[diag] scroll steps:', iter - 1);
    console.log('[diag] total elements seen (all scroll pos):', totalSeenInScroll);
    console.log('[diag] passed filters:', totalPassedFilters);
    console.log('[diag] deduped (skipped):', totalDeduped);
    console.log('[diag] filter rejection breakdown:', JSON.stringify(filterStats));
    console.log('[diag] [data-listid] count per scroll step (min/max/avg):',
      Math.min(...perStepListIdCounts), '/', Math.max(...perStepListIdCounts), '/',
      (perStepListIdCounts.reduce((a,b)=>a+b,0) / perStepListIdCounts.length).toFixed(1));
    console.log('[diag] [data-listid] per-step counts:', perStepListIdCounts);
    console.log('[diag] unique blocks captured:', blocks.length, '→ by tag:', JSON.stringify(byTag));
    console.log('[diag] total text chars in blocks:', totalTextChars);

    // Deep DOM inspection: what element types exist in the iframe body that have text?
    const allBodyEls = iDoc.body.querySelectorAll('*');
    const bodyTagCounts = {};
    const bodyTagText = {};
    for (const el of allBodyEls) {
      const t = el.tagName.toLowerCase();
      bodyTagCounts[t] = (bodyTagCounts[t] || 0) + 1;
      const txt = (el.innerText || '').trim();
      if (txt && !bodyTagText[t]) bodyTagText[t] = txt.substring(0, 80);
    }
    // Show only tags with text that are NOT in our SELECTOR
    const selectorTags = ['h1','h2','h3','h4','h5','h6','table','img','blockquote','pre'];
    console.log('[diag] ALL elements in iframe body by tag:');
    for (const [tag, count] of Object.entries(bodyTagCounts).sort((a,b) => b[1]-a[1])) {
      const inSelector = selectorTags.includes(tag) || tag === 'div'; // div may have data-listid
      const sample = bodyTagText[tag] || '';
      console.log(`[diag]   ${tag} x${count} inSelector=${inSelector} sample="${sample}"`);
    }
    // Show elements that have data-listid attribute
    const listIdEls = iDoc.body.querySelectorAll('[data-listid]');
    console.log(`[diag] [data-listid] elements currently in DOM: ${listIdEls.length}`);
    listIdEls.forEach((el, i) => {
      if (i < 5) console.log(`[diag]   [${i}] text="${(el.innerText||'').trim().substring(0, 100)}"`);
    });

    return { blocks, iDoc };
  }

  // ─── Table Helpers ────────────────────────────────────────────────────────

  function isComplexTable(table) {
    for (const cell of table.querySelectorAll('td, th')) {
      if (parseInt(cell.getAttribute('colspan') || 1) > 1) return true;
      if (parseInt(cell.getAttribute('rowspan') || 1) > 1) return true;
    }
    return false;
  }

  function tableToMd(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';
    const mdRows = [];
    let sep = false;
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td, th'));
      if (!cells.length) continue;
      const texts = cells.map(c => {
        const text = (c.innerText || '').replace(/\n/g, ' ').replace(/\|/g, '\\|').trim();
        // Collect any images inside this cell — emit ![alt](src) so injectImageLinks
        // can replace them with local ![[obsPath]] after upload
        const imgLinks = Array.from(c.querySelectorAll('img'))
          .filter(img => {
            const src = img.src || img.dataset.src || '';
            if (!src || src.startsWith('data:image/gif')) return false;
            // skip icons by display size
            const dW = img.width || 0, dH = img.height || 0;
            if (dW > 0 && dH > 0 && dW < 32 && dH < 32) return false;
            return true;
          })
          .map(img => {
            const src = img.src || img.dataset.src || img.getAttribute('data-original') || '';
            return src ? `![${(img.alt || '').replace(/\|/g, '')}](${src})` : '';
          })
          .filter(Boolean);
        return [text, ...imgLinks].filter(Boolean).join(' ');
      });
      mdRows.push('| ' + texts.join(' | ') + ' |');
      if (!sep) { mdRows.push('| ' + texts.map(() => '---').join(' | ') + ' |'); sep = true; }
    }
    return mdRows.join('\n');
  }

  function tableToHTML(table) {
    const c = table.cloneNode(true);
    c.querySelectorAll('script, style').forEach(e => e.remove());
    c.querySelectorAll('*').forEach(e => {
      [...e.attributes].filter(a => a.name.startsWith('on')).forEach(a => e.removeAttribute(a.name));
      e.removeAttribute('class'); e.removeAttribute('style');
    });
    return c.outerHTML;
  }

  // ─── Bullet Prefix Stripping ─────────────────────────────────────────────

  // Matches common bullet characters including Unicode circle/disc/arrow variants
  // Used to strip the visual bullet from list item text before adding markdown marker
  const BULLET_PREFIX_RE = /^[\s\u2022\u00B7\u25AA\u25AB\u25B8\u25BA\u25CF\u25CB\u25C6\u25C7\u2605\u2606\u25FE\u25FD\u2023\u2043\u204C\u204D\u2219●○◆◇▶▷►▸•·▪▫‣⁃\-\*]+\s*/;

  function stripBulletPrefix(text) {
    return text.replace(BULLET_PREFIX_RE, '');
  }

  // ─── Inline Rich-Text Conversion ─────────────────────────────────────────

  function inlineToMd(el, imageMap) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent.replace(/[\r\n]+/g, ' ');
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = node.tagName.toLowerCase();
      const inner = inlineToMd(node, imageMap);
      switch (tag) {
        case 'strong': case 'b': out += inner.trim() ? `**${inner.trim()}**` : ''; break;
        case 'em': case 'i':    out += inner.trim() ? `*${inner.trim()}*` : ''; break;
        case 's': case 'del':   out += inner.trim() ? `~~${inner.trim()}~~` : ''; break;
        case 'u':               out += inner.trim() ? `<u>${inner.trim()}</u>` : ''; break;
        case 'code':            out += `\`${node.textContent}\``; break;
        case 'a': {
          const t = inner.trim();
          const href = node.href;
          out += (href && href !== location.href && href !== '#') ? `[${t}](${href})` : t;
          break;
        }
        case 'img': {
          const src = node.src || node.dataset.src || '';
          if (!src) break;
          // Skip icons inline too
          const dW = node.width || node.offsetWidth || 0;
          const dH = node.height || node.offsetHeight || 0;
          if (dW > 0 && dH > 0 && dW < 32 && dH < 32) break;
          out += (imageMap && imageMap[src]) ? `![[${imageMap[src]}]]` : `![${node.alt || 'image'}](${src})`;
          break;
        }
        case 'br': out += '\n'; break;
        default:   out += inner; break;
      }
    }
    return out;
  }

  // ─── Block → Markdown ─────────────────────────────────────────────────────

  function blockToMd(el, imageMap) {
    const tag = el.tagName.toLowerCase();

    // ── Headings ──
    const hMatch = tag.match(/^h([1-6])$/);
    if (hMatch) {
      const text = (el.innerText || '').trim();
      return text ? `\n\n${'#'.repeat(parseInt(hMatch[1]))} ${text}\n\n` : '';
    }

    // ── AliDocs list/paragraph blocks ──
    if (el.hasAttribute('data-listid')) {
      const level = parseInt(el.dataset.level || '0');
      const indent = '  '.repeat(level);
      const rawText = (el.innerText || '').trim();
      if (!rawText) return '';

      // Get formatted text with inline markup preserved
      const formatted = inlineToMd(el, imageMap).trim().replace(/\n+/g, ' ');
      const text = formatted || rawText;

      const isOrdered = el.dataset.isordered === 'true';
      const format = el.dataset.format || '';

      if (format === 'decimal') {
        // Numbered list: 1., 2., 3.
        const numMatch = rawText.match(/^(\d+)\.\s*/);
        const num = numMatch ? numMatch[1] : '1';
        const body = (formatted.replace(/^\d+\.\s*/, '') || rawText.replace(/^\d+\.\s*/, '')).trim();
        return `\n${indent}${num}. ${body}`;

      } else if (format === 'lowerLetter' || format === 'upperLetter') {
        // Lettered list: a., b., A., B.
        const letterMatch = rawText.match(/^([a-zA-Z])\.\s*/);
        const letter = letterMatch ? letterMatch[1] : 'a';
        const body = (formatted.replace(/^[a-zA-Z]\.\s*/, '') || rawText.replace(/^[a-zA-Z]\.\s*/, '')).trim();
        return `\n${indent}${letter}. ${body}`;

      } else if (format === 'lowerRoman' || format === 'upperRoman') {
        const body = stripBulletPrefix(formatted.replace(/^[ivxlcdmIVXLCDM]+\.\s*/i, '') || rawText.replace(/^[ivxlcdmIVXLCDM]+\.\s*/i, '')).trim();
        return `\n${indent}- ${body}`;

      } else if (!isOrdered || format === 'bullet' || format === 'disc' || format === 'circle') {
        // Unordered bullet — strip any bullet prefix character (●, ○, •, -, *, etc.)
        const body = stripBulletPrefix(formatted || rawText);
        return `\n${indent}- ${body}`;

      } else {
        // Plain paragraph (no list format, ordered=true but unknown format)
        // Still strip bullet prefix just in case
        const body = stripBulletPrefix(text);
        return `\n\n${body}\n\n`;
      }
    }

    // ── Table ──
    if (tag === 'table') {
      return isComplexTable(el)
        ? `\n\n${tableToHTML(el)}\n\n`
        : `\n\n${tableToMd(el)}\n\n`;
    }

    // ── Image ──
    if (tag === 'img') {
      const src = el.src || el.dataset.src || el.getAttribute('data-original') || '';
      if (!src) return '';
      if (imageMap && imageMap[src]) return `\n\n![[${imageMap[src]}]]\n\n`;
      return `\n\n![${el.alt || 'image'}](${src})\n\n`;
    }

    // ── Blockquote ──
    if (tag === 'blockquote') {
      const text = (el.innerText || '').trim();
      return text ? '\n\n' + text.split('\n').map(l => `> ${l}`).join('\n') + '\n\n' : '';
    }

    // ── Pre/Code ──
    if (tag === 'pre') {
      const codeEl = el.querySelector('code');
      const lang = (codeEl?.className.match(/language-(\w+)/) || [])[1] || '';
      return `\n\n\`\`\`${lang}\n${(codeEl || el).textContent}\n\`\`\`\n\n`;
    }

    return '';
  }

  // ─── Assemble Full Markdown ───────────────────────────────────────────────

  function blocksToMarkdown(blocks, imageMap) {
    const parts = [];
    // Extra dedup layer in the output: tables that produce identical markdown
    // are skipped even if DOM-level dedup didn't catch them (virtual-scroll
    // can re-create elements with subtly different internal whitespace).
    const emittedTables = new Set();

    for (const { el } of blocks) {
      const md = blockToMd(el, imageMap || {});
      if (!md) continue;

      if (el.tagName === 'TABLE') {
        // Normalise to a compact key: collapse whitespace, lowercase
        const key = md.replace(/\s+/g, ' ').trim().toLowerCase();
        if (emittedTables.has(key)) continue;
        emittedTables.add(key);
      }

      parts.push(md);
    }
    return parts.join('')
      .replace(/\n{4,}/g, '\n\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  // ─── Image Collection & Fetch ────────────────────────────────────────────

  function normalizeSrcForDedup(src) {
    // Strip OSS/CDN auth query params to deduplicate the same image with different signed URLs
    try {
      const u = new URL(src, location.href);
      // Drop time-limited auth params common in AliCloud OSS and similar CDNs
      ['Expires', 'Signature', 'auth_key', 'OSSAccessKeyId', 'x-oss-process'].forEach(p => u.searchParams.delete(p));
      return u.href;
    } catch {
      return src.split('?')[0]; // fallback: strip all query params
    }
  }

  function collectImages(blocks) {
    const images = [];
    const seenSrc = new Set(); // normalized URL → already collected (dedup)
    const srcToLocalIndex = {}; // original src → index in images array (for wiki-link ref)

    for (const { el } of blocks) {
      const imgs = el.tagName === 'IMG' ? [el] : Array.from(el.querySelectorAll('img'));
      for (const img of imgs) {
        const src = img.src || img.dataset.src || img.getAttribute('data-original') || '';
        if (!src || src.startsWith('data:image/gif')) continue;

        // Skip decorative icons by display size
        const dispW = img.width || img.offsetWidth || 0;
        const dispH = img.height || img.offsetHeight || 0;
        if (dispW > 0 && dispH > 0 && dispW < 32 && dispH < 32) continue;

        // Also skip by natural size
        const nW = img.naturalWidth || 0;
        const nH = img.naturalHeight || 0;
        if (nW > 0 && nW < 40 && nH > 0 && nH < 40) continue;

        const dedupKey = normalizeSrcForDedup(src);
        if (seenSrc.has(dedupKey)) continue;
        seenSrc.add(dedupKey);

        const safeAlt = (img.alt || `img_${images.length}`)
          .replace(/[/\\:*?"<>|]/g, '_').substring(0, 60);
        const idx = images.length;
        srcToLocalIndex[src] = idx;
        images.push({ src, alt: safeAlt, index: idx });
      }
    }
    return images;
  }

  async function fetchImageAsBase64(src) {
    const logErr = (method, msg) => {
      console.log(`[content] ${method} failed: ${msg} | src: ${src.substring(0, 120)}`);
    };

    // ── Attempt 1: XHR from content script (host_permissions <all_urls> bypasses CORS,
    //              withCredentials auto-sends browser cookies for CDN auth) ──
    try {
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', src, true);
        xhr.responseType = 'blob';
        xhr.timeout = 30000;
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            const blob = xhr.response;
            const reader = new FileReader();
            reader.onload = () => resolve({ dataUrl: reader.result, mimeType: blob.type });
            reader.onerror = () => reject(new Error('FileReader error'));
            reader.readAsDataURL(blob);
          } else {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('XHR network error'));
        xhr.ontimeout = () => reject(new Error('XHR timeout'));
        xhr.send();
      });
      console.log(`[content] XHR OK → mime=${result.mimeType} | src: ${src.substring(0, 80)}`);
      return result;
    } catch (xhrErr) {
      logErr('XHR', xhrErr.message);
    }

    // ── Attempt 2: fallback to background proxy with cookie API ──
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'fetchImage',
        src,
        referer: location.href,
      });
      if (!resp || !resp.success) throw new Error(resp?.error || 'fetchImage failed');
      console.log(`[content] background proxy OK | src: ${src.substring(0, 80)}`);
      return { dataUrl: resp.dataUrl, mimeType: resp.mimeType };
    } catch (bgErr) {
      logErr('background', bgErr.message);
    }

    throw new Error('All fetch methods exhausted');
  }

  async function fetchAllImages(images) {
    const results = [];
    for (const img of images) {
      try {
        if (img.src.startsWith('data:')) {
          results.push({ ...img, dataUrl: img.src, mimeType: img.src.split(';')[0].split(':')[1], success: true });
        } else {
          const { dataUrl, mimeType } = await fetchImageAsBase64(img.src);
          results.push({ ...img, dataUrl, mimeType, success: true });
        }
      } catch (e) {
        results.push({ ...img, success: false, error: e.message });
      }
    }
    return results;
  }

  // ─── Generic Extraction (fallback) ───────────────────────────────────────

  function extractGenericContent() {
    const selectors = ['article', 'main', '[role="main"]', '.article-content', '.post-content', '#content'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && (el.innerText || '').trim().length > 200) return el;
    }
    return document.body;
  }

  function genericToMd(el, imageMap) {
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\s+/g, ' ');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const t = node.tagName.toLowerCase();
      if (/^(script|style|nav|button|noscript)$/.test(t)) return '';
      try { if (getComputedStyle(node).display === 'none') return ''; } catch {}
      const inner = () => Array.from(node.childNodes).map(walk).join('');
      if (/^h([1-6])$/.test(t)) return `\n\n${'#'.repeat(parseInt(t[1]))} ${node.innerText.trim()}\n\n`;
      switch (t) {
        case 'p':          { const x = inner().trim(); return x ? `\n\n${x}\n\n` : ''; }
        case 'li':         return `\n- ${inner().trim()}`;
        case 'br':         return '\n';
        case 'strong': case 'b': { const x = inner().trim(); return x ? `**${x}**` : ''; }
        case 'em': case 'i':     { const x = inner().trim(); return x ? `*${x}*` : ''; }
        case 'a':   { const x = inner().trim(); return node.href ? `[${x}](${node.href})` : x; }
        case 'img': {
          const src = node.src;
          return (imageMap && imageMap[src]) ? `\n\n![[${imageMap[src]}]]\n\n` : `\n\n![${node.alt || 'image'}](${src})\n\n`;
        }
        case 'table': return isComplexTable(node) ? `\n\n${tableToHTML(node)}\n\n` : `\n\n${tableToMd(node)}\n\n`;
        default: return inner();
      }
    }
    return walk(el).replace(/\n{4,}/g, '\n\n\n').trim();
  }

  // ─── Page Title ──────────────────────────────────────────────────────────

  function getTitle() {
    return cleanTitle(document.title);
  }

  // ─── AliDocs API-Based Extraction ───────────────────────────────────────

  const ALIDOCS_API = 'https://alidocs.dingtalk.com/api/document/data';

  function getDentryKey() {
    // dentryKey is in the iframe URL, not the top-level page URL
    let m = location.href.match(/[?&]dentryKey=([^&]+)/);
    if (m) return m[1];
    const iframe = document.getElementById('wiki-doc-iframe');
    if (iframe && iframe.src) {
      m = iframe.src.match(/[?&]dentryKey=([^&]+)/);
      if (m) return m[1];
    }
    return '';
  }

  async function fetchAlidocsApi() {
    const dentryKey = getDentryKey();
    if (!dentryKey) throw new Error('Cannot find dentryKey in URL');

    const resp = await fetch(ALIDOCS_API, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'a-dentry-key': dentryKey,
      },
      body: JSON.stringify({ fetchBody: true }),
    });
    if (!resp.ok) throw new Error(`API HTTP ${resp.status}`);

    const json = await resp.json();
    if (!json.isSuccess) throw new Error('API returned failure');
    const content = json.data?.documentContent?.checkpoint?.content;
    if (!content) throw new Error('No checkpoint content in API response');

    const doc = JSON.parse(content);

    // Document uses parts-based structure: doc.parts[doc.main].data.body
    let body;
    if (doc.main && doc.parts && doc.parts[doc.main]) {
      body = doc.parts[doc.main].data?.body;
    }
    // Fallback: direct body array (older format)
    if (!body && Array.isArray(doc.body)) body = doc.body;

    if (!body || !Array.isArray(body)) {
      console.log('[api-extract] doc keys:', Object.keys(doc));
      console.log('[api-extract] body type:', typeof body, 'main:', doc.main);
      throw new Error('Unexpected body structure');
    }

    // Body structure: ["root", {sectPr, theme}, block1, block2, ..., blockN]
    // Each block is an array: ["h1", props, ...children] or ["p", props, ...children]
    const blocks = body.slice(2); // skip "root" and sectPr wrapper
    console.log('[api-extract] blocks:', blocks.length, 'body len:', body.length);
    return { blocks, doc };
  }

  // ── Convert API body blocks to Markdown ──

  function extractTextFromBlock(block) {
    // block = ["h1"|"p"|..., props_or_skip, ...children]
    // children are: ["span", {...}, ["span", {...}, "text"]] or ["img", {...}] or ["br", {...}] or ["tag", {...}]
    const parts = [];
    for (let i = (typeof block[1] === 'object' && !Array.isArray(block[1]) ? 2 : 1); i < block.length; i++) {
      walkBlockChild(block[i], parts);
    }
    return parts.join('').replace(/[​-‏‪-‮⁠-⁤⁪-⁯﻿­]/g, '');
  }

  function walkBlockChild(node, parts) {
    if (typeof node === 'string') { parts.push(node); return; }
    if (!Array.isArray(node)) return;
    const type = node[0];
    switch (type) {
      case 'span': {
        // ["span", {...}, ["span", {...}, "text"]]
        for (let i = 1; i < node.length; i++) walkBlockChild(node[i], parts);
        break;
      }
      case 'br': {
        parts.push('\n');
        break;
      }
      case 'img': {
        let src = (node[1] && node[1].src) || '';
        if (src && src.startsWith('/')) src = 'https://alidocs.dingtalk.com' + src;
        const alt = (node[1] && node[1].name) || 'image';
        if (src) parts.push(`![${alt}](${src})`);
        break;
      }
      case 'tag': break; // skip embedded doc tags (render as empty)
      default: {
        for (let i = 1; i < node.length; i++) walkBlockChild(node[i], parts);
      }
    }
  }

  function collectImagesFromBody(blocks) {
    const images = [];
    const seenDedup = new Set();

    function walk(node) {
      if (!Array.isArray(node)) return;
      if (node[0] === 'img') {
        const props = node[1] || {};
        let src = props.src || '';
        if (src && src.startsWith('/')) src = 'https://alidocs.dingtalk.com' + src;
        if (!src) return;
        const dedupKey = normalizeSrcForDedup(src);
        if (seenDedup.has(dedupKey)) return;
        seenDedup.add(dedupKey);
        const alt = (props.name || `img_${images.length}`).replace(/[/\\:*?"<>|]/g, '_').substring(0, 60);
        images.push({ src, alt, index: images.length });
        return;
      }
      for (let i = 1; i < node.length; i++) walk(node[i]);
    }
    for (const block of blocks) walk(block);
    return images;
  }

  function blocksToMarkdownApi(blocks) {
    const lines = [];

    for (const block of blocks) {
      if (!Array.isArray(block) || !block.length) continue;
      const type = block[0];
      const props = (block.length > 1 && typeof block[1] === 'object' && !Array.isArray(block[1])) ? block[1] : {};
      const text = extractTextFromBlock(block).trim();

      // Headings
      const hMatch = type.match(/^h([1-6])$/);
      if (hMatch) {
        if (text) lines.push('\n\n' + '#'.repeat(parseInt(hMatch[1])) + ' ' + text + '\n\n');
        continue;
      }

      // Paragraph
      if (type === 'p') {
        if (props.blockquote) {
          if (text) lines.push('\n\n> ' + text.replace(/\n/g, '\n> ') + '\n\n');
          else lines.push('\n\n>\n\n');
        } else if (props.list) {
          const { list } = props;
          const level = list.level || 0;
          const indent = '  '.repeat(level);
          const isOrdered = list.isOrdered;
          const format = (list.listStyle || {}).format || 'bullet';
          const symbolText = (list.listStyle || {}).text || '●';

          if (format === 'decimal') {
            lines.push('\n' + indent + '1. ' + text);
          } else if (format === 'bullet') {
            lines.push('\n' + indent + '- ' + text);
          } else {
            lines.push('\n' + indent + '- ' + text);
          }
        } else {
          if (text) lines.push('\n\n' + text + '\n\n');
        }
        continue;
      }

      // Table
      if (type === 'table') {
        const rows = block.slice(2); // skip "table" and props
        const mdRows = [];
        let hasHeader = false;
        for (const tr of rows) {
          if (!Array.isArray(tr) || tr[0] !== 'tr') continue;
          const trProps = tr[1] || {};
          const cells = [];
          for (const tc of tr.slice(2)) {
            if (!Array.isArray(tc) || tc[0] !== 'tc') continue;
            const cellText = extractTextFromBlock(tc).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim();
            // Grab inline images inside table cells
            const imgSrcs = [];
            walkTableImgs(tc, imgSrcs);
            cells.push([cellText, ...imgSrcs].filter(Boolean).join(' '));
          }
          if (!cells.length) continue;
          mdRows.push('| ' + cells.join(' | ') + ' |');
          if (!hasHeader) {
            mdRows.push('| ' + cells.map(() => '---').join(' | ') + ' |');
            hasHeader = true;
          }
        }
        if (mdRows.length) lines.push('\n\n' + mdRows.join('\n') + '\n\n');
        continue;
      }

      // Blockquote (if top-level blockquote element — rare with API format)
      if (type === 'blockquote') {
        if (text) lines.push('\n\n' + text.split('\n').map(l => '> ' + l).join('\n') + '\n\n');
        continue;
      }

      // Fallback: generic text
      if (text) lines.push('\n\n' + text + '\n\n');
    }

    return lines.join('').replace(/\n{4,}/g, '\n\n\n').trim();
  }

  function walkTableImgs(node, out) {
    if (!Array.isArray(node)) return;
    if (node[0] === 'img') {
      let src = (node[1] && node[1].src) || '';
      if (src && src.startsWith('/')) src = 'https://alidocs.dingtalk.com' + src;
      if (src) out.push(`![image](${src})`);
      return;
    }
    for (let i = 1; i < node.length; i++) walkTableImgs(node[i], out);
  }

  // ─── Main Extract ─────────────────────────────────────────────────────────

  async function handleExtract() {
    const site = detectSite();
    const title = getTitle();
    const url = location.href;

    if (site === 'alidocs') {
      try {
        const { blocks } = await fetchAlidocsApi();
        if (!blocks || blocks.length === 0) {
          throw new Error('Empty document body');
        }

        const imageObjects = collectImagesFromBody(blocks);
        console.log('[api-extract] blocks:', blocks.length, 'images:', imageObjects.length);
        const fetchedImages = await fetchAllImages(imageObjects);
        const markdown = blocksToMarkdownApi(blocks);

        return {
          success: true, title, url, site, markdown,
          fetchedImages: fetchedImages.map(img => ({
            src: img.src, alt: img.alt, index: img.index,
            dataUrl: img.success ? img.dataUrl : null,
            mimeType: img.success ? img.mimeType : null,
            success: img.success, error: img.error,
          })),
        };
      } catch (e) {
        console.warn('[api-extract] API extraction failed, falling back to DOM scroll:', e.message);
        // Fallback to original DOM scroll approach
        const scrollResult = await scrollAndCollectAlidocs();
        if (!scrollResult || scrollResult.blocks.length === 0) {
          return { success: false, error: '未找到文档内容。请确认文档已完全加载。' };
        }
        const { blocks } = scrollResult;
        const imageObjects = collectImages(blocks);
        const fetchedImages = await fetchAllImages(imageObjects);
        const markdown = blocksToMarkdown(blocks, {});
        return {
          success: true, title, url, site, markdown,
          fetchedImages: fetchedImages.map(img => ({
            src: img.src, alt: img.alt, index: img.index,
            dataUrl: img.success ? img.dataUrl : null,
            mimeType: img.success ? img.mimeType : null,
            success: img.success, error: img.error,
          })),
        };
      }
    }

    // Generic fallback
    const contentEl = extractGenericContent();
    const allImgs = Array.from(contentEl.querySelectorAll('img'));
    const seenSrc = new Set();
    const imageObjects = [];
    allImgs.forEach((img, i) => {
      const src = img.src || img.dataset.src || img.getAttribute('data-original') || '';
      if (!src || src.startsWith('data:image/gif')) return;
      const nW = img.naturalWidth || 0, nH = img.naturalHeight || 0;
      if (nW > 0 && nW < 40 && nH > 0 && nH < 40) return;
      const dispW = img.width || img.offsetWidth || 0, dispH = img.height || img.offsetHeight || 0;
      if (dispW > 0 && dispH > 0 && dispW < 32 && dispH < 32) return;
      if (seenSrc.has(src)) return;
      seenSrc.add(src);
      const safeAlt = (img.alt || `img_${i}`).replace(/[/\\:*?"<>|]/g, '_').substring(0, 60);
      imageObjects.push({ src, alt: safeAlt, index: imageObjects.length });
    });

    const fetchedImages = await fetchAllImages(imageObjects);

    return {
      success: true, title, url, site,
      markdown: genericToMd(contentEl, {}),
      fetchedImages: fetchedImages.map(img => ({
        src: img.src, alt: img.alt, index: img.index,
        dataUrl: img.success ? img.dataUrl : null,
        mimeType: img.success ? img.mimeType : null,
        success: img.success, error: img.error,
      })),
    };
  }

  // ─── Data Source Probe ────────────────────────────────────────────────────

  function probeDataSources() {
    const report = {};

    // Access the iframe
    const iframe = document.getElementById('wiki-doc-iframe');
    const iWin = iframe && (iframe.contentWindow || iframe.contentDocument?.defaultView);
    if (!iWin) return { error: 'cannot access iframe window' };

    // 1. Scan window for large objects / store-like keys
    const interestingKeys = [];
    const keyPatterns = /store|state|model|data|doc|content|page|editor|collab|model/i;
    try {
      for (const key of Object.getOwnPropertyNames(iWin)) {
        if (keyPatterns.test(key) && !/^(window|document|location|navigator|parent|top|self|frames)$/i.test(key)) {
          const val = iWin[key];
          const type = typeof val;
          let summary = type;
          try {
            if (type === 'object' && val !== null) {
              summary = JSON.stringify(val).substring(0, 200);
            } else if (type === 'string') {
              summary = val.substring(0, 200);
            } else if (type === 'function') {
              summary = 'function ' + (val.name || 'anonymous');
            }
          } catch { summary = type + ' (not serializable)'; }
          interestingKeys.push({ key, type, summary });
        }
      }
    } catch (e) { report.windowScanError = e.message; }
    report.interestingWindowKeys = interestingKeys;

    // 2. Check __INITIAL_STATE__ / __NEXT_DATA__ / __REDUX_STATE__ style globals
    const statePatterns = ['__INITIAL_STATE__', '__NEXT_DATA__', '__DATA__', '__REDUX_STATE__',
      '__STORE__', '__PREFETCHED_STATE__', '__APOLLO_STATE__', '__NUXT__', '__APP_STATE__',
      'pageData', 'appData', 'initialData', 'globalData'];
    const stateHits = [];
    for (const name of statePatterns) {
      try {
        const val = iWin[name];
        if (val !== undefined) {
          const s = JSON.stringify(val);
          stateHits.push({ name, size: s.length, preview: s.substring(0, 300) });
        }
      } catch { /* not accessible */ }
    }
    report.statePatternHits = stateHits;

    // 3. Try to access React/Vue component trees
    const frameworkHints = [];
    try {
      // React fiber
      const rootEl = iWin.document.getElementById('layout_body') || iWin.document.body;
      const reactKey = Object.keys(rootEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (reactKey) frameworkHints.push({ framework: 'React', key: reactKey });
      // Vue
      if (rootEl.__vue__ || rootEl.__vue_app__) frameworkHints.push({ framework: 'Vue', keys: Object.keys(rootEl).filter(k => k.includes('vue')) });
    } catch (e) { frameworkHints.push({ error: e.message }); }
    report.frameworkHints = frameworkHints;

    // 4. Look at AliDocs specific globals
    const alidocsKeys = [];
    try {
      for (const key of Object.getOwnPropertyNames(iWin)) {
        if (/alidoc|dingtalk|dingdoc|we.?word|lippi|collab|doc/i.test(key)) {
          const type = typeof iWin[key];
          alidocsKeys.push({ key, type });
        }
      }
    } catch {}
    report.alidocsKeys = alidocsKeys;

    // 5. Search ALL keys (not just own) for large objects
    const largeObjects = [];
    try {
      const seen = new Set();
      for (let proto = iWin; proto; proto = Object.getPrototypeOf(proto)) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const val = iWin[key];
            if (typeof val === 'object' && val !== null && !(val instanceof Node)) {
              const s = JSON.stringify(val).substring(0, 500);
              if (s.length > 100) {
                largeObjects.push({ key, jsonLen: s.length, preview: s.substring(0, 200) });
              }
            }
          } catch {}
        }
      }
    } catch {}
    report.largeObjects = largeObjects.slice(0, 20);

    return report;
  }

  // ─── Message Listener ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'ping') {
      sendResponse({ status: 'ok', site: detectSite(), title: getTitle() });
      return true;
    }
    if (message.action === 'extract') {
      handleExtract().then(sendResponse).catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (message.action === 'probe') {
      try {
        const report = probeDataSources();
        console.log('[probe]', JSON.stringify(report, null, 2));
        sendResponse({ success: true, report });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }
    return false;
  });

  // Inject probe.js into main world via <script src>.
  // CSP on alidocs.dingtalk.com allows chrome-extension:// scripts but blocks inline.
  function injectProbeIntoMainWorld() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('probe.js');
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
    console.log('[ObsidianClipper] Probe injected. Type __obsidianProbe() in Console to scan AliDocs data sources.');
  }
  injectProbeIntoMainWorld();

})();
