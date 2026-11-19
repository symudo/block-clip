# BlockClip for JetBrains IDEs (IntelliJ IDEA & WebStorm)

适用于 JetBrains 全系列 IDE（**IntelliJ IDEA**、**WebStorm**、**PyCharm**、**GoLand**、**CLion**、**PhpStorm**、**Android Studio** 等）的代码复制增强插件。

100% 对标 VS Code 版本，支持快速复制文件或文件夹代码，并自动附带相对路径与自适应 Markdown 代码块。

---

## ✨ 功能特性

- **多处右键直达**：
  - **项目侧边栏（Project View）**：支持单选文件、多选文件批量复制、单选文件夹递归复制。
  - **编辑器标签页（Editor Tab）**：在打开的文件 Tab 上右键一键复制代码。
  - **代码编辑区内（Editor Context）**：在代码区任意位置右键一键复制，最短操作路径。
- **所见即所得（Dirty Document First）**：
  - 优先读取当前编辑器中尚未保存（`Ctrl+S`）的最新修改内容，避免复制出磁盘旧代码。
- **智能 Markdown 包裹**：
  - 自动根据文件后缀识别语言（JavaScript、TypeScript、Python、Rust、Kotlin、Java、YAML、Go 等）。
  - 自适应反引号转义，防止复制 Markdown 时内层代码块截断外层语法。
  - 针对图片、音频、压缩包等二进制文件只输出路径标识，杜绝乱码污染剪贴板。
- **文件夹递归与 .gitignore 规则过滤**：
  - 级联解析项目根目录与子目录 `.gitignore` 规则，默认排除 `.git`、`node_modules`、`dist`、`build`、`.idea` 等。
  - 15MB 总大小保护机制，防止大文件溢出。
- **完整多语言支持（i18n）**：
  - 动作、菜单及通知气泡自动跟随 IDE 显示语言（官方简体中文语言包与默认英文环境）。

---

## 🚀 安装方法

### 从本地磁盘安装（Install Plugin from Disk）

1. 在当前目录或 Release 产物中获取 `block-clip-intellij-0.1.0.zip`。
2. 打开 **IntelliJ IDEA** 或 **WebStorm**。
3. 打开设置窗口（Windows/Linux: `Ctrl + Alt + S`，macOS: `Cmd + ,`）。
4. 进入 **Plugins（插件）** 页面。
5. 点击右上角的齿轮 ⚙️ 图标，选择 **Install Plugin from Disk...（从磁盘安装插件...）**。
6. 选择 `block-clip-intellij-0.1.0.zip` 并确认。
7. 根据提示重启 IDE（或即刻生效），即可在文件树、Tab 标签或编辑区右键使用！

---

## 🛠️ 构建与测试

在 `intellij-plugin` 目录下执行：

```bash
# 运行单元测试
./gradlew test

# 打包插件（产物位于 build/distributions/block-clip-intellij-0.1.0.zip）
./gradlew buildPlugin
```
