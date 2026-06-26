# AliDocs to Obsidian

English | [简体中文](README.zh-CN.md)

A Chrome extension that clips AliDocs/DingTalk documents directly into your Obsidian vault — preserving full formatting, tables, and images (stored locally).

Based on [memoricry88/obsidian-alidocs-clipper](https://github.com/memoricry88/obsidian-alidocs-clipper).

## Features
- 📄 Extracts full document content via AliDocs API (no more virtual-scroll text loss)
- 📊 Converts tables to Markdown with column support
- 🖼️ Downloads images locally to your Obsidian attachments folder
- 🔗 Inserts `![[wiki links]]` for images — no broken external URLs
- 🏷️ Adds YAML frontmatter (source URL, date, tags)
- 📁 Customizable save folder — images follow into `{folder}/attachments`
- ⚙️ Configurable via options page (API key, save folder, attachments folder)

## Requirements
- [Local REST API with MCP](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin installed and running in Obsidian
- Chrome browser

## Installation
1. Clone or download this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → select this folder
5. Open the extension options and enter your Obsidian Local REST API key

## Usage
Navigate to any AliDocs / DingTalk document and click the extension icon to clip it to Obsidian.

## Troubleshooting

### Can't find the REST API plugin in Obsidian

1. Go to **Settings → Community Plugins** in Obsidian
2. Turn off **Restricted Mode** (if enabled, community plugins are hidden)
3. Click **Browse** and search for **"Local REST API"** or author **"Adam Coddington"**
4. Install and enable it — the API Key appears in the plugin's settings section

## Changes from upstream
- Replaced DOM virtual-scroll extraction with AliDocs API (`/api/document/data`) — full text coverage
- Fixed image download for same-origin resources via content script XHR proxy
- Images now saved to `{custom-folder}/attachments/` when using custom save paths
- Relative wiki links (`attachments/img.png`) instead of absolute vault paths
