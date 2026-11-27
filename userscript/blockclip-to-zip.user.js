// ==UserScript==
// @name         BlockClip to ZIP for Gemini & AI Studio (丝滑无闪烁 Pro)
// @namespace    https://github.com/symudo/block-clip
// @version      3.1.1
// @description  将 BlockClip 复制的代码还原为目录层级并打包为 ZIP（或单文件 Markdown 附件），内置原生流式 DEFLATE 压缩引擎(零CDN/彻底修复沙箱卡死)，融合【工具栏内嵌秒传】+【全程可视化进度 HUD】+【粘贴无闪烁/原生Input/自动兜底】+【聊天框自动转附件】+【侧边栏与面板上下自由拖动】，100% 兼容 Chrome/Edge/Firefox 与 Trusted Types
// @author       六月的雨
// @license      MIT
// @match        *://gemini.google.com/*
// @match        *://aistudio.google.com/*
// @match        *://ai.dev/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=gemini.google.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_getClipboard
// @grant        GM.getClipboard
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

;(() => {
  if (window.top !== window.self) return

  const HOST_ID = 'blockclip-to-zip-root'
  const INLINE_BTN_ID = 'blockclip-paste-as-zip-btn'
  if (document.getElementById(HOST_ID)) return

  const STORAGE_KEY = 'blockclip_to_zip_prefs_v3'
  const LARGE_TEXT_THRESHOLD = 250 * 1024
  const SINGLE_FILE_INTERCEPT_MIN_CHARS = 4096
  const PREVIEW_CHAR_LIMIT = 2400
  const SINGLE_MODE_VERIFY_MS = 850
  const PRIMARY_TIMEOUT_MS = 1200
  const FALLBACK_TIMEOUT_MS = 650
  const POST_INJECT_CLEANUP_MS = 800
  const SWEEP_MS = 2500
  const OBSERVER_THROTTLE_MS = 250
  const FAILED_SLOT_BASE_COOLDOWN_MS = 3000
  const FAILED_SLOT_MAX_COOLDOWN_MS = 60000
  const DRAG_THRESHOLD_PX = 5
  const ZIP_MAX_ENTRIES = 65535
  const ZIP_MAX_UINT32 = 0xffffffff

  const IS_GEMINI = location.hostname.includes('gemini.google.com')
  const IS_AISTUDIO = !IS_GEMINI
  const IS_FIREFOX = /firefox/i.test(navigator.userAgent)

  const rawWin =
    (typeof unsafeWindow !== 'undefined' && (unsafeWindow.wrappedJSObject || unsafeWindow)) ||
    window.wrappedJSObject ||
    window
  const unwrap = (el) => (el?.wrappedJSObject ? el.wrappedJSObject : el)
  const SHARED_ENCODER = new TextEncoder()

  const VALID_UPLOAD_MODES = new Set(['paste', 'input', 'auto'])
  const VALID_EXPORT_MODES = new Set(['zip', 'single_md'])

  const DEFAULT_PREFS = {
    uploadMode: 'paste',
    exportMode: 'zip',
    autoPackOnPaste: true,
    skipBinaryPlaceholders: true,
    autoCloseAfterInject: true,
    autoInterceptChatPaste: false,
    sideTabTopPct: 56,
    panelTopPct: 50,
    floatingBtnTopPct: 78
  }

  function clampNumber(val, min, max, fallback) {
    const n = Number(val)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }

  function sanitizePrefs(rawObj) {
    const src = rawObj && typeof rawObj === 'object' && !Array.isArray(rawObj) ? rawObj : {}
    return {
      uploadMode: VALID_UPLOAD_MODES.has(src.uploadMode) ? src.uploadMode : DEFAULT_PREFS.uploadMode,
      exportMode: VALID_EXPORT_MODES.has(src.exportMode) ? src.exportMode : DEFAULT_PREFS.exportMode,
      autoPackOnPaste: typeof src.autoPackOnPaste === 'boolean' ? src.autoPackOnPaste : DEFAULT_PREFS.autoPackOnPaste,
      skipBinaryPlaceholders:
        typeof src.skipBinaryPlaceholders === 'boolean'
          ? src.skipBinaryPlaceholders
          : DEFAULT_PREFS.skipBinaryPlaceholders,
      autoCloseAfterInject:
        typeof src.autoCloseAfterInject === 'boolean' ? src.autoCloseAfterInject : DEFAULT_PREFS.autoCloseAfterInject,
      autoInterceptChatPaste:
        typeof src.autoInterceptChatPaste === 'boolean'
          ? src.autoInterceptChatPaste
          : DEFAULT_PREFS.autoInterceptChatPaste,
      sideTabTopPct: clampNumber(src.sideTabTopPct, 5, 95, DEFAULT_PREFS.sideTabTopPct),
      panelTopPct: clampNumber(src.panelTopPct, 5, 95, DEFAULT_PREFS.panelTopPct),
      floatingBtnTopPct: clampNumber(src.floatingBtnTopPct, 5, 95, DEFAULT_PREFS.floatingBtnTopPct)
    }
  }

  function loadPrefs() {
    try {
      let raw = typeof GM_getValue === 'function' ? GM_getValue(STORAGE_KEY, null) : null
      if (!raw) raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return { ...DEFAULT_PREFS }
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      return sanitizePrefs(parsed)
    } catch {
      return { ...DEFAULT_PREFS }
    }
  }

  function savePrefs(p) {
    try {
      const serialized = JSON.stringify(sanitizePrefs(p))
      if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY, serialized)
      localStorage.setItem(STORAGE_KEY, serialized)
    } catch {}
  }

  const prefs = loadPrefs()

  const BOOL_PROPS = new Set(['disabled', 'checked', 'readOnly', 'hidden', 'multiple', 'selected'])

  function safeEl(tag, props, ...children) {
    const el = document.createElement(tag)
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (val === undefined || val === null) continue
        if (key === 'className') el.className = val
        else if (key === 'style' && typeof val === 'object') Object.assign(el.style, val)
        else if (key === 'dataset' && typeof val === 'object') Object.assign(el.dataset, val)
        else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val)
        else if (key === 'textContent') el.textContent = String(val)
        else if (key === 'value') el.value = String(val)
        else if (BOOL_PROPS.has(key)) el[key] = Boolean(val)
        else el.setAttribute(key, String(val))
      }
    }
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue
      if (typeof child === 'string' || typeof child === 'number') {
        el.appendChild(document.createTextNode(String(child)))
      } else if (child instanceof Node) {
        el.appendChild(child)
      } else if (Array.isArray(child)) {
        for (const item of child) {
          if (item instanceof Node) el.appendChild(item)
          else if (item !== undefined && item !== null && item !== false) {
            el.appendChild(document.createTextNode(String(item)))
          }
        }
      }
    }
    return el
  }

  function nextPaint() {
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      const fallback = setTimeout(finish, 50)
      requestAnimationFrame(() => {
        clearTimeout(fallback)
        setTimeout(finish, 0)
      })
    })
  }

  function encodeUtf8(str) {
    return SHARED_ENCODER.encode(str)
  }

  function utf8ByteLength(str) {
    if (!str) return 0
    let bytes = 0
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i)
      if (code < 0x80) {
        bytes += 1
      } else if (code < 0x800) {
        bytes += 2
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        const next = str.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4
          i++
        } else {
          bytes += 3
        }
      } else {
        bytes += 3
      }
    }
    return bytes
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
    return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`
  }

  function isVisibleOnce(el) {
    if (!el || !el.isConnected) return false
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    try {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false
      if (parseFloat(cs.opacity) <= 0.01) return false
    } catch {}
    return true
  }

  function firstVisible(selectors, excludeSelector = null, root = document) {
    for (const sel of selectors) {
      const nodes = root.querySelectorAll(sel)
      for (const node of nodes) {
        if (excludeSelector && node.closest(excludeSelector)) continue
        if (isVisibleOnce(node)) return node
      }
    }
    return null
  }

  function lastVisible(selectors, excludeSelector = null, root = document) {
    for (const sel of selectors) {
      const nodes = root.querySelectorAll(sel)
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i]
        if (excludeSelector && node.closest(excludeSelector)) continue
        if (isVisibleOnce(node)) return node
      }
    }
    return null
  }

  function querySelectorAllDeep(selector, root = document, results = []) {
    try {
      const matched = root.querySelectorAll(selector)
      for (const node of matched) results.push(node)
    } catch {}
    const all = root.querySelectorAll('*')
    for (const el of all) {
      if (el.id === HOST_ID) continue
      if (el.shadowRoot) querySelectorAllDeep(selector, el.shadowRoot, results)
    }
    return results
  }

  const ADAPTERS = {
    gemini: {
      defaultStrategy: 'paste',
      findEditor: () => {
        const selectors = [
          'div.ql-editor[role="textbox"]',
          'rich-textarea div[contenteditable="true"]',
          'div[contenteditable="true"][role="textbox"]'
        ]
        const active = document.activeElement
        if (active && isVisibleOnce(active) && selectors.some((s) => active.matches?.(s))) return active
        return lastVisible(selectors)
      },
      findSlot: () => {
        const trailing = firstVisible(['.trailing-actions-wrapper', '.input-buttons-wrapper-right'])
        if (trailing) return { parent: trailing, before: trailing.firstElementChild }
        const leading = firstVisible(['.leading-actions-wrapper', '.leading-actions'])
        if (leading) return { parent: leading, before: null }
        const old = firstVisible(['.input-area-container .send-button-container'])
        if (old) return { parent: old, before: old.firstElementChild }
        return null
      },
      findUploadScope: (editor) => {
        const explicit =
          editor.closest('input-container') || editor.closest('.input-area-container') || editor.closest('form')
        if (explicit) return explicit
        let el = editor
        for (let i = 0; i < 5 && el.parentElement; i++) {
          if (el.parentElement === document.body || el.parentElement.tagName === 'MAIN') break
          el = el.parentElement
        }
        return el || document.body
      }
    },
    aistudio: {
      defaultStrategy: 'paste',
      findEditor: () => {
        const selectors = [
          'ms-prompt-box textarea',
          'ms-prompt-input-wrapper textarea',
          'footer ms-autosize-textarea textarea',
          'textarea[aria-label="Enter a prompt"]',
          'textarea[aria-label="Type something"]',
          'textarea[formcontrolname="promptText"]',
          'ms-prompt-box div[contenteditable="true"]',
          'ms-chunk-input textarea'
        ]
        const active = document.activeElement
        if (
          active &&
          isVisibleOnce(active) &&
          !active.closest('ms-system-instructions') &&
          selectors.some((s) => active.matches?.(s))
        ) {
          return active
        }
        return lastVisible(selectors, 'ms-system-instructions')
      },
      findSlot: () => {
        const root = firstVisible(['ms-prompt-box', 'ms-prompt-input-wrapper']) || document
        const runBtn = firstVisible(['ms-run-button', 'button.run-button[aria-label="Run"]'], null, root)
        if (runBtn) {
          const runWrapper = runBtn.closest('.button-wrapper') || runBtn
          if (runWrapper.parentElement && isVisibleOnce(runWrapper.parentElement)) {
            return { parent: runWrapper.parentElement, before: runWrapper }
          }
        }
        const addMenu = firstVisible(['ms-add-chunk-menu'], null, root)
        if (addMenu) {
          const addWrapper = addMenu.closest('.button-wrapper') || addMenu
          if (addWrapper.parentElement && isVisibleOnce(addWrapper.parentElement)) {
            return { parent: addWrapper.parentElement, before: addWrapper }
          }
        }
        const fallbackBar = firstVisible(
          ['.actions-wrapper', '.right-side', '.prompt-input-wrapper-container'],
          null,
          root
        )
        if (fallbackBar) return { parent: fallbackBar, before: fallbackBar.lastElementChild }
        return null
      },
      findUploadScope: (editor) =>
        editor.closest('ms-prompt-box') ||
        editor.closest('ms-prompt-input-wrapper') ||
        editor.closest('ms-chunk-input') ||
        editor.closest('footer') ||
        editor.closest('ms-chunk-editor') ||
        document.body
    }
  }

  const SITE = IS_GEMINI ? ADAPTERS.gemini : ADAPTERS.aistudio
  let preferredStrategy = SITE.defaultStrategy

  function parseBgLuma(el) {
    if (!el) return null
    try {
      const bg = getComputedStyle(el).backgroundColor
      const m = bg.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i)
      if (m) {
        let alpha = 1
        if (m[4] !== undefined) {
          alpha = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
        }
        if (alpha > 0.1) return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])
      }
    } catch {}
    return null
  }

  function isPageDark() {
    const root = document.documentElement
    const body = document.body
    for (const el of [body, root]) {
      if (!el) continue
      const cls = typeof el.className === 'string' ? el.className.toLowerCase().trim() : ''
      if (cls) {
        const tokens = cls.split(/\s+/)
        if (tokens.includes('dark-theme') || tokens.includes('theme-dark') || tokens.includes('dark')) return true
        if (tokens.includes('light-theme') || tokens.includes('theme-light')) return false
      }
      const dataTheme = (el.getAttribute('data-theme') || el.getAttribute('data-color-scheme') || '').toLowerCase()
      if (dataTheme === 'dark') return true
      if (dataTheme === 'light') return false
    }
    for (const el of [body, root]) {
      if (!el) continue
      try {
        const cs = (getComputedStyle(el).colorScheme || '').trim().toLowerCase()
        if (cs === 'dark') return true
        if (cs === 'light') return false
      } catch {}
    }
    for (const el of [body, root, document.querySelector('chat-app, ms-app, main')]) {
      const luma = parseBgLuma(el)
      if (luma !== null) return luma < 128
    }
    return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  }

  async function readClipboardActive() {
    let lastErr = null
    if (typeof GM !== 'undefined' && typeof GM.getClipboard === 'function') {
      try {
        const res = await GM.getClipboard('text/plain')
        if (typeof res === 'string') return res
      } catch (err) {
        lastErr = err
      }
    }
    if (typeof GM_getClipboard === 'function') {
      try {
        const res = await GM_getClipboard('text/plain')
        if (typeof res === 'string') return res
      } catch (err) {
        lastErr = err
      }
    }
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      try {
        return await navigator.clipboard.readText()
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr || new DOMException('NO_CLIPBOARD_API', 'NotAllowedError')
  }

  const FILE_HEADER_REGEX = /^File:\s*(.+?)(?:\s*\((lines?\s*[\d\s,-]+)\))?\s*$/i
  const FENCE_START_REGEX = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/

  function normalizePath(filePath) {
    if (!filePath) return ''
    let normalized = String(filePath).trim()
    if (
      normalized.length >= 2 &&
      normalized[0] === normalized[normalized.length - 1] &&
      (normalized[0] === '`' || normalized[0] === '"' || normalized[0] === "'")
    ) {
      normalized = normalized.slice(1, -1).trim()
    }
    normalized = normalized.replace(/\\/g, '/').replace(/^[a-zA-Z]:\/+/, '')
    const segments = []
    for (const rawSeg of normalized.split('/')) {
      const seg = rawSeg.trim()
      if (!seg || seg === '.') continue
      if (seg === '..') {
        if (segments.length > 0) segments.pop()
        continue
      }
      const cleaned = seg.replace(/[\p{Cc}<>:"|?*]/gu, '_')
      if (cleaned && cleaned !== '.' && cleaned !== '..') segments.push(cleaned)
    }
    return segments.join('/')
  }

  function estimateBlockClipForChat(text) {
    if (!text || text.length < 24 || !/file:/i.test(text)) return { match: false, estimatedFiles: 0 }
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    if (!/^ {0,3}(`{3,}|~{3,})/m.test(clean)) return { match: false, estimatedFiles: 0 }

    const headerRe = /^File:\s*(.+?)(?:\s*\((lines?\s*[\d\s,-]+)\))?\s*$/gim
    const uniquePaths = new Set()
    let headerCount = 0
    for (const m of clean.matchAll(headerRe)) {
      headerCount++
      const p = normalizePath(m[1])
      if (p) uniquePaths.add(p)
    }

    if (headerCount >= 2 && uniquePaths.size >= 1) {
      return { match: true, estimatedFiles: uniquePaths.size }
    }

    if (headerCount === 1 && uniquePaths.size === 1 && clean.length >= SINGLE_FILE_INTERCEPT_MIN_CHARS) {
      const firstLine = clean.trimStart().split(/\r?\n/, 1)[0] || ''
      if (FILE_HEADER_REGEX.test(firstLine)) {
        return { match: true, estimatedFiles: 1 }
      }
    }

    return { match: false, estimatedFiles: 0 }
  }

  function parseBlockClipText(rawText) {
    if (!rawText || !rawText.trim()) return []
    const normalizedText = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    const lines = normalizedText.split('\n')
    const results = []
    let currentFile = null
    let inCodeBlock = false
    let fenceEndRegex = null
    let codeLines = []

    function finalizeCurrentFile() {
      if (!currentFile || !currentFile.relativePath) {
        currentFile = null
        inCodeBlock = false
        fenceEndRegex = null
        codeLines = []
        return
      }
      const cleanPath = normalizePath(currentFile.relativePath)
      if (cleanPath) {
        results.push({
          relativePath: cleanPath,
          lineRange: currentFile.lineRange,
          language: currentFile.language || 'plaintext',
          content: codeLines.join('\n'),
          isBinary: Boolean(currentFile.isBinary)
        })
      }
      currentFile = null
      inCodeBlock = false
      fenceEndRegex = null
      codeLines = []
    }

    function nextNonEmptyLine(startIdx) {
      for (let j = startIdx; j < lines.length; j++) {
        if (lines[j].trim() !== '') return lines[j]
      }
      return null
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (inCodeBlock) {
        if (fenceEndRegex?.test(line)) finalizeCurrentFile()
        else codeLines.push(line)
        continue
      }
      const fileMatch = line.match(FILE_HEADER_REGEX)
      if (fileMatch) {
        if (currentFile) {
          if (!currentFile.hasCodeBlock) currentFile.isBinary = true
          finalizeCurrentFile()
        }
        currentFile = {
          relativePath: fileMatch[1].trim(),
          lineRange: fileMatch[2] ? fileMatch[2].trim() : undefined,
          language: 'plaintext',
          isBinary: false,
          hasCodeBlock: false
        }
        continue
      }
      if (currentFile) {
        const fenceMatch = line.match(FENCE_START_REGEX)
        if (fenceMatch) {
          const fenceStr = fenceMatch[1]
          const infoStr = (fenceMatch[2] || '').trim()
          if (fenceStr[0] === '`' && infoStr.includes('`')) continue
          const fenceChar = fenceStr[0] === '`' ? '`' : '~'
          fenceEndRegex = new RegExp(`^ {0,3}${fenceChar}{${fenceStr.length},}\\s*$`)
          const langToken = infoStr ? infoStr.split(/\s+/)[0] : 'plaintext'
          currentFile.language = langToken || 'plaintext'
          currentFile.hasCodeBlock = true
          inCodeBlock = true
          codeLines = []
          continue
        }
        if (line.trim() === '---') {
          const upcoming = nextNonEmptyLine(i + 1)
          if (upcoming && FENCE_START_REGEX.test(upcoming)) continue
          currentFile.isBinary = true
          finalizeCurrentFile()
        }
      }
    }
    if (currentFile) {
      if (!inCodeBlock && !currentFile.hasCodeBlock) currentFile.isBinary = true
      finalizeCurrentFile()
    }
    return results
  }

  const HASH_COMMENT_EXACT = new Set([
    'dockerfile',
    'makefile',
    'gnumakefile',
    'jenkinsfile',
    '.gitignore',
    '.dockerignore',
    '.env'
  ])
  const HASH_COMMENT_LANGS = new Set([
    'py',
    'pyi',
    'python',
    'sh',
    'bash',
    'zsh',
    'fish',
    'shell',
    'yaml',
    'yml',
    'rb',
    'ruby',
    'pl',
    'perl',
    'r',
    'toml',
    'ini',
    'conf',
    'cfg',
    'properties',
    'ps1',
    'powershell',
    'tf',
    'hcl',
    'dockerfile',
    'makefile'
  ])
  const HTML_COMMENT_LANGS = new Set(['html', 'htm', 'xml', 'svg', 'vue', 'svelte', 'md', 'markdown'])
  const DASH_COMMENT_LANGS = new Set(['sql', 'lua', 'hs', 'haskell', 'elm'])
  const BLOCK_COMMENT_LANGS = new Set(['css', 'scss', 'less'])

  function getCommentBlock(relativePath, language, commentText) {
    const baseName = (relativePath.split('/').pop() || '').toLowerCase()
    const dotIdx = baseName.lastIndexOf('.')
    const ext = dotIdx > 0 ? baseName.slice(dotIdx + 1) : ''
    const key = ext || (language || '').toLowerCase()

    if (
      HASH_COMMENT_EXACT.has(baseName) ||
      baseName.startsWith('dockerfile.') ||
      baseName.startsWith('.env.') ||
      HASH_COMMENT_LANGS.has(key)
    ) {
      return `# ==================== ${commentText} ====================`
    }
    if (HTML_COMMENT_LANGS.has(key)) return `<!-- ==================== ${commentText} ==================== -->`
    if (DASH_COMMENT_LANGS.has(key)) return `-- ==================== ${commentText} ====================`
    if (BLOCK_COMMENT_LANGS.has(key)) return `/* ==================== ${commentText} ==================== */`
    if (key === 'bat' || key === 'cmd') return `REM ==================== ${commentText} ====================`
    return `// ==================== ${commentText} ====================`
  }

  const CODE_SOURCE_EXTS = new Set([
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'py',
    'pyi',
    'java',
    'kt',
    'kts',
    'go',
    'rs',
    'c',
    'cc',
    'cpp',
    'cxx',
    'h',
    'hh',
    'hpp',
    'cs',
    'php',
    'rb',
    'swift',
    'scala',
    'dart',
    'vue',
    'svelte',
    'astro',
    'css',
    'scss',
    'sass',
    'less',
    'html',
    'htm',
    'md',
    'markdown',
    'sql'
  ])

  function isSensitiveFile(relativePath) {
    const lower = relativePath.toLowerCase()
    const base = lower.split('/').pop() || ''
    if (/^\.env(\..+)?$/.test(base)) return !/\.(example|sample|template|dist)$/.test(base)
    if (/\.(pem|key|p12|pfx|jks|keystore|kdbx)$/.test(base)) return true
    if (/^(id_rsa|id_ed25519|id_ecdsa|id_dsa|\.npmrc|\.pypirc|\.netrc|\.htpasswd)$/.test(base)) return true
    if (
      /(secret|credential|private[_-]?key)/.test(base) &&
      !/(\.example|\.sample|\.template|\.mock|\.test\.|\.spec\.)/.test(base)
    ) {
      const dotIdx = base.lastIndexOf('.')
      const ext = dotIdx > 0 ? base.slice(dotIdx + 1) : ''
      if (!ext || !CODE_SOURCE_EXTS.has(ext)) return true
    }
    return false
  }

  function mergeParsedFiles(files) {
    const fileMap = new Map()
    for (const file of files) {
      if (!file.relativePath) continue
      const existing = fileMap.get(file.relativePath)
      if (!existing) {
        fileMap.set(file.relativePath, {
          language: file.language || 'plaintext',
          snippets: [{ lineRange: file.lineRange, content: file.content }],
          isBinary: file.isBinary
        })
      } else {
        existing.snippets.push({ lineRange: file.lineRange, content: file.content })
        if (!file.isBinary) existing.isBinary = false
        if (existing.language === 'plaintext' && file.language && file.language !== 'plaintext') {
          existing.language = file.language
        }
      }
    }

    const mergedList = []
    for (const [relativePath, data] of fileMap.entries()) {
      if (data.isBinary && data.snippets.every((s) => !s.content)) {
        mergedList.push({
          relativePath,
          language: data.language,
          content: '',
          byteSize: 0,
          isBinary: true,
          isSensitive: isSensitiveFile(relativePath),
          snippetsCount: data.snippets.length,
          selected: true
        })
        continue
      }

      let content = ''
      if (data.snippets.length === 1 && !data.snippets[0].lineRange) {
        content = data.snippets[0].content
      } else {
        const sections = []
        for (const snippet of data.snippets) {
          if (snippet.lineRange) {
            sections.push(
              `${getCommentBlock(relativePath, data.language, `BlockClip Snippet (${snippet.lineRange})`)}\n${snippet.content}`
            )
          } else {
            sections.push(snippet.content)
          }
        }
        content = sections.join('\n\n')
      }

      mergedList.push({
        relativePath,
        language: data.language,
        content,
        byteSize: utf8ByteLength(content),
        isBinary: false,
        isSensitive: isSensitiveFile(relativePath),
        snippetsCount: data.snippets.length,
        selected: true
      })
    }

    const dirPrefixes = new Set()
    const usedPaths = new Set()
    for (const item of mergedList) {
      usedPaths.add(item.relativePath)
      const parts = item.relativePath.split('/')
      for (let i = 1; i < parts.length; i++) dirPrefixes.add(parts.slice(0, i).join('/'))
    }
    for (const item of mergedList) {
      if (dirPrefixes.has(item.relativePath)) {
        usedPaths.delete(item.relativePath)
        let candidate = `${item.relativePath}_file`
        let seq = 2
        while (dirPrefixes.has(candidate) || usedPaths.has(candidate)) {
          candidate = `${item.relativePath}_file_${seq++}`
        }
        item.relativePath = candidate
        usedPaths.add(candidate)
      }
    }

    mergedList.sort((a, b) => {
      const aParts = a.relativePath.split('/')
      const bParts = b.relativePath.split('/')
      const minLen = Math.min(aParts.length, bParts.length)
      for (let i = 0; i < minLen; i++) {
        const aIsDir = i < aParts.length - 1
        const bIsDir = i < bParts.length - 1
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
        const cmp = aParts[i].localeCompare(bParts[i], undefined, { numeric: true, sensitivity: 'base' })
        if (cmp !== 0) return cmp
      }
      return aParts.length - bParts.length
    })

    return mergedList
  }

  let lastStamp = ''
  let sameSecondSeq = 0

  function inferSmartFilename(files, ext, customName = '') {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const stamp = `${datePart}_${timePart}`

    if (stamp === lastStamp) sameSecondSeq += 1
    else {
      lastStamp = stamp
      sameSecondSeq = 1
    }
    const timeStem = `${timePart}${sameSecondSeq > 1 ? `_${sameSecondSeq}` : ''}`

    const cleanedCustom = String(customName || '')
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.(zip|md|txt)$/i, '')
    if (cleanedCustom) return { name: `${cleanedCustom}.${ext}`, timeStem: '' }

    if (files.length > 0) {
      const topDirs = new Set()
      let allInSubdir = true
      for (const f of files) {
        const slashIdx = f.relativePath.indexOf('/')
        if (slashIdx === -1) {
          allInSubdir = false
          break
        }
        topDirs.add(f.relativePath.slice(0, slashIdx))
      }
      if (allInSubdir && topDirs.size === 1) {
        const rootName = Array.from(topDirs)[0].replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_')
        if (rootName && rootName.length <= 40) return { name: `${rootName}_${timeStem}.${ext}`, timeStem }
      }
    }
    return { name: `blockclip_${datePart}_${timeStem}.${ext}`, timeStem }
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c >>> 0
    }
    return table
  })()

  function computeCrc32(bytes) {
    let crc = 0xffffffff
    for (let i = 0; i < bytes.length; i++) crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }

  let deflateRawAvailable = typeof CompressionStream === 'function' && typeof Response === 'function'
  let deflateEverSucceeded = false
  let deflateConsecutiveFailures = 0

  async function tryDeflateRaw(bytes) {
    if (!deflateRawAvailable || bytes.length < 64) return null
    let cs
    try {
      cs = new CompressionStream('deflate-raw')
    } catch {
      deflateRawAvailable = false
      return null
    }
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(cs)
      const buf = await new Response(stream).arrayBuffer()
      const out = new Uint8Array(buf)
      deflateEverSucceeded = true
      deflateConsecutiveFailures = 0
      return out.length > 0 && out.length < bytes.length ? out : null
    } catch {
      deflateConsecutiveFailures += 1
      if (!deflateEverSucceeded && deflateConsecutiveFailures >= 3) deflateRawAvailable = false
      return null
    }
  }

  async function createNativeZipBlob(items, onProgress, shouldAbort) {
    if (items.length > ZIP_MAX_ENTRIES) {
      throw new Error(`文件数量超过标准 ZIP 上限 (${ZIP_MAX_ENTRIES})，请分批或切换为单文件 Markdown 模式。`)
    }

    const now = new Date()
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
    const dosDate = (Math.max(0, now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()

    const localChunks = []
    const centralChunks = []
    let offset = 0
    let usedDeflate = false
    const total = items.length || 1
    let lastReportTs = 0

    for (let idx = 0; idx < items.length; idx++) {
      if (shouldAbort?.()) return null
      const item = items[idx]
      const nameBytes = encodeUtf8(item.relativePath)
      if (nameBytes.length > 0xffff) {
        throw new Error(`文件路径过长，超过 ZIP 规范上限：${item.relativePath.slice(0, 60)}...`)
      }
      const rawBytes = encodeUtf8(item.isBinary && !item.content ? '' : item.content)
      const crc = computeCrc32(rawBytes)
      const uncompressedSize = rawBytes.length

      const compressed = await tryDeflateRaw(rawBytes)
      if (shouldAbort?.()) return null
      const method = compressed ? 8 : 0
      const payloadBytes = compressed || rawBytes
      const compressedSize = payloadBytes.length
      if (compressed) usedDeflate = true
      const nameLen = nameBytes.length

      if (
        uncompressedSize > ZIP_MAX_UINT32 ||
        compressedSize > ZIP_MAX_UINT32 ||
        offset > ZIP_MAX_UINT32 ||
        offset + 30 + nameLen + compressedSize > ZIP_MAX_UINT32
      ) {
        throw new Error('压缩包体积超过标准 ZIP 4GB 上限。')
      }

      const localHdr = new Uint8Array(30)
      const lv = new DataView(localHdr.buffer)
      lv.setUint32(0, 0x04034b50, true)
      lv.setUint16(4, 20, true)
      lv.setUint16(6, 0x0800, true)
      lv.setUint16(8, method, true)
      lv.setUint16(10, dosTime, true)
      lv.setUint16(12, dosDate, true)
      lv.setUint32(14, crc, true)
      lv.setUint32(18, compressedSize, true)
      lv.setUint32(22, uncompressedSize, true)
      lv.setUint16(26, nameLen, true)
      lv.setUint16(28, 0, true)
      localChunks.push(localHdr, nameBytes, payloadBytes)

      const centralHdr = new Uint8Array(46)
      const cv = new DataView(centralHdr.buffer)
      cv.setUint32(0, 0x02014b50, true)
      cv.setUint16(4, 20, true)
      cv.setUint16(6, 20, true)
      cv.setUint16(8, 0x0800, true)
      cv.setUint16(10, method, true)
      cv.setUint16(12, dosTime, true)
      cv.setUint16(14, dosDate, true)
      cv.setUint32(16, crc, true)
      cv.setUint32(20, compressedSize, true)
      cv.setUint32(24, uncompressedSize, true)
      cv.setUint16(28, nameLen, true)
      cv.setUint16(30, 0, true)
      cv.setUint16(32, 0, true)
      cv.setUint16(34, 0, true)
      cv.setUint16(36, 0, true)
      cv.setUint32(38, 0, true)
      cv.setUint32(42, offset, true)
      centralChunks.push(centralHdr, nameBytes)

      offset += 30 + nameLen + compressedSize

      const nowTs = performance.now()
      if (idx === items.length - 1 || nowTs - lastReportTs >= 35) {
        lastReportTs = nowTs
        if (typeof onProgress === 'function') onProgress(Math.round(((idx + 1) / total) * 100), item.relativePath)
        if (idx < items.length - 1) await nextPaint()
      }
    }

    if (shouldAbort?.()) return null

    let centralSize = 0
    for (const chunk of centralChunks) centralSize += chunk.length
    if (centralSize > ZIP_MAX_UINT32) throw new Error('ZIP 中央目录体积超过规范上限。')

    const eocd = new Uint8Array(22)
    const ev = new DataView(eocd.buffer)
    ev.setUint32(0, 0x06054b50, true)
    ev.setUint16(4, 0, true)
    ev.setUint16(6, 0, true)
    ev.setUint16(8, items.length, true)
    ev.setUint16(10, items.length, true)
    ev.setUint32(12, centralSize, true)
    ev.setUint32(16, offset, true)
    ev.setUint16(20, 0, true)

    return {
      blob: new Blob([...localChunks, ...centralChunks, eocd], { type: 'application/zip' }),
      engine: usedDeflate ? 'Native DEFLATE' : 'Native STORE'
    }
  }

  function buildDirectoryTreeText(items) {
    const root = new Map()
    for (const item of items) {
      const parts = item.relativePath.split('/')
      let node = root
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const isFile = i === parts.length - 1
        if (!node.has(part)) node.set(part, isFile ? null : new Map())
        if (!isFile) {
          const next = node.get(part)
          if (next instanceof Map) node = next
        }
      }
    }
    const lines = []
    function walk(map, prefix) {
      const entries = Array.from(map.entries())
      entries.forEach(([name, child], idx) => {
        const isLast = idx === entries.length - 1
        lines.push(`${prefix}${isLast ? '└── ' : '├── '}${name}${child ? '/' : ''}`)
        if (child) walk(child, prefix + (isLast ? '    ' : '│   '))
      })
    }
    walk(root, '')
    return lines.join('\n')
  }

  async function createSingleMarkdownBlob(items, onProgress, shouldAbort) {
    const parts = [
      '# BlockClip Project Bundle',
      '',
      `> Total Files: ${items.length}`,
      '',
      '## Directory Structure',
      '```text',
      buildDirectoryTreeText(items),
      '```',
      '',
      '## Files',
      ''
    ]
    const total = items.length || 1
    let lastReportTs = 0
    for (let idx = 0; idx < items.length; idx++) {
      if (shouldAbort?.()) return null
      const item = items[idx]
      const pathBackticks = item.relativePath.match(/`+/g)
      let inlineTickLen = 1
      if (pathBackticks) {
        for (const m of pathBackticks) if (m.length >= inlineTickLen) inlineTickLen = m.length + 1
      }
      const inlineTicks = '`'.repeat(inlineTickLen)
      parts.push(`### File: ${inlineTicks}${item.relativePath}${inlineTicks}`)
      if (item.isBinary && !item.content) {
        parts.push('_Binary file placeholder (empty)_', '')
      } else {
        const backtickMatches = item.content.match(/`{3,}/g)
        let fenceLen = 3
        if (backtickMatches) {
          for (const m of backtickMatches) if (m.length >= fenceLen) fenceLen = m.length + 1
        }
        const fence = '`'.repeat(fenceLen)
        const lang = item.language && item.language !== 'plaintext' ? item.language : ''
        parts.push(`${fence}${lang}`, item.content, fence, '')
      }
      const nowTs = performance.now()
      if (idx === items.length - 1 || nowTs - lastReportTs >= 35) {
        lastReportTs = nowTs
        if (typeof onProgress === 'function') onProgress(Math.round(((idx + 1) / total) * 100), item.relativePath)
        if (idx < items.length - 1) await nextPaint()
      }
    }
    if (shouldAbort?.()) return null
    return new Blob([parts.join('\n')], { type: 'text/markdown;charset=utf-8' })
  }

  async function buildArtifact(items, exportMode, customName, onProgress, shouldAbort) {
    if (exportMode === 'single_md') {
      const { name, timeStem } = inferSmartFilename(items, 'md', customName)
      const blob = await createSingleMarkdownBlob(items, onProgress, shouldAbort)
      if (!blob) return null
      const file = new File([blob], name, { type: 'text/markdown' })
      return { blob, file, name, timeStem, mime: 'text/markdown', engine: 'Markdown' }
    }
    const { name, timeStem } = inferSmartFilename(items, 'zip', customName)
    const zipRes = await createNativeZipBlob(items, onProgress, shouldAbort)
    if (!zipRes) return null
    const { blob, engine } = zipRes
    const file = new File([blob], name, { type: 'application/zip' })
    return { blob, file, name, timeStem, mime: 'application/zip', engine }
  }

  let isDispatchingSynthetic = false
  let busy = false
  const activeDataTransfers = new Set()
  const touchedFileInputs = new Set()
  let cleanupTimer = null

  function trackDT(dt) {
    if (dt) activeDataTransfers.add(dt)
    return dt
  }

  function clearTrackedDataTransfers() {
    for (const dt of activeDataTransfers) {
      try {
        dt.items?.clear?.()
      } catch {}
      try {
        dt.clearData?.()
      } catch {}
    }
    activeDataTransfers.clear()
  }

  function clearSingleFileInput(input) {
    if (!input) return
    for (const [win, el] of [
      [rawWin, unwrap(input)],
      [window, input]
    ]) {
      try {
        el.value = ''
        if (el.files && el.files.length > 0) el.files = new win.DataTransfer().files
      } catch {}
    }
  }

  function cancelScheduledCleanup() {
    if (cleanupTimer) {
      clearTimeout(cleanupTimer)
      cleanupTimer = null
    }
  }

  function clearAllResiduals() {
    cancelScheduledCleanup()
    clearTrackedDataTransfers()
    if (touchedFileInputs.size > 0) {
      for (const inp of touchedFileInputs) clearSingleFileInput(inp)
      touchedFileInputs.clear()
    }
  }

  function scheduleCleanup(delayMs = POST_INJECT_CLEANUP_MS) {
    cancelScheduledCleanup()
    cleanupTimer = setTimeout(clearAllResiduals, delayMs)
  }

  function dispatchInputEventSafe(el) {
    if (!el) return
    try {
      const opts = new rawWin.Object()
      opts.bubbles = true
      opts.composed = true
      unwrap(el).dispatchEvent(new rawWin.Event('input', opts))
      return
    } catch {}
    try {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    } catch {}
  }

  function setNativeTextValue(el, nextValue) {
    try {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && typeof desc.set === 'function') {
        desc.set.call(el, nextValue)
        return
      }
    } catch {}
    el.value = nextValue
  }

  async function prepareBinaryPayload(file) {
    const needPageFile = rawWin !== window && Boolean(rawWin.File && rawWin.Uint8Array)
    if (!needPageFile) return { pageFile: file, rawFile: file, isPageSide: false }
    try {
      const srcBytes = new Uint8Array(await file.arrayBuffer())
      let pageBytes = null
      if (typeof cloneInto === 'function') {
        try {
          pageBytes = cloneInto(srcBytes, rawWin)
        } catch {}
      }
      if (!pageBytes) {
        pageBytes = new rawWin.Uint8Array(srcBytes.length)
        pageBytes.set(srcBytes)
      }
      const parts = new rawWin.Array()
      parts.push(pageBytes)
      const opts = new rawWin.Object()
      opts.type = file.type || 'application/octet-stream'
      opts.lastModified = file.lastModified || Date.now()
      const pageFile = new rawWin.File(parts, file.name, opts)
      return { pageFile, rawFile: file, isPageSide: true }
    } catch {
      return { pageFile: file, rawFile: file, isPageSide: false }
    }
  }

  function buildDataTransfer(win, fileForWin) {
    const dt = trackDT(new win.DataTransfer())
    dt.items.add(fileForWin)
    return dt
  }

  function dispatchPasteEvent(target, prepared) {
    if (!target) return false
    const tryDispatch = (win, el, fileObj) => {
      const dt = buildDataTransfer(win, fileObj)
      const opts = new win.Object()
      opts.bubbles = true
      opts.cancelable = true
      opts.composed = true
      opts.clipboardData = dt

      const evt = new win.ClipboardEvent('paste', opts)
      if (!evt.clipboardData) {
        try {
          const desc = new win.Object()
          desc.value = dt
          desc.configurable = true
          win.Object.defineProperty(evt, 'clipboardData', desc)
        } catch {}
      } else if (evt.clipboardData.files && evt.clipboardData.files.length === 0 && evt.clipboardData.items) {
        try {
          evt.clipboardData.items.add(fileObj)
          trackDT(evt.clipboardData)
        } catch {}
      }

      isDispatchingSynthetic = true
      try {
        el.dispatchEvent(evt)
      } finally {
        isDispatchingSynthetic = false
      }
      return true
    }

    try {
      if (prepared.isPageSide) return tryDispatch(rawWin, unwrap(target), prepared.pageFile)
      return tryDispatch(window, target, prepared.rawFile)
    } catch {
      try {
        return tryDispatch(window, target, prepared.rawFile)
      } catch {
        return false
      }
    }
  }

  function isInputAcceptingFile(input, file) {
    if (!input || input.disabled || input.webkitdirectory || input.hasAttribute('webkitdirectory')) return false
    const accept = (input.getAttribute('accept') || '').trim().toLowerCase()
    if (!accept || accept === '*' || accept === '*/*') return true
    const isZip = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip'
    for (const t of accept.split(',').map((s) => s.trim())) {
      if (t === '*' || t === '*/*') return true
      if (isZip) {
        if (t === '.zip' || t === 'application/zip' || t === 'application/x-zip-compressed' || t === 'application/*') {
          return true
        }
      } else if (t === '.md' || t === '.txt' || t === 'text/*' || t === 'text/plain' || t === 'text/markdown') {
        return true
      }
    }
    return false
  }

  const UPLOADER_HINT_SEL =
    'input-container, .input-area-container, ms-prompt-box, ms-prompt-input-wrapper, ms-chunk-input, ms-chunk-editor, [class*="upload" i], [data-test-id*="upload" i]'

  function findValidFileInputs(file, scope) {
    const seen = new Set()
    const scopedInputs = []
    if (scope) {
      for (const el of querySelectorAllDeep('input[type="file"]', scope)) {
        if (!seen.has(el) && isInputAcceptingFile(el, file)) {
          seen.add(el)
          scopedInputs.push(el)
        }
      }
    }
    if (scopedInputs.length > 0) {
      scopedInputs.sort((a, b) => (a.getAttribute('accept') ? 0 : 1) - (b.getAttribute('accept') ? 0 : 1))
      return scopedInputs
    }

    const collectFallback = (candidates) => {
      const matched = []
      for (const el of candidates) {
        if (seen.has(el) || !isInputAcceptingFile(el, file)) continue
        const inRelevantContainer =
          scope === document.body ||
          Boolean(el.closest?.(UPLOADER_HINT_SEL)) ||
          /upload|attach|file/i.test(`${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''}`)
        if (!inRelevantContainer) continue
        seen.add(el)
        matched.push(el)
      }
      return matched
    }

    // 优先轻量直查 document，仅当未命中时再穿透 Shadow DOM，避免长对话页面全量遍历
    let fallbackInputs = collectFallback(document.querySelectorAll('input[type="file"]'))
    if (fallbackInputs.length === 0) {
      fallbackInputs = collectFallback(querySelectorAllDeep('input[type="file"]', document))
    }
    fallbackInputs.sort((a, b) => (a.getAttribute('accept') ? 0 : 1) - (b.getAttribute('accept') ? 0 : 1))
    return fallbackInputs
  }

  function dispatchNativeFileInput(inputEl, prepared) {
    if (!inputEl) return false
    touchedFileInputs.add(inputEl)
    const tryAssign = (win, el, fileObj) => {
      const dt = buildDataTransfer(win, fileObj)
      el.files = dt.files
      for (const evType of ['input', 'change']) {
        const opts = new win.Object()
        opts.bubbles = true
        opts.composed = true
        el.dispatchEvent(new win.Event(evType, opts))
      }
      return true
    }
    try {
      if (prepared.isPageSide) return tryAssign(rawWin, unwrap(inputEl), prepared.pageFile)
      return tryAssign(window, inputEl, prepared.rawFile)
    } catch {
      try {
        return tryAssign(window, inputEl, prepared.rawFile)
      } catch {
        return false
      }
    }
  }

  const PREVIEW_SEL = [
    'uploader-file-preview',
    '[data-test-id*="file-preview"]',
    'ms-prompt-media',
    'ms-file-chip',
    'ms-media-chip',
    'ms-chunk-media'
  ].join(',')

  function buildFileAttrSelector(fileName, timeStem) {
    const parts = []
    if (fileName) {
      const escName = CSS.escape(fileName)
      parts.push(`[title*="${escName}"]`, `[aria-label*="${escName}"]`)
    }
    if (timeStem && fileName && fileName.includes(timeStem)) {
      const escTime = CSS.escape(timeStem)
      parts.push(`[title*="${escTime}"]`, `[aria-label*="${escTime}"]`)
    }
    return parts.join(', ')
  }

  function countPreviewNodes(root) {
    if (!root?.querySelectorAll) return 0
    try {
      return root.querySelectorAll(PREVIEW_SEL).length
    } catch {
      return 0
    }
  }

  function isFileRenderedInDom(scope, fileName, timeStem) {
    const effectiveStem = timeStem && fileName && fileName.includes(timeStem) ? timeStem : ''
    const sText = scope ? scope.textContent || '' : ''
    if ((fileName && sText.includes(fileName)) || (effectiveStem && sText.includes(effectiveStem))) return true
    const sel = buildFileAttrSelector(fileName, effectiveStem)
    if (!sel) return false
    const searchRoot = scope || document
    return Boolean(searchRoot.querySelector(sel))
  }

  function createAttachmentWatcher(scope, fileName, timeStem, timeoutMs, hostEl) {
    const effectiveStem = timeStem && fileName && fileName.includes(timeStem) ? timeStem : ''
    const existedBeforeDispatch = isFileRenderedInDom(scope, fileName, effectiveStem)
    const beforePreviewCount = countPreviewNodes(scope || document.body)
    const attrSel = buildFileAttrSelector(fileName, effectiveStem)

    let settled = false
    let obs = null
    let timer = null
    let resolveFn = null

    const finish = (ok) => {
      if (settled) return
      settled = true
      if (obs) {
        obs.disconnect()
        obs = null
      }
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (resolveFn) resolveFn(ok)
    }

    const isInsideHost = (node) =>
      Boolean(hostEl && node && (node === hostEl || (node instanceof Node && hostEl.contains(node))))
    const isInsideScope = (node) => Boolean(!scope || (node instanceof Node && scope.contains(node)))
    const matchesText = (txt) =>
      Boolean(txt && ((fileName && txt.includes(fileName)) || (effectiveStem && txt.includes(effectiveStem))))

    const matchesAddedNode = (node) => {
      if (!node || isInsideHost(node)) return false
      if (node.nodeType === 3) return isInsideScope(node) && matchesText(node.nodeValue)
      if (node.nodeType !== 1) return false

      const inScope = isInsideScope(node)
      const title = node.getAttribute?.('title') || ''
      const label = node.getAttribute?.('aria-label') || ''
      if (matchesText(title) || matchesText(label)) return true
      if (attrSel && (node.matches?.(attrSel) || node.querySelector?.(attrSel))) return true

      if (inScope) {
        if (node.matches?.(PREVIEW_SEL) || node.querySelector?.(PREVIEW_SEL)) return true
        if (node !== document.body && node.tagName !== 'MAIN' && matchesText(node.textContent)) return true
      }
      return false
    }

    const matchesMutatedTarget = (node) => {
      if (!node || isInsideHost(node)) return false
      if (node.nodeType === 3) return isInsideScope(node) && matchesText(node.nodeValue)
      if (node.nodeType !== 1) return false
      const title = node.getAttribute?.('title') || ''
      const label = node.getAttribute?.('aria-label') || ''
      return matchesText(title) || matchesText(label)
    }

    const promise = new Promise((resolve) => {
      resolveFn = resolve

      obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (isInsideHost(m.target)) continue
          if (m.type === 'characterData' || m.type === 'attributes') {
            if (matchesMutatedTarget(m.target)) return finish(true)
          } else {
            for (const node of m.addedNodes) {
              if (matchesAddedNode(node)) return finish(true)
            }
          }
        }
      })

      obs.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['title', 'aria-label']
      })

      timer = setTimeout(() => {
        const previewIncreased = countPreviewNodes(scope || document.body) > beforePreviewCount
        const renderedNow = !existedBeforeDispatch && isFileRenderedInDom(scope, fileName, effectiveStem)
        finish(previewIncreased || renderedNow)
      }, timeoutMs)
    })

    return {
      promise,
      cancel: () => finish(false)
    }
  }

  const CSS_TEXT = `
    :host {
      all: initial;
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: var(--bc-text);
      --bc-bg: rgba(24, 27, 34, 0.96);
      --bc-surface: rgba(38, 43, 54, 0.88);
      --bc-input-bg: rgba(14, 16, 22, 0.82);
      --bc-border: rgba(255, 255, 255, 0.12);
      --bc-text: #e6edf3;
      --bc-text-dim: #9aa5b4;
      --bc-primary: #3b82f6;
      --bc-primary-hover: #2563eb;
      --bc-warn-bg: rgba(245, 158, 11, 0.14);
      --bc-warn-border: rgba(245, 158, 11, 0.38);
      --bc-warn-text: #fbbf24;
      --bc-shadow: 0 14px 38px rgba(0, 0, 0, 0.52), 0 2px 10px rgba(0, 0, 0, 0.28);
      --bc-scroll-thumb: rgba(255, 255, 255, 0.22);
    }
    :host([data-theme="light"]) {
      --bc-bg: rgba(255, 255, 255, 0.97);
      --bc-surface: rgba(243, 246, 250, 0.95);
      --bc-input-bg: rgba(248, 250, 252, 0.98);
      --bc-border: rgba(15, 23, 42, 0.12);
      --bc-text: #0f172a;
      --bc-text-dim: #64748b;
      --bc-warn-bg: rgba(245, 158, 11, 0.12);
      --bc-warn-border: rgba(217, 119, 6, 0.35);
      --bc-warn-text: #b45309;
      --bc-shadow: 0 14px 36px rgba(15, 23, 42, 0.18), 0 2px 10px rgba(15, 23, 42, 0.08);
      --bc-scroll-thumb: rgba(15, 23, 42, 0.22);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--bc-scroll-thumb); border-radius: 999px; }

    .bc-hud {
      position: fixed; top: 18px; left: 50%; transform: translate(-50%, -18px);
      width: min(410px, calc(100vw - 28px)); background: var(--bc-bg); color: var(--bc-text);
      border: 1px solid var(--bc-border); border-radius: 12px; padding: 10px 14px;
      box-shadow: var(--bc-shadow); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      opacity: 0; visibility: hidden; pointer-events: none;
      transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.2s;
      z-index: 2147483647; display: flex; flex-direction: column; gap: 6px;
    }
    .bc-hud.show { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
    .bc-hud[data-state="success"] { border-color: rgba(16, 185, 129, 0.5); }
    .bc-hud[data-state="error"] { border-color: rgba(239, 68, 68, 0.55); }
    .bc-hud[data-state="warn"] { border-color: rgba(245, 158, 11, 0.55); }
    .bc-hud-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.5px; font-weight: 600; }
    .bc-hud-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
    .bc-hud-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bc-hud-pct { font-variant-numeric: tabular-nums; font-size: 11.5px; color: var(--bc-primary); flex-shrink: 0; }
    .bc-hud[data-state="success"] .bc-hud-pct { color: #10b981; }
    .bc-hud[data-state="error"] .bc-hud-pct { color: #ef4444; }
    .bc-hud[data-state="warn"] .bc-hud-pct { color: #f59e0b; }
    .bc-hud-sub { font-size: 11px; color: var(--bc-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bc-spinner {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid rgba(59, 130, 246, 0.25); border-top-color: #3b82f6;
      animation: bcSpin 0.75s linear infinite; flex-shrink: 0;
    }
    @keyframes bcSpin { to { transform: rotate(360deg); } }
    .bc-bar-track { width: 100%; height: 5px; border-radius: 999px; background: rgba(128, 128, 128, 0.22); overflow: hidden; }
    .bc-bar-fill { height: 100%; width: 0%; border-radius: 999px; background: linear-gradient(90deg, #3b82f6, #60a5fa); transition: width 0.14s ease, background 0.2s ease; }
    .bc-hud[data-state="success"] .bc-bar-fill { background: #10b981; }
    .bc-hud[data-state="error"] .bc-bar-fill { background: #ef4444; }
    .bc-hud[data-state="warn"] .bc-bar-fill { background: #f59e0b; }

    .bc-paste-pill {
      position: fixed; bottom: 24px; left: 50%; transform: translate(-50%, 16px);
      background: var(--bc-bg); color: var(--bc-text); border: 1px solid var(--bc-border);
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-radius: 999px;
      padding: 7px 10px 7px 14px; box-shadow: var(--bc-shadow); display: flex; align-items: center;
      gap: 10px; font-size: 12px; opacity: 0; visibility: hidden; pointer-events: none;
      transition: opacity 0.2s ease, transform 0.22s ease, visibility 0.2s; z-index: 2147483646;
    }
    .bc-paste-pill.show { opacity: 1; visibility: visible; pointer-events: auto; transform: translate(-50%, 0); }
    .bc-pill-btn { border: none; border-radius: 999px; padding: 4px 10px; background: var(--bc-primary); color: #fff; font-size: 11px; font-weight: 600; cursor: pointer; }
    .bc-pill-btn:hover { background: var(--bc-primary-hover); }
    .bc-pill-close { border: none; background: transparent; color: var(--bc-text-dim); cursor: pointer; padding: 2px 6px; font-size: 13px; border-radius: 50%; }
    .bc-pill-close:hover { color: var(--bc-text); }

    .bc-side-tab {
      position: fixed; right: 0; top: 56%; transform: translateY(-50%);
      writing-mode: vertical-rl; padding: 11px 7px;
      background: linear-gradient(180deg, #3b82f6 0%, #2563eb 100%); color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.22); border-right: none; border-radius: 8px 0 0 8px;
      cursor: grab; font-size: 12.5px; font-weight: 600; letter-spacing: 2px;
      box-shadow: -2px 4px 14px rgba(37, 99, 235, 0.34); user-select: none; touch-action: none;
      line-height: 1.2; z-index: 2147483645;
      transition: opacity 0.15s ease, transform 0.15s ease;
    }
    .bc-side-tab:hover { opacity: 0.94; transform: translate(-2px, -50%); }
    .bc-side-tab.dragging { cursor: grabbing; opacity: 0.96; transition: none; transform: translate(-2px, -50%); }
    .bc-side-tab.hidden { display: none; }

    .bc-panel {
      position: fixed; right: 16px; top: 50%; transform: translateY(-50%);
      width: 445px; max-width: calc(100vw - 28px); max-height: calc(100vh - 36px);
      background: var(--bc-bg); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
      border: 1px solid var(--bc-border); border-radius: 14px; box-shadow: var(--bc-shadow);
      display: flex; flex-direction: column; overflow: hidden;
      transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.2s;
      z-index: 2147483644;
    }
    .bc-panel.dragging { transition: none; }
    .bc-panel.hidden { opacity: 0; visibility: hidden; transform: translateY(-50%) scale(0.95); pointer-events: none; }
    .bc-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 11px 14px; border-bottom: 1px solid var(--bc-border); background: rgba(128, 128, 128, 0.05); flex-shrink: 0;
      cursor: grab; user-select: none; touch-action: none;
    }
    .bc-panel.dragging .bc-header { cursor: grabbing; }
    .bc-title-wrap { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .bc-drag-hint { font-size: 11px; color: var(--bc-text-dim); opacity: 0.7; line-height: 1; }
    .bc-title { font-weight: 600; font-size: 13.5px; color: var(--bc-text); white-space: nowrap; }
    .bc-tag { font-size: 10px; padding: 1px 6px; background: rgba(59, 130, 246, 0.16); color: #60a5fa; border-radius: 4px; border: 1px solid rgba(59, 130, 246, 0.3); white-space: nowrap; }
    :host([data-theme="light"]) .bc-tag { color: #2563eb; }
    .bc-actions { display: flex; align-items: center; gap: 4px; }
    .bc-icon-btn { background: transparent; border: none; color: var(--bc-text-dim); padding: 4px 7px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: background 0.15s, color 0.15s; }
    .bc-icon-btn:hover:not(:disabled) { background: rgba(128, 128, 128, 0.14); color: var(--bc-text); }
    .bc-icon-btn:disabled { opacity: 0.45; cursor: not-allowed; }

    .bc-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--bc-scroll-thumb) transparent; }
    .bc-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .bc-seg { display: inline-flex; background: var(--bc-surface); border: 1px solid var(--bc-border); border-radius: 8px; padding: 2px; gap: 2px; }
    .bc-seg-btn { border: none; background: transparent; color: var(--bc-text-dim); padding: 3px 8px; font-size: 11px; font-weight: 500; border-radius: 6px; cursor: pointer; transition: all 0.15s; }
    .bc-seg-btn.active { background: var(--bc-primary); color: #fff; }
    .bc-seg-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .bc-quick-btn { border: 1px solid rgba(16, 185, 129, 0.42); background: rgba(16, 185, 129, 0.14); color: #10b981; border-radius: 7px; padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .bc-quick-btn:hover:not(:disabled) { background: rgba(16, 185, 129, 0.24); }
    .bc-quick-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .bc-delivery-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 9px; border-radius: 8px; background: var(--bc-surface); border: 1px solid var(--bc-border); font-size: 11.5px; }
    .bc-input-header { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--bc-text-dim); margin-bottom: 4px; }
    .bc-paste-btn { color: #3b82f6; background: transparent; border: none; cursor: pointer; font-size: 11px; font-weight: 500; padding: 2px 4px; border-radius: 4px; }
    .bc-paste-btn:hover:not(:disabled) { text-decoration: underline; }
    .bc-paste-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .bc-large-badge { display: none; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; padding: 5px 9px; margin-bottom: 5px; border-radius: 6px; background: rgba(59, 130, 246, 0.14); border: 1px solid rgba(59, 130, 246, 0.3); color: #60a5fa; }
    :host([data-theme="light"]) .bc-large-badge { color: #1d4ed8; }
    .bc-textarea { width: 100%; height: 104px; background: var(--bc-input-bg); border: 1px solid var(--bc-border); border-radius: 8px; padding: 9px; color: var(--bc-text); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; resize: vertical; outline: none; transition: border-color 0.18s; scrollbar-width: thin; scrollbar-color: var(--bc-scroll-thumb) transparent; }
    .bc-textarea:focus { border-color: var(--bc-primary); }
    .bc-btn-primary { width: 100%; padding: 8px 14px; background: var(--bc-primary); border: none; border-radius: 8px; color: #fff; font-weight: 600; font-size: 12.5px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: background 0.15s; }
    .bc-btn-primary:hover:not(:disabled) { background: var(--bc-primary-hover); }
    .bc-btn-primary:disabled { opacity: 0.65; cursor: not-allowed; }

    .bc-inline-progress { display: none; flex-direction: column; gap: 5px; padding: 8px 10px; border-radius: 8px; background: var(--bc-surface); border: 1px solid var(--bc-border); }
    .bc-inline-progress.show { display: flex; }
    .bc-inline-progress-head { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; font-weight: 500; gap: 8px; }
    .bc-inline-progress-msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bc-inline-progress-pct { font-variant-numeric: tabular-nums; color: var(--bc-primary); flex-shrink: 0; }

    .bc-alert { display: none; padding: 7px 10px; border-radius: 8px; font-size: 11px; background: var(--bc-warn-bg); border: 1px solid var(--bc-warn-border); color: var(--bc-warn-text); align-items: center; justify-content: space-between; gap: 8px; }
    .bc-alert-btn { border: 1px solid currentColor; background: transparent; color: inherit; font-size: 10.5px; padding: 2px 7px; border-radius: 5px; cursor: pointer; flex-shrink: 0; }
    .bc-alert-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .bc-result-box { padding: 11px; background: var(--bc-surface); border: 1px solid var(--bc-border); border-radius: 10px; display: none; flex-direction: column; gap: 9px; }
    .bc-summary-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 600; }
    .bc-stat-badge { color: #10b981; background: rgba(16, 185, 129, 0.14); border: 1px solid rgba(16, 185, 129, 0.32); padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }

    .bc-file-card { padding: 9px 11px; border-radius: 8px; border: 1px solid var(--bc-border); background: var(--bc-input-bg); display: flex; align-items: center; gap: 10px; }
    .bc-file-card.dimmed { opacity: 0.45; pointer-events: none; }
    .bc-file-icon { font-size: 22px; flex-shrink: 0; }
    .bc-file-info { flex: 1; min-width: 0; }
    .bc-name-input { width: 100%; background: transparent; border: 1px solid transparent; border-radius: 4px; color: var(--bc-text); font-size: 12.5px; font-weight: 600; padding: 2px 5px; margin-left: -5px; outline: none; text-overflow: ellipsis; }
    .bc-name-input:hover { border-color: var(--bc-border); }
    .bc-name-input:focus { background: var(--bc-surface); border-color: var(--bc-primary); }
    .bc-file-desc { font-size: 11px; color: var(--bc-text-dim); margin-top: 1px; }

    .bc-button-group { display: flex; gap: 8px; }
    .bc-btn-sub { flex: 1; padding: 7px 10px; border-radius: 7px; font-size: 12px; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px; transition: all 0.15s; border: 1px solid var(--bc-border); background: rgba(128, 128, 128, 0.08); color: var(--bc-text); }
    .bc-btn-sub:hover:not(:disabled) { background: rgba(128, 128, 128, 0.16); }
    .bc-btn-sub:disabled { opacity: 0.55; cursor: not-allowed; }
    .bc-btn-inject { background: rgba(16, 185, 129, 0.18); border-color: rgba(16, 185, 129, 0.44); color: #10b981; font-weight: 600; }
    .bc-btn-inject:hover:not(:disabled) { background: rgba(16, 185, 129, 0.28); }

    .bc-tree-toggle { font-size: 11px; color: var(--bc-text-dim); cursor: pointer; display: flex; align-items: center; justify-content: space-between; padding: 3px 0; user-select: none; }
    .bc-tree-toggle:hover { color: var(--bc-text); }
    .bc-tree-list { max-height: 155px; overflow-y: auto; background: var(--bc-input-bg); border: 1px solid var(--bc-border); border-radius: 6px; padding: 5px 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; display: none; flex-direction: column; gap: 2px; scrollbar-width: thin; scrollbar-color: var(--bc-scroll-thumb) transparent; }
    .bc-tree-item { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 2px 4px; border-radius: 4px; color: var(--bc-text); }
    .bc-tree-item:hover { background: rgba(128, 128, 128, 0.1); }
    .bc-tree-item.dimmed { opacity: 0.5; }
    .bc-tree-left { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
    .bc-tree-check { accent-color: var(--bc-primary); cursor: pointer; flex-shrink: 0; }
    .bc-tree-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bc-tree-dir { color: var(--bc-text-dim); }
    .bc-tree-badges { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
    .bc-tree-badge { font-size: 10px; color: var(--bc-text-dim); }
    .bc-tree-warn { font-size: 9.5px; padding: 0 4px; border-radius: 3px; background: var(--bc-warn-bg); color: var(--bc-warn-text); border: 1px solid var(--bc-warn-border); }

    .bc-settings { display: none; flex-direction: column; gap: 6px; padding: 9px 10px; background: var(--bc-surface); border: 1px solid var(--bc-border); border-radius: 8px; font-size: 11.5px; }
    .bc-settings.open { display: flex; }
    .bc-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; user-select: none; color: var(--bc-text); }
    .bc-setting-row input { accent-color: var(--bc-primary); cursor: pointer; }
    .bc-footer-hint { font-size: 10.5px; color: var(--bc-text-dim); text-align: center; padding-top: 2px; }
  `

  function boot() {
    if (document.getElementById(HOST_ID)) return

    const hostEl = document.createElement('div')
    hostEl.id = HOST_ID
    ;(document.body || document.documentElement).appendChild(hostEl)

    const shadow = hostEl.attachShadow({ mode: 'open' })
    try {
      if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet === 'function') {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(CSS_TEXT)
        shadow.adoptedStyleSheets = [sheet]
      } else {
        throw new Error('fallback')
      }
    } catch {
      const styleEl = document.createElement('style')
      styleEl.textContent = CSS_TEXT
      shadow.appendChild(styleEl)
    }

    let themeRafId = 0
    function syncTheme() {
      const nextTheme = isPageDark() ? 'dark' : 'light'
      if (hostEl.getAttribute('data-theme') !== nextTheme) hostEl.setAttribute('data-theme', nextTheme)
    }
    function scheduleSyncTheme() {
      if (themeRafId) return
      themeRafId = requestAnimationFrame(() => {
        themeRafId = 0
        syncTheme()
      })
    }
    syncTheme()

    let isOpen = false
    let isTreeExpanded = false
    let rawTextMemory = null
    let parsedFiles = []
    let currentArtifact = null
    let currentArtifactUrl = null
    let customFileName = ''
    let outerBusy = false
    let innerBusy = false
    let repackToken = 0
    let repackTimer = null
    let hudHideTimer = null
    let pastePillTimer = null
    let pendingChatPasteText = ''
    let pendingChatPasteTarget = null

    let cachedInlineBtn = null
    let failedSlotParent = null
    let failedSlotAt = 0
    let failedSlotCount = 0

    function revokeCurrentUrl() {
      if (currentArtifactUrl) {
        URL.revokeObjectURL(currentArtifactUrl)
        currentArtifactUrl = null
      }
    }

    function applyVerticalCenterPosition(el, pct, marginPx = 12) {
      if (!el) return pct
      const vh = window.innerHeight || document.documentElement.clientHeight || 800
      const h = el.offsetHeight || el.getBoundingClientRect().height
      const halfH = h > 0 ? h / 2 : 36
      const minCenter = Math.min(vh / 2, halfH + marginPx)
      const maxCenter = Math.max(vh / 2, vh - halfH - marginPx)
      const desired = (pct / 100) * vh
      const clampedPx = Math.min(maxCenter, Math.max(minCenter, desired))
      el.style.top = `${Math.round(clampedPx)}px`
      return Number(((clampedPx / vh) * 100).toFixed(2))
    }

    function attachVerticalDrag(handleEl, targetEl, prefKey, options = {}) {
      const { ignoreSelector = null, marginPx = 12, onDragEnd = null } = options
      let pointerId = null
      let startY = 0
      let startCenterY = 0
      let dragged = false

      handleEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return
        if (ignoreSelector && e.target?.closest?.(ignoreSelector)) return
        pointerId = e.pointerId
        startY = e.clientY
        const rect = targetEl.getBoundingClientRect()
        startCenterY = rect.top + rect.height / 2
        dragged = false
        try {
          handleEl.setPointerCapture(pointerId)
        } catch {}
      })

      handleEl.addEventListener('pointermove', (e) => {
        if (pointerId === null || e.pointerId !== pointerId) return
        const dy = e.clientY - startY
        if (!dragged && Math.abs(dy) >= DRAG_THRESHOLD_PX) {
          dragged = true
          targetEl.classList.add('dragging')
        }
        if (!dragged) return
        e.preventDefault()
        const vh = window.innerHeight || document.documentElement.clientHeight || 800
        const h = targetEl.offsetHeight || targetEl.getBoundingClientRect().height
        const halfH = h > 0 ? h / 2 : 36
        const minCenter = Math.min(vh / 2, halfH + marginPx)
        const maxCenter = Math.max(vh / 2, vh - halfH - marginPx)
        const nextCenter = Math.min(maxCenter, Math.max(minCenter, startCenterY + dy))
        targetEl.style.top = `${Math.round(nextCenter)}px`
        prefs[prefKey] = Number(((nextCenter / vh) * 100).toFixed(2))
      })

      const finishDrag = (e) => {
        if (pointerId === null || e.pointerId !== pointerId) return
        try {
          if (handleEl.hasPointerCapture?.(pointerId)) {
            handleEl.releasePointerCapture(pointerId)
          }
        } catch {}
        pointerId = null
        if (dragged) {
          targetEl.classList.remove('dragging')
          handleEl.dataset.bcSuppressClick = '1'
          setTimeout(() => {
            delete handleEl.dataset.bcSuppressClick
          }, 0)
          savePrefs(prefs)
          if (typeof onDragEnd === 'function') onDragEnd()
        }
        dragged = false
      }

      handleEl.addEventListener('pointerup', finishDrag)
      handleEl.addEventListener('pointercancel', finishDrag)
      handleEl.addEventListener(
        'click',
        (e) => {
          if (handleEl.dataset.bcSuppressClick === '1') {
            e.preventDefault()
            e.stopPropagation()
            e.stopImmediatePropagation()
            delete handleEl.dataset.bcSuppressClick
          }
        },
        true
      )
    }

    const hudSpinner = safeEl('span', { className: 'bc-spinner' })
    const hudIcon = safeEl('span', { style: { display: 'none', flexShrink: '0' } })
    const hudTitle = safeEl('span', { className: 'bc-hud-title', textContent: '准备中...' })
    const hudPct = safeEl('span', { className: 'bc-hud-pct', textContent: '0%' })
    const hudSub = safeEl('div', { className: 'bc-hud-sub', textContent: '' })
    const hudBarFill = safeEl('div', { className: 'bc-bar-fill' })
    const hudBarTrack = safeEl('div', { className: 'bc-bar-track' }, hudBarFill)
    const hudEl = safeEl(
      'div',
      { className: 'bc-hud', role: 'status', dataset: { state: 'working' } },
      safeEl(
        'div',
        { className: 'bc-hud-top' },
        safeEl('div', { className: 'bc-hud-left' }, hudSpinner, hudIcon, hudTitle),
        hudPct
      ),
      hudBarTrack,
      hudSub
    )

    const inlineProgMsg = safeEl('span', { className: 'bc-inline-progress-msg' })
    const inlineProgPct = safeEl('span', { className: 'bc-inline-progress-pct' })
    const inlineProgFill = safeEl('div', { className: 'bc-bar-fill' })
    const inlineProgBox = safeEl(
      'div',
      { className: 'bc-inline-progress' },
      safeEl('div', { className: 'bc-inline-progress-head' }, inlineProgMsg, inlineProgPct),
      safeEl('div', { className: 'bc-bar-track' }, inlineProgFill)
    )

    function showProgress(title, percent, subText = '') {
      clearTimeout(hudHideTimer)
      syncTheme()
      const clamped = Math.max(0, Math.min(100, Math.round(percent)))
      hudEl.dataset.state = 'working'
      hudSpinner.style.display = 'inline-block'
      hudIcon.style.display = 'none'
      hudTitle.textContent = title
      hudPct.textContent = `${clamped}%`
      hudBarTrack.style.display = 'block'
      hudBarFill.style.width = `${clamped}%`
      hudSub.textContent = subText
      hudSub.style.display = subText ? 'block' : 'none'
      hudEl.classList.add('show')

      inlineProgMsg.textContent = subText ? `${title} · ${subText}` : title
      inlineProgPct.textContent = `${clamped}%`
      inlineProgFill.style.width = `${clamped}%`
      inlineProgBox.classList.add('show')
    }

    function showNotice(title, type = 'success', subText = '', duration = 2600) {
      clearTimeout(hudHideTimer)
      syncTheme()
      const iconMap = { success: '✅', error: '❌', warn: '⚠️', info: '💡' }
      hudEl.dataset.state = type === 'info' ? 'working' : type
      hudSpinner.style.display = 'none'
      hudIcon.style.display = 'inline-block'
      hudIcon.textContent = iconMap[type] || '✅'
      hudTitle.textContent = title
      hudPct.textContent = type === 'success' ? '100%' : ''
      hudBarTrack.style.display = type === 'success' ? 'block' : 'none'
      hudBarFill.style.width = type === 'success' ? '100%' : '0%'
      hudSub.textContent = subText
      hudSub.style.display = subText ? 'block' : 'none'
      hudEl.classList.add('show')

      if (type === 'success') {
        inlineProgMsg.textContent = title
        inlineProgPct.textContent = '100%'
        inlineProgFill.style.width = '100%'
      }

      hudHideTimer = setTimeout(() => {
        hudEl.classList.remove('show')
        inlineProgBox.classList.remove('show')
      }, duration)
    }

    function hideProgressImmediate() {
      clearTimeout(hudHideTimer)
      hudEl.classList.remove('show')
      inlineProgBox.classList.remove('show')
    }

    const pillTextEl = safeEl('span', {})
    const pastePillEl = safeEl(
      'div',
      { className: 'bc-paste-pill' },
      pillTextEl,
      safeEl(
        'button',
        {
          type: 'button',
          className: 'bc-pill-btn',
          onClick: async () => {
            const text = pendingChatPasteText
            const target = pendingChatPasteTarget
            hidePastePill()
            if (text) {
              const injected = await runInstantPackAndInject(text)
              if (injected && target) {
                const removed = tryRemovePastedTextFromTarget(target, text)
                if (!removed) {
                  showNotice(
                    '附件已秒传，但输入框仍有残留代码',
                    'warn',
                    '检测到输入框含前置提示词，请手动删除多余粘贴文本',
                    3800
                  )
                }
              }
            }
          }
        },
        '⚡ 转为附件秒传'
      ),
      safeEl('button', { type: 'button', className: 'bc-pill-close', title: '忽略', onClick: hidePastePill }, '✕')
    )

    function showPastePill(fileCount, text, targetEl) {
      clearTimeout(pastePillTimer)
      pendingChatPasteText = text
      pendingChatPasteTarget = targetEl || null
      pillTextEl.textContent = `📦 检测到 BlockClip 代码 (${fileCount} 个文件)`
      pastePillEl.classList.add('show')
      pastePillTimer = setTimeout(hidePastePill, 7500)
    }

    function hidePastePill() {
      clearTimeout(pastePillTimer)
      pendingChatPasteText = ''
      pendingChatPasteTarget = null
      pastePillEl.classList.remove('show')
    }

    function tryRemovePastedTextFromTarget(target, pastedText) {
      if (!target || !target.isConnected || !pastedText) return false
      try {
        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
          const val = target.value || ''
          const normalizedPasted = pastedText.replace(/\r\n?/g, '\n')
          let idx = val.lastIndexOf(pastedText)
          let matchLen = pastedText.length
          if (idx === -1) {
            idx = val.lastIndexOf(normalizedPasted)
            matchLen = normalizedPasted.length
          }
          if (idx !== -1) {
            setNativeTextValue(target, val.slice(0, idx) + val.slice(idx + matchLen))
            dispatchInputEventSafe(target)
            return true
          }
          return false
        }
        const editable =
          target.closest?.('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]') ||
          (target.isContentEditable ? target : null)
        if (editable) {
          const curNorm = (editable.innerText || editable.textContent || '').replace(/\r\n?/g, '\n').trim()
          const pastedNorm = pastedText.replace(/\r\n?/g, '\n').trim()
          const curCompact = curNorm.replace(/\s+/g, '')
          const pastedCompact = pastedNorm.replace(/\s+/g, '')
          if (curNorm && (curNorm === pastedNorm || (curCompact && curCompact === pastedCompact))) {
            editable.focus({ preventScroll: true })
            const sel = window.getSelection()
            if (sel) {
              const range = document.createRange()
              range.selectNodeContents(editable)
              sel.removeAllRanges()
              sel.addRange(range)
            }
            if (!document.execCommand?.('delete')) {
              editable.textContent = ''
              dispatchInputEventSafe(editable)
            }
            return true
          }
        }
      } catch {}
      return false
    }

    async function injectAttachmentToPage(artifact) {
      cancelScheduledCleanup()
      const editor = SITE.findEditor()
      if (!editor) return { ok: false, reason: '未找到主对话输入框，请确认当前处于对话页面。' }

      if (document.activeElement !== editor) {
        try {
          editor.focus({ preventScroll: true })
        } catch {}
        await nextPaint()
      }

      const scope = SITE.findUploadScope(editor)
      const prepared = await prepareBinaryPayload(artifact.file)

      const runPaste = async (timeoutMs) => {
        showProgress('正在粘贴注入附件...', 90, `${artifact.name} (${formatBytes(artifact.blob.size)}) · 粘贴模式`)
        const watcher = createAttachmentWatcher(scope, artifact.name, artifact.timeStem, timeoutMs, hostEl)
        if (!dispatchPasteEvent(editor, prepared)) {
          watcher.cancel()
          return false
        }
        return await watcher.promise
      }

      const runFileInput = async (timeoutMs) => {
        const inputs = findValidFileInputs(artifact.file, scope)
        if (inputs.length === 0) return false
        showProgress('正在通过文件域上传...', 92, `${artifact.name} (${formatBytes(artifact.blob.size)}) · 原生 Input`)
        for (const inp of inputs) {
          const watcher = createAttachmentWatcher(scope, artifact.name, artifact.timeStem, timeoutMs, hostEl)
          if (!dispatchNativeFileInput(inp, prepared)) {
            watcher.cancel()
            continue
          }
          if (await watcher.promise) return true
          if (inputs.length > 1) clearSingleFileInput(inp)
        }
        return false
      }

      try {
        if (prefs.uploadMode === 'paste') {
          const ok = await runPaste(SINGLE_MODE_VERIFY_MS)
          return ok
            ? { ok: true, method: 'paste' }
            : { ok: false, reason: '未检测到附件挂载，请在右侧【ZIP 助手】面板切换投递模式或下载后上传。' }
        }
        if (prefs.uploadMode === 'input') {
          const ok = await runFileInput(SINGLE_MODE_VERIFY_MS)
          return ok
            ? { ok: true, method: 'input' }
            : { ok: false, reason: '未检测到有效上传文件域，请切换为「粘贴」或「自动兜底」模式重试。' }
        }

        const order = preferredStrategy === 'input' ? ['input', 'paste'] : ['paste', 'input']
        for (let i = 0; i < order.length; i++) {
          const strategy = order[i]
          const timeout = i === 0 ? PRIMARY_TIMEOUT_MS : FALLBACK_TIMEOUT_MS
          const ok = strategy === 'paste' ? await runPaste(timeout) : await runFileInput(timeout)
          if (ok) {
            preferredStrategy = strategy
            return { ok: true, method: strategy }
          }
        }
        return { ok: false, reason: '所有投递通道均未检测到附件挂载，请点“下载”后手动上传。' }
      } finally {
        scheduleCleanup(POST_INJECT_CLEANUP_MS)
      }
    }

    const sideTabBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-side-tab',
        title: '上下拖动可调整位置 · 点击打开 BlockClip 面板 (Alt+B) | 剪贴板一键秒传 (Alt+Shift+Z)',
        onClick: () => {
          if (sideTabBtn.dataset.bcSuppressClick === '1') return
          setPanelOpen(true)
        }
      },
      'ZIP 助手'
    )

    function resetArtifactState() {
      if (outerBusy) return
      repackToken++
      clearTimeout(repackTimer)
      innerBusy = false
      revokeCurrentUrl()
      currentArtifact = null
      parsedFiles = []
      customFileName = ''
      isTreeExpanded = false
      treeListEl.style.display = 'none'
      treeToggleArrow.textContent = '▼'
      fileCard.classList.remove('dimmed')
      resultContainer.style.display = 'none'
      sensitiveAlertEl.style.display = 'none'
      geminiLimitAlertEl.style.display = 'none'
      hideProgressImmediate()
      updateBusyUI()
    }

    function getActiveRawText() {
      return rawTextMemory !== null ? rawTextMemory : textareaEl.value
    }

    function setRawText(text) {
      if (text.length >= LARGE_TEXT_THRESHOLD) {
        rawTextMemory = text
        const byteSize = utf8ByteLength(text)
        textareaEl.value = `${text.slice(0, PREVIEW_CHAR_LIMIT)}\n\n... [大文本内存直通预览，共 ${formatBytes(byteSize)}，已省略后续渲染以防卡顿] ...`
        largeTextLabel.textContent = `⚡ 已内存加载大文本 (${formatBytes(byteSize)})，零卡顿直通`
        largeBadgeEl.style.display = 'flex'
      } else {
        rawTextMemory = null
        textareaEl.value = text
        largeBadgeEl.style.display = 'none'
      }
    }

    const modeZipBtn = safeEl('button', { type: 'button', className: 'bc-seg-btn' }, '📦 ZIP 包')
    const modeMdBtn = safeEl('button', { type: 'button', className: 'bc-seg-btn' }, '📄 单文件 .md')

    const deliveryMeta = [
      { id: 'paste', label: '⚡ 粘贴(无闪烁)', tip: '直接向主输入框派发文件粘贴事件，零遮罩闪烁' },
      { id: 'input', label: '📂 原生上传', tip: '通过页面原生 file input 上传' },
      { id: 'auto', label: '🔄 自动兜底', tip: '自动检测挂载状态并在 粘贴 ↔ 原生上传 间兜底切换' }
    ]
    const deliveryBtns = deliveryMeta.map((m) =>
      safeEl(
        'button',
        {
          type: 'button',
          className: 'bc-seg-btn',
          title: m.tip,
          dataset: { mode: m.id },
          onClick: () => {
            prefs.uploadMode = m.id
            savePrefs(prefs)
            syncModeUI()
          }
        },
        m.label
      )
    )

    function syncInlineBtnLabel() {
      if (!cachedInlineBtn) return
      cachedInlineBtn.textContent = prefs.exportMode === 'zip' ? '📦 粘贴为ZIP' : '📄 粘贴为MD'
    }

    function syncModeUI() {
      modeZipBtn.className = `bc-seg-btn${prefs.exportMode === 'zip' ? ' active' : ''}`
      modeMdBtn.className = `bc-seg-btn${prefs.exportMode === 'single_md' ? ' active' : ''}`
      deliveryBtns.forEach((btn) => {
        btn.className = `bc-seg-btn${btn.dataset.mode === prefs.uploadMode ? ' active' : ''}`
      })
      processBtn.textContent = prefs.exportMode === 'zip' ? '⚡ 还原层级并打包 ZIP' : '⚡ 合并并生成 .md 附件'
      downloadBtn.textContent = prefs.exportMode === 'zip' ? '💾 下载 ZIP' : '💾 下载 .md'
      syncInlineBtnLabel()
    }

    modeZipBtn.addEventListener('click', () => {
      if (outerBusy || prefs.exportMode === 'zip') return
      prefs.exportMode = 'zip'
      savePrefs(prefs)
      syncModeUI()
      if (parsedFiles.length > 0) rebuildCurrentSelection(false)
    })

    modeMdBtn.addEventListener('click', () => {
      if (outerBusy || prefs.exportMode === 'single_md') return
      prefs.exportMode = 'single_md'
      savePrefs(prefs)
      syncModeUI()
      if (parsedFiles.length > 0) rebuildCurrentSelection(false)
    })

    const instantClipboardBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-quick-btn',
        title: '读取剪贴板 -> 自动解析打包 -> 秒传为附件 (快捷键 Alt+Shift+Z)',
        onClick: runInstantFromClipboard
      },
      '🚀 剪贴板一键秒传'
    )

    function makeSettingToggle(label, prefKey, onChangeExtra) {
      const checkbox = safeEl('input', {
        type: 'checkbox',
        checked: Boolean(prefs[prefKey]),
        onChange: () => {
          prefs[prefKey] = checkbox.checked
          savePrefs(prefs)
          if (onChangeExtra) onChangeExtra(checkbox.checked)
        }
      })
      return safeEl('label', { className: 'bc-setting-row' }, safeEl('span', {}, label), checkbox)
    }

    const settingsEl = safeEl(
      'div',
      { className: 'bc-settings' },
      makeSettingToggle('面板内粘贴后自动解析打包', 'autoPackOnPaste'),
      makeSettingToggle('默认跳过二进制占位文件', 'skipBinaryPlaceholders', (checked) => {
        if (outerBusy) return
        if (parsedFiles.length > 0) {
          for (const f of parsedFiles) if (f.isBinary) f.selected = !checked
          renderFileTree()
          scheduleRepack()
        }
      }),
      makeSettingToggle('注入附件成功后自动收起面板', 'autoCloseAfterInject'),
      makeSettingToggle(
        IS_FIREFOX ? '聊天框粘贴 BlockClip 自动转附件（Firefox 推荐）' : '聊天框粘贴 BlockClip 自动转附件',
        'autoInterceptChatPaste'
      )
    )

    const settingsBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-icon-btn',
        title: '偏好设置',
        onClick: () => {
          settingsEl.classList.toggle('open')
          requestAnimationFrame(() => applyVerticalCenterPosition(panelEl, prefs.panelTopPct, 14))
        }
      },
      '⚙️'
    )
    const clearBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-icon-btn',
        title: '清空内容',
        onClick: () => {
          if (outerBusy) return
          rawTextMemory = null
          textareaEl.value = ''
          largeBadgeEl.style.display = 'none'
          resetArtifactState()
          showNotice('已清空内容', 'info', '', 1400)
        }
      },
      '🗑️'
    )
    const closeBtn = safeEl(
      'button',
      { type: 'button', className: 'bc-icon-btn', title: '收起面板 (Esc)', onClick: () => setPanelOpen(false) },
      '✕'
    )

    const largeTextLabel = safeEl('span', {})
    const largeClearBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-alert-btn',
        onClick: () => {
          if (outerBusy) return
          rawTextMemory = null
          textareaEl.value = ''
          largeBadgeEl.style.display = 'none'
          resetArtifactState()
        }
      },
      '清除'
    )
    const largeBadgeEl = safeEl('div', { className: 'bc-large-badge' }, largeTextLabel, largeClearBtn)

    const textareaEl = safeEl('textarea', {
      className: 'bc-textarea',
      placeholder:
        '在此 Ctrl+V 粘贴 BlockClip 导出的文本（粘贴即自动解析打包）...\n例如：\nFile: src/index.ts\n```typescript\n// ...\n```'
    })

    textareaEl.addEventListener('paste', (e) => {
      const pasted = e.clipboardData ? e.clipboardData.getData('text/plain') : ''
      if (!pasted) return
      if (pasted.length >= LARGE_TEXT_THRESHOLD) {
        e.preventDefault()
        setRawText(pasted)
        if (prefs.autoPackOnPaste) processRawText(pasted, true)
        return
      }
      if (rawTextMemory !== null) {
        e.preventDefault()
        setRawText(pasted)
        if (prefs.autoPackOnPaste && /^File:\s*.+/im.test(pasted)) processRawText(pasted, true)
        return
      }
      largeBadgeEl.style.display = 'none'
      if (prefs.autoPackOnPaste) {
        setTimeout(() => {
          const val = textareaEl.value
          if (val && /^File:\s*.+/im.test(val)) processRawText(val, true)
        }, 0)
      }
    })

    textareaEl.addEventListener('input', () => {
      if (rawTextMemory !== null) {
        rawTextMemory = null
        largeBadgeEl.style.display = 'none'
      }
    })

    const pasteBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-paste-btn',
        onClick: async () => {
          if (outerBusy) return
          let clipText
          try {
            clipText = await readClipboardActive()
          } catch {
            showNotice(
              IS_FIREFOX
                ? 'Firefox 剪贴板读取受阻：请直接在下方 Ctrl+V，或开启“聊天框粘贴自动转附件”'
                : '无法读取剪贴板，请允许剪贴板权限或直接 Ctrl+V',
              'error',
              '',
              3400
            )
            textareaEl.focus()
            return
          }
          if (!clipText || !clipText.trim()) {
            showNotice('剪贴板为空', 'warn', '', 1800)
            return
          }
          setRawText(clipText)
          if (prefs.autoPackOnPaste) await processRawText(clipText, true)
          else showNotice('已从剪贴板读取内容', 'info', '', 1600)
        }
      },
      '📋 读取剪贴板'
    )

    const sensitiveAlertText = safeEl('span', {})
    const sensitiveExcludeBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-alert-btn',
        onClick: () => {
          if (outerBusy) return
          for (const f of parsedFiles) if (f.isSensitive) f.selected = false
          renderFileTree()
          scheduleRepack(0)
          showNotice('已取消勾选敏感文件并重新打包', 'info', '', 1800)
        }
      },
      '一键排除'
    )
    const sensitiveAlertEl = safeEl('div', { className: 'bc-alert' }, sensitiveAlertText, sensitiveExcludeBtn)

    const geminiLimitText = safeEl('span', {})
    const geminiSwitchMdBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-alert-btn',
        onClick: () => {
          if (outerBusy) return
          prefs.exportMode = 'single_md'
          savePrefs(prefs)
          syncModeUI()
          rebuildCurrentSelection(true)
        }
      },
      '切为单文件 .md'
    )
    const geminiLimitAlertEl = safeEl('div', { className: 'bc-alert' }, geminiLimitText, geminiSwitchMdBtn)

    const resultContainer = safeEl('div', { className: 'bc-result-box' })
    const summaryTextEl = safeEl('span', { textContent: '解析完成' })
    const statBadgeEl = safeEl('span', { className: 'bc-stat-badge', textContent: '0 B' })
    const nameInputEl = safeEl('input', {
      type: 'text',
      className: 'bc-name-input',
      value: 'blockclip_files.zip',
      title: '点击可自定义附件文件名（Enter 确认）'
    })

    function renameCurrentArtifact(rawName) {
      if (!currentArtifact) return
      const cleaned = rawName.trim().replace(/[\\/:*?"<>|]/g, '_')
      if (!cleaned) {
        nameInputEl.value = currentArtifact.name
        return
      }
      const ext = prefs.exportMode === 'single_md' ? 'md' : 'zip'
      const base = cleaned.replace(/\.(zip|md|txt)$/i, '')
      if (!base) {
        nameInputEl.value = currentArtifact.name
        return
      }
      const nextName = `${base}.${ext}`
      customFileName = nextName
      if (nextName === currentArtifact.name) {
        nameInputEl.value = nextName
        return
      }
      const nextFile = new File([currentArtifact.blob], nextName, { type: currentArtifact.mime })
      const nextTimeStem =
        currentArtifact.timeStem && nextName.includes(currentArtifact.timeStem) ? currentArtifact.timeStem : ''
      currentArtifact = { ...currentArtifact, name: nextName, timeStem: nextTimeStem, file: nextFile }
      nameInputEl.value = nextName
      showNotice(`已重命名为 ${nextName}`, 'info', '', 1600)
    }

    nameInputEl.addEventListener('keydown', (e) => {
      if (e.isComposing || e.key === 'Process') return
      if (e.key === 'Enter') {
        e.preventDefault()
        nameInputEl.blur()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (currentArtifact) nameInputEl.value = currentArtifact.name
        nameInputEl.blur()
      }
    })
    nameInputEl.addEventListener('change', () => renameCurrentArtifact(nameInputEl.value))

    const fileCardIcon = safeEl('div', { className: 'bc-file-icon' }, '📦')
    const fileCardDesc = safeEl('div', {
      className: 'bc-file-desc',
      textContent: '点击文件名可重命名 · 点击下方按钮一键注入或下载'
    })
    const fileCard = safeEl(
      'div',
      { className: 'bc-file-card' },
      fileCardIcon,
      safeEl('div', { className: 'bc-file-info' }, nameInputEl, fileCardDesc)
    )

    function updateBusyUI() {
      busy = outerBusy || innerBusy
      processBtn.disabled = busy
      instantClipboardBtn.disabled = busy
      injectBtn.disabled = busy || !currentArtifact
      downloadBtn.disabled = busy || !currentArtifact
      modeZipBtn.disabled = outerBusy
      modeMdBtn.disabled = outerBusy
      clearBtn.disabled = outerBusy
      largeClearBtn.disabled = outerBusy
      pasteBtn.disabled = outerBusy
      sensitiveExcludeBtn.disabled = outerBusy
      geminiSwitchMdBtn.disabled = outerBusy
      treeListEl.querySelectorAll('.bc-tree-check').forEach((cb) => {
        cb.disabled = outerBusy
      })
      if (cachedInlineBtn) {
        cachedInlineBtn.style.opacity = busy ? '0.5' : cachedInlineBtn.dataset.floating === '1' ? '1' : '0.88'
        if (!busy && cachedInlineBtn.dataset.floating !== '1' && !cachedInlineBtn.matches(':hover')) {
          cachedInlineBtn.style.backgroundColor = 'rgba(59, 130, 246, 0.14)'
          cachedInlineBtn.style.borderColor = 'rgba(59, 130, 246, 0.36)'
        }
      }
    }

    function setOuterBusy(next) {
      outerBusy = Boolean(next)
      updateBusyUI()
    }

    async function performInjectArtifact(artifact) {
      if (!artifact) return false
      const res = await injectAttachmentToPage(artifact)
      if (res.ok) {
        const modeLabel = res.method === 'paste' ? '粘贴模式' : '原生上传'
        showNotice(
          `已秒传附件：${artifact.name}`,
          'success',
          `${formatBytes(artifact.blob.size)} · ${modeLabel}校验通过`,
          2400
        )
        if (prefs.autoCloseAfterInject && isOpen) {
          setTimeout(() => {
            setPanelOpen(false)
            const editor = SITE.findEditor()
            if (editor) {
              try {
                editor.focus({ preventScroll: true })
              } catch {}
            }
          }, 300)
        }
        return true
      }
      showNotice('未检测到附件挂载', 'error', res.reason || '请切换投递模式或下载后手动上传', 3800)
      return false
    }

    const injectBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-btn-sub bc-btn-inject',
        title: '将产物无闪烁注入当前对话框附件区',
        onClick: async () => {
          if (!currentArtifact) return
          if (busy) {
            showNotice('正在处理上一个任务，请稍候…', 'warn', '', 1600)
            return
          }
          setOuterBusy(true)
          try {
            await performInjectArtifact(currentArtifact)
          } finally {
            setOuterBusy(false)
          }
        }
      },
      '⚡ 一键添加到附件'
    )

    const downloadBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-btn-sub',
        title: '下载生成的附件到本地',
        onClick: () => {
          if (!currentArtifact || !currentArtifactUrl) return
          const a = document.createElement('a')
          a.href = currentArtifactUrl
          a.download = currentArtifact.name
          a.rel = 'noopener'
          a.style.display = 'none'
          document.body.appendChild(a)
          a.click()
          setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a)
          }, 1500)
          showNotice(`开始下载：${currentArtifact.name}`, 'info', formatBytes(currentArtifact.blob.size), 1800)
        }
      },
      '💾 下载 ZIP'
    )

    const treeListEl = safeEl('div', { className: 'bc-tree-list' })
    const treeToggleTitle = safeEl('span', {}, '包含文件列表')
    const treeToggleArrow = safeEl('span', {}, '▼')
    const treeToggleEl = safeEl(
      'div',
      {
        className: 'bc-tree-toggle',
        onClick: () => {
          isTreeExpanded = !isTreeExpanded
          treeListEl.style.display = isTreeExpanded ? 'flex' : 'none'
          treeToggleArrow.textContent = isTreeExpanded ? '▲' : '▼'
          requestAnimationFrame(() => applyVerticalCenterPosition(panelEl, prefs.panelTopPct, 14))
        }
      },
      treeToggleTitle,
      treeToggleArrow
    )

    function scheduleRepack(delay = 280) {
      clearTimeout(repackTimer)
      repackTimer = setTimeout(() => {
        if (!outerBusy) rebuildCurrentSelection(true)
      }, delay)
    }

    function renderFileTree() {
      const frag = document.createDocumentFragment()
      let selectedCount = 0
      let sensitiveSelectedCount = 0

      for (const item of parsedFiles) {
        if (item.selected) {
          selectedCount++
          if (item.isSensitive) sensitiveSelectedCount++
        }
        const slashIdx = item.relativePath.lastIndexOf('/')
        const dirPart = slashIdx >= 0 ? item.relativePath.slice(0, slashIdx + 1) : ''
        const filePart = slashIdx >= 0 ? item.relativePath.slice(slashIdx + 1) : item.relativePath

        const check = safeEl('input', {
          type: 'checkbox',
          className: 'bc-tree-check',
          checked: item.selected,
          disabled: outerBusy,
          onChange: () => {
            item.selected = check.checked
            row.classList.toggle('dimmed', !item.selected)
            updateAlerts()
            scheduleRepack()
          }
        })

        const badges = []
        if (item.isSensitive) {
          badges.push(safeEl('span', { className: 'bc-tree-warn', title: '疑似密钥或敏感配置文件' }, '⚠️ 敏感'))
        }
        badges.push(
          safeEl(
            'span',
            { className: 'bc-tree-badge' },
            item.isBinary
              ? 'Binary'
              : item.snippetsCount > 1
                ? `${item.snippetsCount}段 · ${formatBytes(item.byteSize)}`
                : formatBytes(item.byteSize)
          )
        )

        const row = safeEl(
          'label',
          { className: `bc-tree-item${item.selected ? '' : ' dimmed'}` },
          safeEl(
            'span',
            { className: 'bc-tree-left', title: item.relativePath },
            check,
            safeEl(
              'span',
              { className: 'bc-tree-path' },
              dirPart ? safeEl('span', { className: 'bc-tree-dir' }, dirPart) : null,
              filePart
            )
          ),
          safeEl('span', { className: 'bc-tree-badges' }, badges)
        )
        frag.appendChild(row)
      }

      while (treeListEl.firstChild) treeListEl.removeChild(treeListEl.firstChild)
      treeListEl.appendChild(frag)
      treeToggleTitle.textContent = `包含文件列表（已选 ${selectedCount} / ${parsedFiles.length}）`
      updateAlerts(sensitiveSelectedCount, selectedCount)
    }

    function updateAlerts(sensitiveCountArg, selectedCountArg) {
      let sensitiveCount = sensitiveCountArg
      let selectedCount = selectedCountArg
      if (sensitiveCount === undefined || selectedCount === undefined) {
        sensitiveCount = 0
        selectedCount = 0
        for (const f of parsedFiles) {
          if (f.selected) {
            selectedCount++
            if (f.isSensitive) sensitiveCount++
          }
        }
      }
      treeToggleTitle.textContent = `包含文件列表（已选 ${selectedCount} / ${parsedFiles.length}）`
      if (sensitiveCount > 0) {
        sensitiveAlertText.textContent = `⚠️ 检测到 ${sensitiveCount} 个疑似敏感文件（如 .env / 密钥配置）`
        sensitiveAlertEl.style.display = 'flex'
      } else {
        sensitiveAlertEl.style.display = 'none'
      }
      if (IS_GEMINI && prefs.exportMode === 'zip' && selectedCount > 10) {
        geminiLimitText.textContent = `💡 当前含 ${selectedCount} 个文件，若 Gemini 拒收大数量 ZIP 可切为单文件`
        geminiLimitAlertEl.style.display = 'flex'
      } else {
        geminiLimitAlertEl.style.display = 'none'
      }
    }

    resultContainer.appendChild(safeEl('div', { className: 'bc-summary-row' }, summaryTextEl, statBadgeEl))
    resultContainer.appendChild(sensitiveAlertEl)
    resultContainer.appendChild(geminiLimitAlertEl)
    resultContainer.appendChild(fileCard)
    resultContainer.appendChild(safeEl('div', { className: 'bc-button-group' }, injectBtn, downloadBtn))
    resultContainer.appendChild(treeToggleEl)
    resultContainer.appendChild(treeListEl)

    async function rebuildCurrentSelection(showSuccessNotice = true, keepBusyOuter = false) {
      if (!keepBusyOuter && outerBusy) return null
      clearTimeout(repackTimer)
      const myToken = ++repackToken

      const selectedItems = parsedFiles.filter((f) => f.selected)
      if (selectedItems.length === 0) {
        revokeCurrentUrl()
        currentArtifact = null
        summaryTextEl.textContent = '未勾选任何文件'
        statBadgeEl.textContent = '0 B'
        fileCard.classList.add('dimmed')
        if (!keepBusyOuter) {
          innerBusy = false
          updateBusyUI()
        }
        showNotice('未勾选任何文件，无法生成附件', 'warn', '', 2000)
        return null
      }

      if (!keepBusyOuter) {
        innerBusy = true
        updateBusyUI()
      }

      const isZip = prefs.exportMode === 'zip'
      const stageLabel = isZip ? '正在压缩打包 ZIP...' : '正在合并生成 Markdown...'
      showProgress(stageLabel, 35, `共 ${selectedItems.length} 个文件`)
      await nextPaint()

      if (myToken !== repackToken) return null

      try {
        const artifact = await buildArtifact(
          selectedItems,
          prefs.exportMode,
          customFileName,
          (pct, curFile) => {
            if (myToken !== repackToken) return
            const mappedPct = 35 + Math.round(pct * 0.5)
            const sub = curFile ? `${curFile} (${pct}%)` : `共 ${selectedItems.length} 个文件 (${pct}%)`
            showProgress(stageLabel, mappedPct, sub)
          },
          () => myToken !== repackToken
        )

        if (!artifact || myToken !== repackToken) return null

        revokeCurrentUrl()
        currentArtifact = artifact
        currentArtifactUrl = URL.createObjectURL(artifact.blob)

        const suffix = artifact.engine === 'Native STORE' ? ' · 无压缩' : ''
        summaryTextEl.textContent = `${isZip ? '还原成功' : '合并完成'} (${selectedItems.length} 个文件${suffix})`
        statBadgeEl.textContent = formatBytes(artifact.blob.size)
        nameInputEl.value = artifact.name
        fileCardIcon.textContent = isZip ? '📦' : '📄'
        fileCard.classList.remove('dimmed')
        resultContainer.style.display = 'flex'
        updateAlerts()
        requestAnimationFrame(() => applyVerticalCenterPosition(panelEl, prefs.panelTopPct, 14))

        if (showSuccessNotice) {
          showNotice(
            `已生成 ${artifact.name}`,
            'success',
            `${selectedItems.length} 个文件 · ${formatBytes(artifact.blob.size)}`,
            2200
          )
        }
        return artifact
      } catch (err) {
        if (myToken === repackToken) {
          console.error('[BlockClip] 打包出错:', err)
          showNotice('打包生成失败', 'error', err?.message || String(err), 3400)
        }
        return null
      } finally {
        if (myToken === repackToken && !keepBusyOuter) {
          innerBusy = false
          updateBusyUI()
          syncModeUI()
        }
      }
    }

    async function processRawText(rawText, showSuccessNotice = true, keepBusyOuter = false) {
      if (!rawText || !rawText.trim()) {
        showNotice('未检测到文本内容', 'warn', '请先粘贴 BlockClip 导出的文本', 2000)
        return null
      }
      if (!keepBusyOuter) {
        if (busy) {
          showNotice('正在处理上一个任务，请稍候…', 'warn', '', 1600)
          return null
        }
        setOuterBusy(true)
      }

      try {
        showProgress('正在解析 BlockClip 代码结构...', 15, `原始文本 ${formatBytes(utf8ByteLength(rawText))}`)
        await nextPaint()

        const parsed = parseBlockClipText(rawText)
        if (parsed.length === 0) {
          showNotice('未匹配到 BlockClip 格式', 'error', '需包含 "File: 路径" 与代码块围栏', 3000)
          return null
        }

        showProgress(`已识别 ${parsed.length} 个片段，正在清洗合并...`, 30, '校验路径与敏感文件检测')
        await nextPaint()

        const merged = mergeParsedFiles(parsed)
        for (const item of merged) {
          if (item.isBinary && prefs.skipBinaryPlaceholders) item.selected = false
        }

        parsedFiles = merged
        customFileName = ''
        renderFileTree()
        return await rebuildCurrentSelection(showSuccessNotice, true)
      } catch (err) {
        console.error('[BlockClip] 解析处理出错:', err)
        showNotice('解析处理失败', 'error', err?.message || String(err), 3200)
        return null
      } finally {
        if (!keepBusyOuter) {
          setOuterBusy(false)
          syncModeUI()
        }
      }
    }

    async function runInstantPackAndInject(rawText) {
      if (busy) {
        showNotice('正在处理上一个任务，请稍候…', 'warn', '', 1600)
        return false
      }
      setOuterBusy(true)
      try {
        setRawText(rawText)
        const artifact = await processRawText(rawText, false, true)
        if (!artifact) return false
        return await performInjectArtifact(artifact)
      } catch (err) {
        console.error('[BlockClip] 秒传出错:', err)
        showNotice('秒传附件失败', 'error', err?.message || String(err), 3200)
        return false
      } finally {
        setOuterBusy(false)
        syncModeUI()
      }
    }

    async function runInstantFromClipboard() {
      if (busy) {
        showNotice('正在处理上一个任务，请稍候…', 'warn', '', 1600)
        return false
      }
      if (!SITE.findEditor()) {
        showNotice('未找到主对话输入框', 'error', '请确认当前处于对话或 Playground 页面', 2600)
        return false
      }
      setOuterBusy(true)
      try {
        showProgress('正在读取剪贴板...', 5)
        await nextPaint()
        let clipText
        try {
          clipText = await readClipboardActive()
        } catch (err) {
          console.error('[BlockClip] 剪贴板读取异常:', err)
          showNotice(
            IS_FIREFOX ? 'Firefox 剪贴板读取受阻' : '剪贴板访问被拒绝',
            'error',
            IS_FIREFOX
              ? '请开启“聊天框粘贴自动转附件”，直接 Ctrl+V 免弹窗上传'
              : '请在地址栏左侧允许剪贴板权限，或展开面板后 Ctrl+V',
            3800
          )
          return false
        }
        if (!clipText || !clipText.trim()) {
          showNotice('剪贴板为空', 'warn', '请先使用 BlockClip 复制代码', 2200)
          return false
        }
        setRawText(clipText)
        const artifact = await processRawText(clipText, false, true)
        if (!artifact) return false
        return await performInjectArtifact(artifact)
      } catch (err) {
        console.error('[BlockClip] 一键剪贴板秒传异常:', err)
        showNotice('一键秒传失败', 'error', err?.message || String(err), 3200)
        return false
      } finally {
        setOuterBusy(false)
        syncModeUI()
      }
    }

    const processBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-btn-primary',
        onClick: async () => await processRawText(getActiveRawText(), true)
      },
      '⚡ 还原层级并打包 ZIP'
    )

    const panelHeaderEl = safeEl(
      'div',
      { className: 'bc-header', title: '按住标题栏可上下拖动面板位置' },
      safeEl(
        'div',
        { className: 'bc-title-wrap' },
        safeEl('span', { className: 'bc-drag-hint' }, '⋮⋮'),
        safeEl('span', { className: 'bc-title' }, '📦 BlockClip to ZIP'),
        safeEl('span', { className: 'bc-tag' }, IS_AISTUDIO ? 'AI Studio' : 'Gemini'),
        safeEl('span', { style: { fontSize: '10.5px', opacity: '0.65' } }, 'v3.1.1')
      ),
      safeEl('div', { className: 'bc-actions' }, settingsBtn, clearBtn, closeBtn)
    )

    const panelEl = safeEl(
      'div',
      { className: 'bc-panel hidden' },
      panelHeaderEl,
      safeEl(
        'div',
        { className: 'bc-body' },
        settingsEl,
        safeEl(
          'div',
          { className: 'bc-toolbar' },
          safeEl('div', { className: 'bc-seg' }, modeZipBtn, modeMdBtn),
          instantClipboardBtn
        ),
        safeEl(
          'div',
          { className: 'bc-delivery-row' },
          safeEl('span', {}, '附件投递模式'),
          safeEl('div', { className: 'bc-seg' }, deliveryBtns)
        ),
        safeEl(
          'div',
          {},
          safeEl('div', { className: 'bc-input-header' }, safeEl('span', {}, 'BlockClip Markdown 内容:'), pasteBtn),
          largeBadgeEl,
          textareaEl
        ),
        processBtn,
        inlineProgBox,
        resultContainer,
        safeEl(
          'div',
          { className: 'bc-footer-hint' },
          '快捷键：Alt+B 开关面板 · Alt+Shift+Z 秒传 · 标题栏/侧边标签可上下拖动'
        )
      )
    )

    attachVerticalDrag(sideTabBtn, sideTabBtn, 'sideTabTopPct', { marginPx: 12 })
    attachVerticalDrag(panelHeaderEl, panelEl, 'panelTopPct', {
      ignoreSelector: 'button, input, textarea, a, label',
      marginPx: 14
    })

    for (const evType of ['paste', 'keydown', 'keyup', 'keypress', 'input']) {
      panelEl.addEventListener(evType, (e) => {
        if (evType === 'keydown') {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            if (shadow.activeElement === nameInputEl) return
            e.preventDefault()
            e.stopPropagation()
            processRawText(getActiveRawText(), true)
            return
          }
        }
        e.stopPropagation()
      })
    }

    function setPanelOpen(nextOpen) {
      isOpen = Boolean(nextOpen)
      if (isOpen) {
        syncTheme()
        panelEl.classList.remove('hidden')
        sideTabBtn.classList.add('hidden')
        requestAnimationFrame(() => {
          applyVerticalCenterPosition(panelEl, prefs.panelTopPct, 14)
          textareaEl.focus({ preventScroll: true })
        })
      } else {
        panelEl.classList.add('hidden')
        sideTabBtn.classList.remove('hidden')
        requestAnimationFrame(() => applyVerticalCenterPosition(sideTabBtn, prefs.sideTabTopPct, 12))
      }
    }

    function styleInlineBtn(btn) {
      Object.assign(btn.style, {
        display: 'inline-flex',
        alignItems: 'center',
        alignSelf: 'center',
        gap: '4px',
        height: '28px',
        padding: '0 10px',
        margin: '0 4px',
        backgroundColor: 'rgba(59, 130, 246, 0.14)',
        color: 'inherit',
        border: '1px solid rgba(59, 130, 246, 0.36)',
        borderRadius: '999px',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: '500',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        lineHeight: '1',
        flex: '0 0 auto',
        transition: 'background-color 0.12s ease, opacity 0.12s ease, border-color 0.12s ease',
        userSelect: 'none',
        opacity: busy ? '0.5' : '0.88'
      })
      btn.onmouseenter = () => {
        if (busy) return
        btn.style.opacity = '1'
        btn.style.backgroundColor = 'rgba(59, 130, 246, 0.24)'
        btn.style.borderColor = 'rgba(59, 130, 246, 0.55)'
      }
      btn.onmouseleave = () => {
        btn.style.backgroundColor = 'rgba(59, 130, 246, 0.14)'
        btn.style.borderColor = 'rgba(59, 130, 246, 0.36)'
        btn.style.opacity = busy ? '0.5' : '0.88'
      }
    }

    function styleFloatingBtn(btn) {
      Object.assign(btn.style, {
        position: 'fixed',
        right: '24px',
        top: `${prefs.floatingBtnTopPct}%`,
        transform: 'translateY(-50%)',
        zIndex: '2147483645',
        height: '34px',
        padding: '0 14px',
        backgroundColor: '#2563eb',
        color: '#ffffff',
        border: 'none',
        borderRadius: '999px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: '13px',
        fontWeight: '600',
        cursor: 'grab',
        boxShadow: '0 4px 14px rgba(37, 99, 235, 0.32)',
        userSelect: 'none',
        touchAction: 'none',
        opacity: busy ? '0.5' : '1'
      })
      btn.title = '上下拖动可调整位置 · 点击将剪贴板 BlockClip 秒传为附件 (Alt+Shift+Z)'
      attachVerticalDrag(btn, btn, 'floatingBtnTopPct', { marginPx: 14 })
    }

    function createInlineButton() {
      const btn = safeEl(
        'button',
        {
          id: INLINE_BTN_ID,
          type: 'button',
          title: '将剪贴板中的 BlockClip 代码一键打包并秒传为附件 (快捷键: Alt+Shift+Z | 面板: Alt+B)'
        },
        prefs.exportMode === 'zip' ? '📦 粘贴为ZIP' : '📄 粘贴为MD'
      )
      btn.addEventListener('click', (e) => {
        if (btn.dataset.bcSuppressClick === '1') return
        e.preventDefault()
        e.stopPropagation()
        runInstantFromClipboard()
      })
      return btn
    }

    function usableSlot() {
      const slot = SITE.findSlot()
      if (!slot || !isVisibleOnce(slot.parent)) return null
      if (failedSlotParent && failedSlotParent === slot.parent && failedSlotParent.isConnected) {
        const cooldown = Math.min(
          FAILED_SLOT_MAX_COOLDOWN_MS,
          FAILED_SLOT_BASE_COOLDOWN_MS * 2 ** Math.min(failedSlotCount - 1, 5)
        )
        if (Date.now() - failedSlotAt < cooldown) return null
      } else if (failedSlotParent && failedSlotParent !== slot.parent) {
        failedSlotParent = null
        failedSlotAt = 0
        failedSlotCount = 0
      }
      return slot
    }

    function ensureMounts(verifyVisibility = false) {
      const mountParent = document.body || document.documentElement
      if (hostEl && mountParent && !hostEl.isConnected) mountParent.appendChild(hostEl)

      if (cachedInlineBtn?.isConnected && cachedInlineBtn.dataset.floating !== '1') {
        if (!verifyVisibility || isVisibleOnce(cachedInlineBtn)) return
        cachedInlineBtn.remove()
        cachedInlineBtn = null
      }

      const editor = SITE.findEditor()
      if (!editor) {
        if (cachedInlineBtn && cachedInlineBtn.dataset.floating === '1') {
          cachedInlineBtn.remove()
          cachedInlineBtn = null
        }
        return
      }

      const existing = cachedInlineBtn?.isConnected ? cachedInlineBtn : document.getElementById(INLINE_BTN_ID)
      let slot = null

      if (existing) {
        if (existing.dataset.floating === '1') {
          slot = usableSlot()
          if (!slot) {
            cachedInlineBtn = existing
            return
          }
          const probe = createInlineButton()
          const before = slot.before && slot.before.parentElement === slot.parent ? slot.before : null
          styleInlineBtn(probe)
          slot.parent.insertBefore(probe, before)
          if (isVisibleOnce(probe)) {
            existing.remove()
            failedSlotParent = null
            failedSlotAt = 0
            failedSlotCount = 0
            cachedInlineBtn = probe
            return
          }
          probe.remove()
          failedSlotParent = slot.parent
          failedSlotAt = Date.now()
          failedSlotCount += 1
          cachedInlineBtn = existing
          return
        } else if (isVisibleOnce(existing)) {
          cachedInlineBtn = existing
          return
        }
        existing.remove()
      }

      if (!slot) slot = usableSlot()
      const btn = createInlineButton()

      if (slot) {
        const before = slot.before && slot.before.parentElement === slot.parent ? slot.before : null
        styleInlineBtn(btn)
        slot.parent.insertBefore(btn, before)
        if (isVisibleOnce(btn)) {
          failedSlotParent = null
          failedSlotAt = 0
          failedSlotCount = 0
          cachedInlineBtn = btn
          return
        }
        btn.remove()
        failedSlotCount = failedSlotParent === slot.parent ? failedSlotCount + 1 : 1
        failedSlotParent = slot.parent
        failedSlotAt = Date.now()
      }

      styleFloatingBtn(btn)
      btn.dataset.floating = '1'
      if (mountParent) {
        mountParent.appendChild(btn)
        applyVerticalCenterPosition(btn, prefs.floatingBtnTopPct, 14)
        cachedInlineBtn = btn
      }
    }

    function isEventFromHost(e) {
      if (!hostEl) return false
      if (e.target === hostEl || e.target === unwrap(hostEl)) return true
      try {
        if (e.composedPath) {
          const path = e.composedPath()
          if (path.includes(hostEl) || path.includes(unwrap(hostEl))) return true
        }
      } catch {}
      return e.target instanceof Node && hostEl.contains(e.target)
    }

    window.addEventListener(
      'keydown',
      (e) => {
        if (e.repeat) return
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyB' || e.key.toLowerCase() === 'b')) {
          e.preventDefault()
          e.stopPropagation()
          setPanelOpen(!isOpen)
          return
        }
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyZ' || e.key.toLowerCase() === 'z')) {
          e.preventDefault()
          e.stopPropagation()
          runInstantFromClipboard()
          return
        }
        if (e.key === 'Escape' && isOpen) {
          if (e.isComposing || e.key === 'Process') return
          if (shadow.activeElement === nameInputEl) return
          e.preventDefault()
          e.stopPropagation()
          setPanelOpen(false)
        }
      },
      true
    )

    window.addEventListener(
      'paste',
      (e) => {
        if (isDispatchingSynthetic || !e.isTrusted || isEventFromHost(e)) return
        const cd = e.clipboardData
        if (!cd || (cd.files && cd.files.length > 0)) return
        const text = cd.getData('text/plain')
        const probe = estimateBlockClipForChat(text)
        if (!probe.match) return

        const editor = SITE.findEditor()
        if (!editor) return
        const active = document.activeElement
        const target = e.target
        const inEditor =
          editor === active ||
          editor === target ||
          (active && editor.contains(active)) ||
          (target instanceof Node && editor.contains(target))
        if (!inEditor) return

        if (prefs.autoInterceptChatPaste) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          runInstantPackAndInject(text)
        } else {
          showPastePill(probe.estimatedFiles, text, editor)
        }
      },
      true
    )

    function syncAllVerticalPositions() {
      applyVerticalCenterPosition(sideTabBtn, prefs.sideTabTopPct, 12)
      if (isOpen) applyVerticalCenterPosition(panelEl, prefs.panelTopPct, 14)
      if (cachedInlineBtn?.isConnected && cachedInlineBtn.dataset.floating === '1') {
        applyVerticalCenterPosition(cachedInlineBtn, prefs.floatingBtnTopPct, 14)
      }
    }

    window.addEventListener('resize', () => {
      requestAnimationFrame(syncAllVerticalPositions)
    })

    let checkQueued = false
    let lastCheckTime = 0
    let observersActive = false

    const domObserver = new MutationObserver(() => {
      if (cachedInlineBtn?.isConnected && cachedInlineBtn.dataset.floating !== '1' && hostEl.isConnected) return
      if (checkQueued) return
      checkQueued = true
      const elapsed = performance.now() - lastCheckTime
      const delay = elapsed >= OBSERVER_THROTTLE_MS ? 0 : OBSERVER_THROTTLE_MS - elapsed
      setTimeout(() => {
        requestAnimationFrame(() => {
          checkQueued = false
          lastCheckTime = performance.now()
          ensureMounts(false)
        })
      }, delay)
    })

    const themeObserver = new MutationObserver(() => {
      scheduleSyncTheme()
    })

    const colorSchemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)')
    colorSchemeMedia?.addEventListener?.('change', scheduleSyncTheme)

    let sweepTimer = null

    function startObservers() {
      if (observersActive) return
      observersActive = true
      if (document.body) {
        domObserver.observe(document.body, { childList: true, subtree: true })
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme']
        })
      }
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme']
      })
      if (!sweepTimer) {
        sweepTimer = setInterval(() => {
          if (document.visibilityState === 'visible') ensureMounts(true)
        }, SWEEP_MS)
      }
    }

    function stopObservers() {
      observersActive = false
      domObserver.disconnect()
      themeObserver.disconnect()
      if (sweepTimer) {
        clearInterval(sweepTimer)
        sweepTimer = null
      }
    }

    startObservers()

    window.addEventListener(
      'pagehide',
      (e) => {
        clearAllResiduals()
        stopObservers()
        if (!e.persisted) revokeCurrentUrl()
      },
      true
    )

    window.addEventListener(
      'pageshow',
      () => {
        if (!busy) clearAllResiduals()
        startObservers()
        syncTheme()
        ensureMounts(true)
        syncAllVerticalPositions()
      },
      true
    )

    window.addEventListener(
      'popstate',
      () => {
        if (!busy) clearAllResiduals()
        ensureMounts(true)
      },
      true
    )

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (!busy) clearAllResiduals()
        startObservers()
        syncTheme()
        ensureMounts(true)
        syncAllVerticalPositions()
      }
    })

    shadow.appendChild(hudEl)
    shadow.appendChild(pastePillEl)
    shadow.appendChild(panelEl)
    shadow.appendChild(sideTabBtn)

    syncModeUI()
    ensureMounts(true)
    requestAnimationFrame(syncAllVerticalPositions)
  }

  if (document.body) boot()
  else document.addEventListener('DOMContentLoaded', boot, { once: true })
})()
