# BlockClip (Copy Code with relative path)

一款简洁而强大的跨平台代码复制增强工具，支持 **VS Code** 与 **JetBrains 全系列 IDE（IntelliJ IDEA、WebStorm、PyCharm、GoLand、CLion 等）**。

旨在让你能够高效地复制文件或文件夹的代码内容，并自动附带其相对于项目的路径，输出为格式优美的 Markdown 代码块。

无论是向 AI 助手提问（如 ChatGPT、Claude、DeepSeek）、编写技术文档，还是与团队同事分享代码，都能完整保留上下文与结构。

> 💡 **配套油猴脚本**：在浏览器端配合 **Google Gemini** 或 **Google AI Studio** 使用时，可配合 [userscript 油猴脚本](./userscript/README.md) 实现一键将 BlockClip 格式文本还原为代码目录树，自动打包为 ZIP 附件或单文件 Markdown 极速拖拽注入对话框！

---

## ✨ 核心特性

- **多处右键直达 & 选区直接复制**：
  - **项目文件树右键**：支持单文件、多文件批量选择、以及文件夹递归复制代码（VS Code 亦支持在资源管理器空白处右键或通过命令面板一键复制工作区根目录）。
  - **编辑器文件标签页（Tab）右键**：快速复制当前已打开文件的代码。
  - **代码编辑区内任意位置右键**：选中文本时可直接“复制选中代码”（带路径与精确行号），未选中时一键复制整文件。
- **代码暂存栈（Clip Stack，支持文件 / 文件夹 / 选中片段）**：
  - **混合收集**：支持整文件、整个文件夹以及编辑器中任意选中代码片段混合入栈，片段自动标注精确行号（如 `(lines 10-25)`）。
  - **同一文件多次切片**：在同一文件的不同位置多次摘录关键片段，保留高信噪比上下文。
  - **一键导出与顺手清空**：复制全栈代码后，气泡附带 **`[ 清空暂存栈 ]`** 快捷按钮以及总体积 / 粗略 Token 估算；底部状态栏实时显示当前暂存条数，点击直达管理列表。
  - **精准管理与移除**：支持栈顶撤销（Pop）、按文件或文件夹一键移除相关暂存项、以及交互式列表单条删除与行号跳转。
- **所见即所得（Dirty Document First）**：
  - 复制时优先读取内存中已修改但尚未保存（`Ctrl+S`）的内容，告别传统插件直接读取磁盘旧代码的痛点。
- **智能 Markdown 包裹 & 体积/Token 估算**：
  - 自动识别文件语言（JavaScript, TypeScript, Python, Rust, Go, Java, Kotlin, C/C++, HTML, CSS, Vue, Svelte, YAML 等）。
  - **自适应反引号防截断**：自动根据代码内部连续反引号数量增加外层反引号，防止输出至 Markdown 时语法断裂。
  - **二进制与敏感文件保护**：结合扩展名与内容级前 8KB 空字节（NUL）探测，自动识别未知后缀的二进制/数据库/缓存文件并仅输出路径标识，防止 Windows 剪贴板截断；文件夹递归扫描默认排除 `.env`、密钥证书（同时保留 `.env.example` / `.env.sample` / `.env.template` 安全模板）。
  - **体积与 Token 估算**：每次复制反馈均展示总大小与粗略 Token 数量，方便把控 AI 上下文预算。
- **文件夹递归与 .gitignore / IDE 忽略规则级联**：
  - 智能级联读取项目根目录、中间目录及子目录的 `.gitignore` 与 `.git/info/exclude` 规则，并自动尊重 IDE 隐藏/排除目录（JetBrains Excluded/Ignored 目录、VS Code `files.exclude`）。
  - 默认忽略 `.git`、`node_modules`、`dist`、`build`、`.idea`、`.vscode` 等目录。
  - **文件夹递归与实时进度条**：双端批量复制/扫描文件夹时均提供原生进度条，实时展示扫描计数、读取百分比与当前文件名，并支持随时取消。
  - **自定义大小上限保护**：默认上限 **50 MB**，支持在设置中自由调整（设为 `0` 表示无限制）：
    - **VS Code**：设置搜索 `blockClip.maxContentSizeMB`
    - **JetBrains (IDEA / WebStorm)**：`Settings -> Tools -> BlockClip`
- **原生多语言国际化 (i18n)**：
  - 菜单名称、描述以及操作完成后的提示气泡，完全根据 IDE 当前界面语言自动切换（支持简体中文与英文）。

---

## ⌨️ 默认快捷键（VS Code & JetBrains 双端统一）

| 快捷键 | 功能说明 |
| :--- | :--- |
| `Alt + Shift + B` | 复制当前文件（若编辑器内有选中代码，自动复制选中片段） |
| `Alt + Shift + S` | 将当前文件或选中代码片段加入暂存栈 |
| `Alt + Shift + X` | 一键复制暂存栈中的全部代码 |
| `Alt + Shift + Z` | *(浏览器配套油猴脚本)* 直接从剪贴板打包并注入 Gemini / AI Studio |

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

### 3. 油猴脚本 (Tampermonkey Userscript)

用于在浏览器中配合 **Google Gemini** 或 **Google AI Studio** 自动还原文件树、打包 ZIP 与拖拽注入：
- 脚本位置：[`userscript/blockclip-to-zip.user.js`](./userscript/blockclip-to-zip.user.js)
- 安装指南：确保已安装 Tampermonkey 或 Violentmonkey，具体请参阅 [userscript 详细说明文档](./userscript/README.md)。

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
