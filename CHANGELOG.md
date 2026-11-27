# Changelog

所有对本项目的显著更改都将记录在此文件中。
本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 规范。

## [0.5.6] - 2026-11-27

### 🏷️ 元数据更新 (Chore)
- 将 JetBrains 插件（`plugin.xml` / `build.gradle.kts`）、VS Code 扩展（`package.json` `author`）以及配套油猴脚本（`@author`）中的作者名称统一更新为 **六月的雨**。

---

## [0.5.5] - 2026-11-27

### 🐛 全仓深度代码审查修复与工程优化 (Bug Fixes & Optimizations)
- **【双端】大文件夹批量加入暂存栈升级为 $O(N)$ 去重 + 单次状态栏刷新**：
  - 修复原先逐条循环加锁、$O(N^2)$ 去重及向 UI 线程连续投递 $N$ 次状态栏重绘的性能问题。
  - 修复多选「文件夹 + 该文件夹内的文件」同时入栈时，提示气泡虚报重复文件数的计数错误。
- **【VS Code】状态栏文案国际化与单例生命周期修复**：
  - 状态栏文字接入 `l10n` 双语化（中文显示 `暂存栈: N`，英文显示 `Clip Stack: N`），与 JetBrains 端 100% 一致。
  - 在 `deactivate()` 中重置 `ClipStackManager` 单例，避免扩展热重载时持有已销毁的 `StatusBarItem`。
  - 将开发期文件 `commitlint.config.js` 加入 `.vscodeignore`，精简 `.vsix` 安装包内容。
- **【JetBrains】消除 `kotlin-stdlib` 捆绑冲突警告并瘦身插件包**：
  - 新增 `intellij-plugin/gradle.properties` 配置 `kotlin.stdlib.default.dependency=false`，消除平台 stdlib 冲突告警并大幅缩减 `.zip` 体积；清理 1 个未使用的 i18n 废弃键。
- **【CI / Release】强化发版流水线质量门禁**：
  - 移除 `.github/workflows/release.yaml` 中的冗余重复构建步骤，并在打正式发版包前强制执行双端全量单元测试。

---

## [0.5.4] - 2026-11-27

### ✨ 体验优化 (Enhancements)
- **【JetBrains】暂存栈管理器改为窗口正中央弹出**：
  - 点击右下角状态栏或通过右键菜单打开「管理暂存栈」时，弹窗统一使用 `showCenteredInCurrentWindow(project)` 居中显示在当前 IDE 窗口正中央（单页最多展示 15 条并支持滚动），彻底解决分屏或小窗口下从状态栏触发弹窗溢出窗口外部的问题。

---

## [0.5.3] - 2026-11-26

### ✨ 体验升级 (Features & Enhancements)
- **【VS Code】新增原生进度条与随时取消支持（与 JetBrains 100% 对齐）**：
  - 在「复制文件夹代码」、「批量复制多个文件」、「文件夹加入暂存栈」及「复制暂存栈全部代码」时，右下角自动弹出原生进度通知条（`vscode.window.withProgress`），实时显示扫描到的文件数量、读取进度百分比与当前处理文件名 `(current/total) fileName`。
  - 全程支持点击「取消」随时中止扫描或读取，取消后绝不覆盖剪贴板，也不会将未扫描完的半截内容写入暂存栈。
- **【JetBrains】后台进度条升级为精确百分比与即时取消**：
  - 文件夹扫描阶段实时展示已发现文件计数；读取与格式化阶段由不确定转圈升级为精确百分比进度条与 `(current/total) fileName` 实时提示，并在每个文件处理前响应取消指令。

---

## [0.5.2] - 2026-11-26

### 🐛 根因修复 (Bug Fixes)
- **【JetBrains】修复 IDEA / WebStorm（2024.3 ~ 2026.3）目录树右键菜单看不到「加入文件/文件夹到暂存栈」的问题**：
  - 将 `AddToStackAction` 与 `CopyCodeAction` 的 `getActionUpdateThread()` 修正为 `ActionUpdateThread.BGT`，解决新版 IntelliJ 平台在 EDT 线程无法读取 Project View 后台数据提供器提供的 `VIRTUAL_FILE_ARRAY` / `VIRTUAL_FILE` 从而导致菜单项隐藏的缺陷。
  - 修复 `ProjectViewPopupMenu` 菜单锚点：由已移入二级子菜单的 `CopyPaths` 改为标准顶层分组 `CutCopyPasteGroup` 之后，确保「复制文件代码 / 复制文件夹代码 / 代码暂存栈」稳定展示在复制区正下方；在目录树与标签页右键上下文中不再错误回退读取活动编辑器。

### ✨ 双端功能 100% 对齐升级 (Features & Parity)
- **【JetBrains】新增底部状态栏实时暂存栈计数指示器**：与 VS Code 状态栏完全对齐，暂存栈有内容时自动在底部状态栏实时显示条目数，点击即可在状态栏正上方展开暂存栈管理器，栈为空时不打扰界面。
- **【JetBrains】拆出独立的编辑器选区右键动作**：新增 `CopySelectionAction` 与 `AddSelectionToStackAction`，编辑器内选中代码右键时可同时看到「复制选中代码」与「复制文件代码」（以及「加入所选代码到暂存栈」与「加入当前文件到暂存栈」），快捷键 `Alt+Shift+B` / `Alt+Shift+S` 继续保留智能选区识别，与 VS Code 100% 一致。
- **【双端】支持目录树右键文件夹一键移出暂存栈**：在 VS Code 与 JetBrains 目录树中右键文件夹点击「从暂存栈移除文件/文件夹相关项」，可一次性移除该目录下所有已暂存的文件与代码片段（严格路径边界匹配，绝不误伤同名缀兄弟目录）。
- **【双端】细节 100% 对齐**：JetBrains 端 `CopyFolderCodeAction` 在无目录选中（如 Find Action）调用时自动回退至当前项目根目录；VS Code 端同步补齐默认忽略 `.DS_Store` 与二进制后缀 `war`/`ear`。

---

## [0.5.1] - 2026-11-24

### ✨ 新增特性 (Features)
- **【VS Code】原生支持复制工作区根文件夹代码**：
  - 在资源管理器左侧下方空白处右键，可直接点击 **“复制文件夹代码”** 复制整个项目根目录。
  - 从命令面板无参执行 **“复制文件夹代码”** 时自动回退到当前工作区根目录（多根工作区自动弹出选择列表）。

### 🐛 根因修复与稳定性增强 (Bug Fixes)
- **【双端】彻底根治 Windows 剪贴板遇 NUL (`\0`) 空字节被半路截断的问题**：
  - 采用与 Git 一致的内容级二进制探测机制：扩充常见数据库/缓存后缀黑名单（`.db`、`.sqlite`、`.ldb`、`.wal`、`.dat`、`.bin`、`.idx` 等），并对文件内容前 8KB 扫描 `0x00` 字节；JetBrains 端同步结合 `file.fileType.isBinary`（`ReadAction` 安全读取）。
  - 对于超过 8KB 的大文件，在判断大小上限与全量读盘之前先执行前 8KB 流式头探测，既零浪费内存，也杜绝超大未知后缀二进制文件误触发大小上限而中断后续源码复制。
  - 写入系统剪贴板前统一执行 `sanitizeForClipboard` 兜底清洗，彻底杜绝 Windows `CF_UNICODETEXT` 剪贴板在 `\0` 处截断后续全部代码。
- **【双端】尊重 IDE 目录树隐藏/排除目录及 `.git/info/exclude`**：
  - **JetBrains**：递归扫描文件夹时自动跳过 `FileTypeManager.isFileIgnored` 与 `ProjectFileIndex.isExcluded / isUnderIgnored` 隐藏或排除的目录（例如插件生成的本地数据与日志目录），并自动加载 `.git/info/exclude`；若用户主动右键某个 Excluded 目录本身，仍正常允许复制其内部文件。
  - **VS Code**：自动加载工作区 `files.exclude`（逐条容错隔离）及 `.git/info/exclude` 规则。
- **【VS Code】修复打开 Git Diff 对比视图时可能误读 `git:` 虚拟文档旧版内容的问题**：
  - 匹配内存中已打开文档时严格校验 `uri.scheme`，杜绝虚拟 Diff 文档污染真实文件读取。

---

## [0.5.0] - 2026-11-23

### ✨ 新增特性 (Features)
- **自定义复制文本大小上限（双端支持，默认升级为 50 MB）**：
  - **VS Code**：新增设置项 `blockClip.maxContentSizeMB`（默认 `50` MB，设为 `0` 表示不限制上限），修改后无需重启即时生效。
  - **JetBrains（IDEA / WebStorm）**：新增设置页面 **Settings -> Tools -> BlockClip**（默认 `50` MB，支持 `0` 不限制，中英文自动适配），持久化保存并实时生效。
  - 所有超限提示文案改为动态读取当前配置的 MB 上限，告别写死的 `15MB` 提示。
- **VS Code 支持未保存草稿（`untitled:`）**：新建尚未保存到磁盘的文件也可直接在编辑器或标签页右键复制与加入暂存栈。

### 🐛 全面代码审查与隐性 Bug 修复 (Bug Fixes)
- **【VS Code】修复生产打包污染与未压缩问题**：
  - 修复 `vscode:prepublish` 覆盖掉 `--production` 压缩产物的问题，并将 `tsc` 测试编译输出迁移至 `out/`，确保打包生成的 `.vsix` 仅包含精简压缩后的单文件 `dist/extension.js`（体积大幅缩减）。
- **【VS Code】修复 QuickPick 内存泄漏**：为暂存栈管理弹窗补充 `onDidHide(() => qp.dispose())`，按 Esc 或点击外部关闭时正确释放资源。
- **【双端】修复多选复制中首文件缺失导致的成功提示文件名错乱**：改用实际首个成功处理的文件名，避免误报已删除的文件名。
- **【JetBrains】修复大数值上限 32 位 `Int` 溢出风险**：所有文件长度与上限预算全面升级为 `Long`，即使配置 `2048 MB` 或无限制（`0`）也绝不溢出。
- **【JetBrains】修复 `.gitignore` 中 `**/dir` 模式无法匹配根目录同名目录的正则缺陷**。

---

## [0.4.1] - 2026-11-22

### 🐛 全面稳定性与隐性 Bug 修复 (Bug Fixes)
- **【JetBrains】修复暂存栈管理弹窗无法展开二级“跳转 / 删除”子菜单**：
  - 补全 `BaseListPopupStep.hasSubstep` 覆写，移除过期的 `AnActionEvent` 复用，并增加失效文件（`isValid`）校验防止删除文件后跳转崩溃。
- **【JetBrains】修复线程模型违规与主线程阻塞**：
  - 修正 `CopyCodeAction` / `AddToStackAction` 在 BGT 线程访问 `Editor.selectionModel` 的问题（改为纯内存 EDT 更新）。
  - 将 `CopyCodeAction` 与 `CopyStackAction` 的磁盘读取迁入后台进度任务（`Task.Backgroundable`），大批量复制不再阻塞 UI。
  - 修复 `RemoveFromStackAction` 编辑器回退获取文件与多选移除支持，并统一数值格式化使用 `Locale.US` 避免地区小数点差异。
- **【VS Code】修复软链接（Symlink）文件漏扫与异常防护**：
  - 所有 `FileType` 判断改为位掩码匹配，支持 pnpm / Monorepo 中的软链接文件，并增加 `realpath` 防循环软链保护；为 `addToStack` 补齐 `try/catch` 与 `Promise.allSettled` 容错。
  - 拆分独立的“加入选中代码到暂存栈”菜单项（仅在编辑器有选区时显示），彻底消除在侧边栏/Tab 右键活动文件时误抓选区的歧义。
  - 修复多根工作区（Multi-root Workspace）多选文件时的跨根路径计算问题，以及 Windows 盘符大小写差异导致的去重/脏文档匹配问题。
- **【双端】修复多层级 `.gitignore` 规则基准错位与正则缺陷**：
  - 每层 `.gitignore`（根目录、中间目录、递归子目录）均严格以其所在目录为基准路径匹配，彻底修复根目录带路径前缀规则在子目录失效的问题；补齐 JetBrains 正则 `[`、`]`、`\` 转义与目录子路径匹配。
- **【双端】修复超大单文件与已删除文件边缘场景**：
  - 读取文件前先预检物理体积（`stat.size` / `file.length`），避免 200MB 大文件被整份读入内存；若无可复制内容（`processedCount == 0`），绝不覆盖清空用户剪贴板。
  - 暂存栈中已被删除的文件会自动跳过，不再输出虚假的空代码块。
  - 修复 `Dockerfile`、`Dockerfile.*`、`Makefile`、`CMakeLists.txt` 等无后缀文件的 Markdown 语言识别。

---

## [0.4.0] - 2026-11-21

### ✨ 体验升级 (Features & Enhancements)
- **全键盘快捷键支持（双端统一）**：
  - `Alt + Shift + B`：一键复制当前文件（若编辑器内有选区，自动直接复制选中代码片段）。
  - `Alt + Shift + S`：一键将当前文件或选中代码加入暂存栈。
  - `Alt + Shift + X`：一键复制暂存栈中全部代码（配合配套油猴脚本 `Alt + Shift + Z` 可实现全左手键盘闭环）。
- **选中代码片段直接复制**：
  - 在代码编辑区选中任意代码后，右键直接提供“**复制选中代码**”入口，无需绕道暂存栈即可携带相对路径与精确行号一键复制。
- **复制暂存栈后气泡附带「清空暂存栈」按钮**：
  - 复制全栈代码成功后，右下角提示通知直接附带一键清空按钮，需要复用就忽略，想开启新一轮收集随手一点即可清空。
- **体积与粗略 Token 估算反馈**：
  - 每次复制成功均在通知中展示总字节数与粗略 Token 估算（如 `12.4 KB, ~3.1k tokens`），向 AI 提问前心里更有数。
- **文件夹直接加入暂存栈 & 敏感文件默认防护**：
  - 支持在文件树中对文件夹右键“加入暂存栈”，自动递归收集非忽略文件与单文件混搭。
  - 递归扫描文件夹时自动排除常见敏感文件（如 `.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa` 等，同时保留 `.env.example` / `.env.sample` / `.env.template` 等安全模板）。

### 🐛 稳定性与细节修复 (Bug Fixes)
- **修复选区跨归属误抓取问题**：在侧边栏或非活动标签页右键触发入栈/复制时，不再受当前活动编辑器遗留高亮选区的干扰。
- **修复选区行号 Off-by-one 问题**：拖选整行时若光标停在下一行第 0 列，不再错误多算 1 行。
- **JetBrains 端后台线程与行号跳转修复**：
  - 文件夹递归复制与文件夹入栈全部迁移至后台进度任务（`Task.Backgroundable` + `ReadAction`），大目录不再卡顿 UI 且兼容新版 IDE 严格线程检测。
  - 暂存栈管理弹窗点击跳转到代码片段时，现可精准滚动定位到片段起始行号。

---

## [0.3.0] - 2026-11-19

### ✨ 重磅新特性：代码暂存栈 (Clip Stack)
- **支持全文件与部分代码片段入栈**:
  - 在编辑器中选定任意代码块，右键一键“加入暂存栈 (选定代码)”，自动记录并标注行号（如 `lines 10-25`）；未选定代码时默认添加完整文件。
  - 支持在同一文件中多次摘取不同片段，保持上下文清晰。
- **一键合并导出**:
  - 支持一键将暂存栈中所有收集的代码（全文件及片段混合）按标准 Markdown 代码块与自适应反引号格式复制到剪贴板。
- **灵活的精准移除机制**:
  - 提供 **撤销上一条 (Pop Last Item)**：栈顶快速回滚。
  - 提供 **从暂存栈移除当前文件相关项**：一键清除当前文件全部记录。
  - 提供 **可视化交互管理 (Manage Stack)**：弹出清单列表，支持单条精准删除或点击跳转定位代码行。
  - 提供 **一键清空暂存栈**。
- **双端状态感知**:
  - VS Code 底部状态栏与 JetBrains 菜单动态显示当前暂存条目数，一目了然。

---

## [0.2.0] - 2026-11-19

### ✨ 新增平台支持 (Platform Support)
- **新增 JetBrains 平台插件支持 (IntelliJ IDEA & WebStorm)**:
  - 100% 对齐 VS Code 版所有特性，兼容 IntelliJ IDEA、WebStorm、PyCharm、GoLand、CLion 等全系列 JetBrains IDE。
  - 支持在项目文件树（Project View）、编辑器标签页（Editor Tab）、代码编辑区内右键菜单快捷复制。
  - 支持未保存内容优先读取（Dirty Document First）、自适应反引号防截断、常见语言规范映射与二进制文件过滤。
  - 支持文件夹递归复制代码与多层级 `.gitignore` 规则过滤（含 15MB 溢出保护）。
  - 支持完整多语言国际化（英文与官方简体中文语言包自动适配）。

---

## [0.1.0] - 2026-11-15

### ✨ 新增特性 (Features)
- **多语言国际化 (i18n / l10n)**:
  - 完整接入 VS Code 原生本地化体系，命令、菜单及提示文案根据 VS Code 界面语言自动切换（支持简体中文与英文）。
- **文件标签页（Tab）与编辑器内右键菜单支持**:
  - 新增在编辑器上方文件 Tab 标签及代码区任意位置右键点击“复制文件代码”的功能，操作更加便捷。
- **活动编辑器降级获取**:
  - 支持直接在当前活动编辑器中调用命令，免去必须在资源管理器选中的限制。

### ⚡ 体验与稳定性优化 (Improvements & Optimizations)
- **所见即所得（Dirty Document First）**:
  - 复制文件时优先获取内存中尚未保存的最新编辑内容，避免因未保存导致复制出磁盘旧代码。
- **项目根目录与子目录 `.gitignore` 规则级联**:
  - 修复右键子文件夹时无法识别项目根目录 `.gitignore` 的问题，确保无论在哪个层级触发均能准确过滤忽略文件。
- **Markdown 代码块反引号动态转义**:
  - 自适应根据文件内部代码块反引号数量增加外层反引号，防止输出至 Markdown / AI 时语法截断。
- **常用语言扩展名规范映射**:
  - 增加常见文件后缀（Python、Rust、Bash、YAML、Markdown 等）到标准语言 ID 的映射，保证代码高亮渲染准确。

---

## [0.0.2] - 2025-02-09

### 初始发布
- 支持在 VS Code 侧边栏资源管理器右键复制单个文件与多个文件代码。
- 支持右键文件夹递归复制所有文件内容。
- 自动识别工作区相对路径并包裹为 Markdown 格式输出。
