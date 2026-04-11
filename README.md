# Obsidian AliDocs Clipper

A Chrome extension that clips AliDocs/DingTalk documents directly into your Obsidian vault — preserving full formatting, tables, and images (stored locally).

## Features
- 📄 Captures full AliDocs documents including virtual-scrolled content
- 📊 Converts tables to Markdown (or keeps HTML for complex merged-cell tables)
- 🖼️ Downloads images locally to your Obsidian attachments folder
- 🔗 Inserts `![[wiki links]]` for images — no broken external URLs
- 🏷️ Adds YAML frontmatter (source URL, date, tags)
- ⚙️ Configurable via options page (API key, save folder, attachments folder)

## Requirements
- [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin installed and running
- Chrome browser

## Installation
1. Clone or download this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → select this folder
5. Open the extension options and enter your Obsidian Local REST API key

## Usage
Navigate to any AliDocs / DingTalk document and click the extension icon to clip it to Obsidian.

## Version History
- **v1.0** — Initial release: AliDocs virtual-scroll capture, local image download, table formatting, invisible-Unicode title cleanup
