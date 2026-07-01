# AliDocs to Obsidian

[English](README.md) | 简体中文

将阿里文档/钉钉文档一键剪藏到 Obsidian，完整保留格式、表格和图片。

基于 [memoricry88/obsidian-alidocs-clipper](https://github.com/memoricry88/obsidian-alidocs-clipper) 二次开发。

## 功能
- 📄 通过 AliDocs API 提取完整文档内容（不再有虚拟滚动导致的文字丢失）
- 📊 表格转换为 Markdown，支持多栏布局
- 🖼️ 图片下载到 Obsidian 本地附件目录
- 🔗 图片使用 `![[wiki 链接]]`，不会出现外部链接失效
- 🏷️ 自动添加 YAML frontmatter（来源、日期、标签）
- 📁 可自定义保存目录，图片自动跟随到 `{目录}/attachments`
- ⚙️ 可通过选项页配置（API Key、保存目录、附件目录）
- 🌐 支持英文和简体中文，跟随浏览器语言自动切换

## 安装

### 推荐方式：从 Releases 下载
1. 前往 [Releases](https://github.com/cznccsjd/alidocs-to-obsidian/releases) 下载最新 `alidocs-to-obsidian-vX.X.X.zip`
2. 解压到一个固定目录（扩展从此目录加载，请勿删除）
3. 打开 Chrome → `chrome://extensions`
4. 启用 **开发者模式**
5. 点击 **加载已解压的扩展程序** → 选择解压后的文件夹
6. 点击扩展图标 → ⚙️ 设置 → 填入 API Key

### 从源码安装
```bash
git clone https://github.com/cznccsjd/alidocs-to-obsidian.git
```
然后按上述步骤 3–6 操作。

### Obsidian 配置
1. 安装 [Local REST API with MCP](https://github.com/coddingtonbear/obsidian-local-rest-api) 插件
2. 启用插件，记下生成的 API Key
3. 确保端口为默认的 `27123`（一般无需修改）

## 使用

在任意阿里文档/钉钉文档页面点击扩展图标即可剪藏到 Obsidian。

## 常见问题

### 在 Obsidian 插件库里找不到 REST API 插件

1. 打开 Obsidian → **设置 → 社区插件**
2. 关掉 **安全模式（Restricted Mode）**——开启状态下社区插件会被隐藏
3. 点击 **浏览**，搜索 **"Local REST API"** 或作者 **"Adam Coddington"**
4. 安装并启用，插件的设置页面会显示 API Key

## 与上游项目的差异

- 使用 AliDocs API (`/api/document/data`) 替代 DOM 虚拟滚动提取——文字覆盖率从 13% 提升到 100%
- 图片通过 Content Script XHR 代理下载，解决同源资源鉴权问题
- 自定义保存目录时，图片自动存入 `{目录}/attachments/`
- 相对路径 Wiki 链接（`attachments/img.png`）替代绝对 vault 路径
- 支持英文/中文界面切换
- 多项 bug 修复和代码质量提升

## 许可证

MIT
