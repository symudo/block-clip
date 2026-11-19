# BlockClip (Copy Code with relative path)

一款简洁而强大的跨平台代码复制增强工具，支持 **VS Code** 与 **JetBrains 全系列 IDE（IntelliJ IDEA、WebStorm、PyCharm、GoLand、CLion 等）**。

旨在让你能够高效地复制文件或文件夹的代码内容，并自动附带其相对于项目的路径，输出为格式优美的 Markdown 代码块。

无论是向 AI 助手提问（如 ChatGPT、Claude、DeepSeek）、编写技术文档，还是与团队同事分享代码，都能完整保留上下文与结构。

---

## ✨ 核心特性

- **多处右键直达**：
  - **项目文件树右键**：支持单文件、多文件批量选择、以及文件夹递归复制代码。
  - **编辑器文件标签页（Tab）右键**：快速复制当前已打开文件的代码。
  - **代码编辑区内任意位置右键**：无需移动鼠标至边缘，在代码区右键一键复制，保持专注心流。
- **所见即所得（Dirty Document First）**：
  - 复制时优先读取内存中已修改但尚未保存（`Ctrl+S`）的内容，告别传统插件直接读取磁盘旧代码的痛点。
- **智能 Markdown 包裹**：
  - 自动识别文件语言（JavaScript, TypeScript, Python, Rust, Go, Java, Kotlin, C/C++, HTML, CSS, Vue, Svelte, YAML 等）。
  - **自适应反引号防截断**：自动根据代码内部连续反引号数量增加外层反引号，防止输出至 Markdown 时语法断裂。
  - **二进制文件过滤**：针对图片、音视频、压缩包等非文本文件仅输出路径标识，杜绝乱码污染剪贴板。
- **文件夹递归与 .gitignore 规则级联**：
  - 智能级联读取项目根目录及当前文件夹的 `.gitignore` 过滤规则。
  - 默认忽略 `.git`、`node_modules`、`dist`、`build`、`.idea`、`.vscode` 等目录。
  - 内置 15MB 保护阈值，防止意外超大内容溢出。
- **原生多语言国际化 (i18n)**：
  - 菜单名称、描述以及操作完成后的提示气泡，完全根据 IDE 当前界面语言自动切换（支持简体中文与英文）。

---

## 🚀 安装方法

你可以在 [GitHub Releases](https://github.com/symudo/block-clip/releases) 页面下载最新构建好的双端插件安装包。

### 1. Visual Studio Code

- **方式一（本地离线安装）**：
  1. 在 [Releases](https://github.com/symudo/block-clip/releases) 中下载 `block-clip-x.x.x.vsix`；
  2. 打开 VS Code，按下 `Ctrl+Shift+X`（macOS 为 `Cmd+Shift+X`）打开扩展面板；
  3. 点击扩展面板右上角的 `...` 菜单，选择 **从 VSIX 安装... (Install from VSIX...)**；
  4. 选择下载的 `.vsix` 文件完成安装。

- **方式二（VS Code Marketplace 安装）**：
  在扩展商店中搜索 `blockClip` 或 `Copy Code with filename` 并点击安装。

### 2. JetBrains IDE（IntelliJ IDEA / WebStorm 等）

支持全系列 JetBrains 平台（版本 2024.1+）：
1. 在 [Releases](https://github.com/symudo/block-clip/releases) 中下载 `block-clip-intellij-x.x.x.zip`；
2. 打开 IntelliJ IDEA、WebStorm 或其他 JetBrains IDE；
3. 打开设置（Windows/Linux: `Ctrl + Alt + S`，macOS: `Cmd + ,`）；
4. 进入 **Plugins（插件）**，点击右上角齿轮 ⚙️ 图标；
5. 选择 **Install Plugin from Disk...（从磁盘安装插件...）**；
6. 选中下载的 `.zip` 压缩包并确认，即可立即启用！

---

## 📖 复制效果示例

### 单个文件复制：
````markdown
File: src/extension.ts

```typescript
import * as path from 'node:path'
import * as vscode from 'vscode'

export function activate(context: vscode.ExtensionContext) {
  // ...
}
```
````

### 多个文件复制：
````markdown
File: package.json

```json
{
  "name": "block-clip",
  "version": "0.2.0"
}
```

---

File: src/extension.ts

```typescript
// ...
```
````

---

## 🛠️ 云端持续集成与自动化发布

本项目通过 GitHub Actions 实现完整的 CI/CD 流程：
- 每次推送代码均自动执行 VS Code 端与 IntelliJ 端的编译、代码规范和测试；
- 每次推送版本标签（`v*`），GitHub Actions 会在云端全自动构建出适用于 VS Code 的 `.vsix` 和适用于 JetBrains IDE 的 `.zip` 插件包，并自动附带 `CHANGELOG.md` 更新日志发布至 GitHub Releases。

---

## 📜 许可证

本项目基于 [MIT License](https://opensource.org/licenses/MIT) 开源。
