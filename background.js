/**
 * AliDocs to Obsidian - Background Service Worker v2.0
 *
 * Handles: Obsidian REST API calls, image writing, message routing.
 * Images are now pre-fetched (with auth cookies) by the content script
 * and passed here as base64 dataUrls for direct writing to Obsidian.
 */

'use strict';

const DEFAULT_PORT = 27123;

// ─── Settings ─────────────────────────────────────────────────────────────────

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get({
      apiKey: '',
      saveFolder: 'Clippings',
      attachmentsFolder: 'Clippings/attachments',
      port: DEFAULT_PORT,
      addFrontmatter: true,
      addCreatedDate: true,
    }, (settings) => {
      // One-time migration: if local has no apiKey, pull from sync (old storage)
      if (!settings.apiKey) {
        chrome.storage.sync.get({ apiKey: '' }, (sync) => {
          if (sync.apiKey) {
            settings.apiKey = sync.apiKey;
            chrome.storage.local.set({ apiKey: sync.apiKey });
          }
          resolve(settings);
        });
      } else {
        resolve(settings);
      }
    });
  });
}

// ─── Obsidian REST API ────────────────────────────────────────────────────────

async function obsidianPut(filePath, body, contentType, apiKey, port) {
  const encodedPath = filePath.split('/').map(seg => encodeURIComponent(seg)).join('/');
  const url = `http://localhost:${port}/vault/${encodedPath}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': contentType,
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Obsidian API ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp;
}

// ─── DataURL → ArrayBuffer ────────────────────────────────────────────────────

function dataUrlToBuffer(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mimeMatch = header.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return { buffer: buf.buffer, mime };
}

function getExt(mime, src) {
  const map = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
  if (map[mime]) return map[mime];
  const m = (src || '').match(/\.([a-zA-Z]{2,5})(?:\?|$)/);
  return m ? m[1].toLowerCase() : 'png';
}

// ─── Process Images ───────────────────────────────────────────────────────────

async function processImages(fetchedImages, settings, attachmentsFolderOverride, noteFolder) {
  const imageMap = {}; // original src → obsidian wiki path (relative to note)
  const results = [];
  const attachmentsFolder = attachmentsFolderOverride || settings.attachmentsFolder || 'Clippings/attachments';

  // Compute relative prefix for image links (e.g., "attachments/" instead of "folder/attachments/")
  const relPrefix = (noteFolder && attachmentsFolder.startsWith(noteFolder + '/'))
    ? attachmentsFolder.substring(noteFolder.length + 1)
    : null;

  for (const img of fetchedImages) {
    if (!img.success || !img.dataUrl) {
      results.push({ src: img.src, success: false, error: img.error || 'Not fetched' });
      continue;
    }

    try {
      const { buffer, mime } = dataUrlToBuffer(img.dataUrl);
      const ext = getExt(img.mimeType || mime, img.src);
      const timestamp = Date.now();
      const safeAlt = img.alt.replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_.]/g, '_').substring(0, 40);
      const filename = `${safeAlt}_${timestamp}_${img.index}.${ext}`;
      const attachPath = `${attachmentsFolder}/${filename}`;

      await obsidianPut(attachPath, buffer, img.mimeType || mime, settings.apiKey, settings.port);

      // Use relative path from note for wiki links (e.g., "attachments/img.png" instead of full vault path)
      const wikiPath = relPrefix ? `${relPrefix}/${filename}` : attachPath;
      imageMap[img.src] = wikiPath;
      results.push({ src: img.src, filename, success: true });
    } catch (err) {
      results.push({ src: img.src, success: false, error: err.message });
    }
  }

  return { imageMap, results };
}

// ─── Rebuild Markdown With Image Links ───────────────────────────────────────

function injectImageLinks(markdown, imageMap) {
  let result = markdown;
  for (const [src, obsPath] of Object.entries(imageMap)) {
    const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 1. Replace Markdown image links: ![alt](src) → ![[obsPath]]
    result = result.replace(
      new RegExp(`!\\[[^\\]]*\\]\\(${escapedSrc}\\)`, 'g'),
      `![[${obsPath}]]`
    );

    // 2. Replace HTML <img src="url"> tags (inside HTML table cells)
    //    Handles both attribute orderings: src= first and src= after other attrs
    result = result.replace(
      new RegExp(`(<img(?:[^>]*?)\\s)src=["']${escapedSrc}["']`, 'gi'),
      `$1src="${obsPath}"`
    );
    result = result.replace(
      new RegExp(`<img\\s+src=["']${escapedSrc}["']`, 'gi'),
      `<img src="${obsPath}"`
    );
  }
  return result;
}

// ─── Frontmatter ──────────────────────────────────────────────────────────────

function buildFrontmatter(title, url, site, tags, addCreatedDate) {
  const tagList = (tags && tags.length) ? tags : ['clipping'];
  const lines = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `source: "${url}"`,
    `site: ${site}`,
  ];
  if (addCreatedDate !== false) {
    lines.push(`created: ${new Date().toISOString().split('T')[0]}`);
  }
  lines.push(`tags: [${tagList.map(t => `"${t}"`).join(', ')}]`);
  lines.push('---', '');
  return lines.join('\n');
}

const INVISIBLE_CHARS_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u00AD\u034F\u2028\u2029]/g;

function safeFilename(title) {
  return title
    .replace(INVISIBLE_CHARS_RE, '')           // strip zero-width / invisible chars
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
}

// ─── Main Clip Handler ────────────────────────────────────────────────────────

async function handleClip(tabId, options = {}) {
  const settings = await getSettings();

  if (!settings.apiKey) {
    return { success: false, error: chrome.i18n.getMessage('bg_no_api_key') };
  }

  // Step 0: Ensure content script is injected
  try {
    await ensureContentScript(tabId);
  } catch (err) {
    return { success: false, error: err.message };
  }

  // Step 1: Extract content (content script scrolls through doc & pre-fetches images)
  let extractResult;
  try {
    extractResult = await chrome.tabs.sendMessage(tabId, { action: 'extract' });
  } catch (err) {
    return { success: false, error: chrome.i18n.getMessage('bg_extract_failed', [err.message]) };
  }

  if (!extractResult || !extractResult.success) {
    return { success: false, error: extractResult?.error || chrome.i18n.getMessage('bg_extract_failed_generic') };
  }

  const { title, url, site, markdown: initialMd, fetchedImages = [] } = extractResult;

  // Determine save folder (user-specified or default)
  const folder = options.folder || settings.saveFolder || 'Clippings';

  // Step 2: Write images to Obsidian — use {folder}/attachments
  let finalMd = initialMd;
  let imageResults = [];
  const attachmentsFolder = (options.folder && options.folder !== settings.saveFolder)
    ? `${folder}/attachments`
    : (settings.attachmentsFolder || 'Clippings/attachments');

  if (fetchedImages.length > 0) {
    try {
      // Ask content script to download each image via XHR (has page cookies)
      for (const img of fetchedImages) {
        if (!img.dataUrl && img.src && img.src.startsWith('http')) {
          try {
            const fetched = await chrome.tabs.sendMessage(tabId, {
              action: 'xhrFetchImage',
              src: img.src,
            });
            if (fetched && fetched.success) {
              img.dataUrl = fetched.dataUrl;
              img.mimeType = fetched.mimeType;
              img.success = true;
            } else {
              img.success = false;
              img.error = (fetched && fetched.error) || 'xhrFetchImage returned failure';
            }
          } catch (e) {
            img.success = false;
            img.error = e.message;
          }
        }
      }

      const { imageMap, results } = await processImages(fetchedImages, settings, attachmentsFolder, folder);
      imageResults = results;

      if (Object.keys(imageMap).length > 0) {
        finalMd = injectImageLinks(initialMd, imageMap);
      }
    } catch (err) {
      console.warn('[ObsidianClipper] Image processing error:', err);
    }
  }

  // Step 3: Build final note
  const frontmatter = settings.addFrontmatter
    ? buildFrontmatter(options.customTitle || title, url, site, options.tags, settings.addCreatedDate)
    : '';

  const srcLabel = chrome.i18n.getMessage('bg_source_label');
  const header = `# ${options.customTitle || title}\n\n> **${srcLabel}:** [${url}](${url})\n\n---\n\n`;
  const fullContent = frontmatter + header + finalMd;

  // Step 4: Save note to Obsidian
  const filename = safeFilename(options.customTitle || title) + '.md';
  const filePath = `${folder}/${filename}`;

  try {
    await obsidianPut(filePath, fullContent, 'text/markdown', settings.apiKey, settings.port);
  } catch (err) {
    return { success: false, error: chrome.i18n.getMessage('bg_save_failed', [err.message]) };
  }

  const imgSuccess = imageResults.filter(r => r.success).length;
  return {
    success: true,
    filePath,
    title: options.customTitle || title,
    imageCount: imageResults.length,
    imageSuccess: imgSuccess,
  };
}

// ─── Inject Content Script ────────────────────────────────────────────────────

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (pong && pong.status === 'ok') return;
  } catch {}

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_script.js'] });
    await new Promise(r => setTimeout(r, 400));
  } catch (err) {
    throw new Error(chrome.i18n.getMessage('bg_inject_failed', [err.message]));
  }
}

// ─── Test Connection ──────────────────────────────────────────────────────────

async function testConnection(apiKey, port) {
  try {
    const resp = await fetch(`http://localhost:${port}/`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    return { success: resp.ok || resp.status === 400, status: resp.status };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'clip') {
    handleClip(message.tabId, message.options || {})
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'testConnection') {
    testConnection(message.apiKey, message.port || DEFAULT_PORT)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'getSettings') {
    getSettings().then(sendResponse);
    return true;
  }

  return false;
});

