// ==UserScript==
// @name         BlockClip to ZIP for Gemini & AI Studio
// @namespace    https://github.com/symudo/block-clip
// @version      2.1.2
// @description  将 BlockClip 复制的代码还原为目录层级并打包为 ZIP（或单文件 Markdown 附件），支持粘贴自动打包、快捷键/右键一键直通、页内丝滑拖拽上传至 Gemini & AI Studio，全面兼容 Chrome/Edge/Firefox 与 Trusted Types
// @author       symudo
// @match        https://gemini.google.com/*
// @match        https://aistudio.google.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=gemini.google.com
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-end
// @noframes
// ==/UserScript==

;(() => {
  // 防止在 iframe 中注入或重复初始化
  if (window.top !== window.self) return
  if (document.getElementById('blockclip-to-zip-root')) return

  const HOST_ID = 'blockclip-to-zip-root'
  const STORAGE_KEY = 'blockclip_to_zip_prefs_v2'
  const LARGE_TEXT_THRESHOLD = 250 * 1024 // 250 KB 以上启用内存直通，避免 textarea 排版卡顿
  const PREVIEW_CHAR_LIMIT = 2400
  const IS_GEMINI = location.hostname.includes('gemini.google.com')
  const IS_AISTUDIO = location.hostname.includes('aistudio.google.com')
  const IS_FIREFOX = /firefox/i.test(navigator.userAgent)

  const SHARED_ENCODER = new TextEncoder()

  /* ==========================================================================
     1. 持久化配置管理（优先 GM 沙箱存储，降级 localStorage）
     ========================================================================== */

  const DEFAULT_PREFS = {
    autoPackOnPaste: true,
    skipBinaryPlaceholders: true,
    autoCloseAfterInject: true,
    autoInterceptChatPaste: false,
    exportMode: 'zip', // 'zip' | 'single_md'
    floatSide: 'right', // 'left' | 'right'
    floatBottom: 88
  }

  function loadPrefs() {
    try {
      let raw = null
      if (typeof GM_getValue === 'function') {
        raw = GM_getValue(STORAGE_KEY, null)
      }
      if (!raw) {
        raw = localStorage.getItem(STORAGE_KEY)
      }
      if (!raw) return { ...DEFAULT_PREFS }
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      return { ...DEFAULT_PREFS, ...parsed }
    } catch {
      return { ...DEFAULT_PREFS }
    }
  }

  function savePrefs(prefs) {
    try {
      const serialized = JSON.stringify(prefs)
      if (typeof GM_setValue === 'function') {
        GM_setValue(STORAGE_KEY, serialized)
      } else {
        localStorage.setItem(STORAGE_KEY, serialized)
      }
    } catch {
      // 忽略隐私模式或配额异常
    }
  }

  /* ==========================================================================
     2. 核心解析、路径清洗与安全检测模块
     ========================================================================== */

  const FILE_HEADER_REGEX = /^File:\s*(.+?)(?:\s*\((lines?\s*[\d\s,-]+)\))?\s*$/i
  const FENCE_START_REGEX = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/

  function normalizePath(filePath) {
    if (!filePath) return ''
    let normalized = String(filePath).trim()

    // 剥离成对的反引号或引号
    if (
      normalized.length >= 2 &&
      normalized[0] === normalized[normalized.length - 1] &&
      (normalized[0] === '`' || normalized[0] === '"' || normalized[0] === "'")
    ) {
      normalized = normalized.slice(1, -1).trim()
    }

    normalized = normalized.replace(/\\/g, '/')
    // 剔除 Windows 盘符（如 C:/）
    normalized = normalized.replace(/^[a-zA-Z]:\/+/, '')

    const segments = []
    for (const rawSeg of normalized.split('/')) {
      const seg = rawSeg.trim()
      if (!seg || seg === '.') continue
      if (seg === '..') {
        // 安全弹栈，杜绝 Zip Slip
        if (segments.length > 0) segments.pop()
        continue
      }
      // 使用 Unicode 控制字符属性类 \p{Cc}，彻底规避 ESLint / Biome noControlCharactersInRegex 报错
      const cleaned = seg.replace(/[\p{Cc}<>:"|?*]/gu, '_')
      if (cleaned && cleaned !== '.' && cleaned !== '..') {
        segments.push(cleaned)
      }
    }

    return segments.join('/')
  }

  function parseBlockClipText(rawText) {
    if (!rawText || !rawText.trim()) return []

    // 剔除首行可能携带的 UTF-8 BOM 并统一换行符
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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (inCodeBlock) {
        if (fenceEndRegex?.test(line)) {
          finalizeCurrentFile()
        } else {
          codeLines.push(line)
        }
        continue
      }

      const fileMatch = line.match(FILE_HEADER_REGEX)
      if (fileMatch) {
        if (currentFile) {
          if (!currentFile.hasCodeBlock) {
            currentFile.isBinary = true
          }
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
          // CommonMark 规范：反引号围栏的 info string 不能包含反引号
          if (fenceStr[0] === '`' && infoStr.includes('`')) {
            continue
          }
          const fenceChar = fenceStr[0] === '`' ? '`' : '~'
          const fenceLen = fenceStr.length
          // 仅在进入代码块时预编译一次，限制最多 3 空格缩进，避免代码内缩进反引号误闭合
          fenceEndRegex = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}\\s*$`)
          const langToken = infoStr ? infoStr.split(/\s+/)[0] : 'plaintext'
          currentFile.language = langToken || 'plaintext'
          currentFile.hasCodeBlock = true
          inCodeBlock = true
          codeLines = []
          continue
        }

        if (line.trim() === '---') {
          currentFile.isBinary = true
          finalizeCurrentFile()
        }
      }
    }

    if (currentFile) {
      if (!inCodeBlock && !currentFile.hasCodeBlock) {
        currentFile.isBinary = true
      }
      finalizeCurrentFile()
    }

    return results
  }

  function looksLikeMultiFileBlockClip(text) {
    if (!text || text.length < 24 || !text.includes('File:')) return false
    const clean = text.replace(/^\uFEFF/, '')
    const matches = clean.match(/^File:\s*.+$/gim)
    if (!matches || matches.length < 2) return false
    return /^ {0,3}(`{3,}|~{3,})/m.test(clean)
  }

  function getCommentBlock(relativePath, language, commentText) {
    const baseName = (relativePath.split('/').pop() || '').toLowerCase()
    const dotIdx = baseName.lastIndexOf('.')
    const ext = dotIdx > 0 ? baseName.slice(dotIdx + 1) : ''
    const lang = (language || '').toLowerCase()

    // 优先匹配无后缀特殊文件名
    if (
      baseName === 'dockerfile' ||
      baseName.startsWith('dockerfile.') ||
      baseName === 'makefile' ||
      baseName === 'jenkinsfile' ||
      baseName === '.gitignore' ||
      baseName === '.dockerignore' ||
      baseName === '.env' ||
      baseName.startsWith('.env.')
    ) {
      return `# ==================== ${commentText} ====================`
    }

    const key = ext || lang
    switch (key) {
      case 'py':
      case 'pyi':
      case 'python':
      case 'sh':
      case 'bash':
      case 'zsh':
      case 'fish':
      case 'shell':
      case 'yaml':
      case 'yml':
      case 'rb':
      case 'ruby':
      case 'pl':
      case 'perl':
      case 'r':
      case 'toml':
      case 'ini':
      case 'conf':
      case 'cfg':
      case 'properties':
      case 'ps1':
      case 'powershell':
      case 'tf':
      case 'hcl':
      case 'dockerfile':
      case 'makefile':
        return `# ==================== ${commentText} ====================`
      case 'html':
      case 'htm':
      case 'xml':
      case 'svg':
      case 'vue':
      case 'svelte':
      case 'md':
      case 'markdown':
        return `<!-- ==================== ${commentText} ==================== -->`
      case 'sql':
      case 'lua':
      case 'hs':
      case 'haskell':
      case 'elm':
        return `-- ==================== ${commentText} ====================`
      case 'css':
      case 'scss':
      case 'less':
        return `/* ==================== ${commentText} ==================== */`
      case 'bat':
      case 'cmd':
        return `REM ==================== ${commentText} ====================`
      default:
        return `// ==================== ${commentText} ====================`
    }
  }

  function isSensitiveFile(relativePath) {
    const lower = relativePath.toLowerCase()
    const base = lower.split('/').pop() || ''
    if (/^\.env(\..+)?$/.test(base)) {
      if (/\.(example|sample|template|dist)$/.test(base)) return false
      return true
    }
    if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base)) return true
    if (/^(id_rsa|id_ed25519|id_ecdsa|id_dsa|\.npmrc|\.pypirc|\.netrc)$/.test(base)) return true
    if (/(secret|credential|private[_-]?key)/.test(base) && !/(\.example|\.sample|\.mock|\.test\.)/.test(base)) {
      return true
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
            const header = getCommentBlock(relativePath, data.language, `BlockClip Snippet (${snippet.lineRange})`)
            sections.push(`${header}\n${snippet.content}`)
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
        byteSize: SHARED_ENCODER.encode(content).byteLength,
        isBinary: false,
        isSensitive: isSensitiveFile(relativePath),
        snippetsCount: data.snippets.length,
        selected: true
      })
    }

    // 处理“同名文件与目录冲突”（例如同时存在 foo 和 foo/bar.ts）
    const dirPrefixes = new Set()
    for (const item of mergedList) {
      const parts = item.relativePath.split('/')
      for (let i = 1; i < parts.length; i++) {
        dirPrefixes.add(parts.slice(0, i).join('/'))
      }
    }
    for (const item of mergedList) {
      if (dirPrefixes.has(item.relativePath)) {
        item.relativePath = `${item.relativePath}_file`
      }
    }

    // 路径按层级自然排序（目录优先于同级文件）
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

  function inferSmartFilename(files, ext) {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

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
        if (rootName && rootName.length <= 40) {
          return `${rootName}_${timePart}.${ext}`
        }
      }
    }

    return `blockclip_${datePart}_${timePart}.${ext}`
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
    return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`
  }

  /* ==========================================================================
     3. 打包引擎（JSZip 主引擎 + 零依赖 STORE ZIP 兜底 + 单文件 Markdown 导出）
     ========================================================================== */

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let j = 0; j < 8; j++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      table[i] = c >>> 0
    }
    return table
  })()

  function computeCrc32(bytes) {
    let crc = 0xffffffff
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  // 零外部依赖标准 PKZIP (STORE + UTF-8 Flag 0x0800) 兜底生成器，防止 CDN 故障导致脚本瘫痪
  function createFallbackStoreZipBlob(items) {
    const now = new Date()
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
    const dosDate = (Math.max(0, now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()

    const localChunks = []
    const centralChunks = []
    let offset = 0

    for (const item of items) {
      const nameBytes = SHARED_ENCODER.encode(item.relativePath)
      const dataBytes = SHARED_ENCODER.encode(item.isBinary && !item.content ? '' : item.content)
      const crc = computeCrc32(dataBytes)
      const size = dataBytes.length
      const nameLen = nameBytes.length

      // Local File Header (30 bytes)
      const localHdr = new Uint8Array(30)
      const lv = new DataView(localHdr.buffer)
      lv.setUint32(0, 0x04034b50, true)
      lv.setUint16(4, 20, true)
      lv.setUint16(6, 0x0800, true) // UTF-8
      lv.setUint16(8, 0, true) // STORE
      lv.setUint16(10, dosTime, true)
      lv.setUint16(12, dosDate, true)
      lv.setUint32(14, crc, true)
      lv.setUint32(18, size, true)
      lv.setUint32(22, size, true)
      lv.setUint16(26, nameLen, true)
      lv.setUint16(28, 0, true)

      localChunks.push(localHdr, nameBytes, dataBytes)

      // Central Directory Header (46 bytes)
      const centralHdr = new Uint8Array(46)
      const cv = new DataView(centralHdr.buffer)
      cv.setUint32(0, 0x02014b50, true)
      cv.setUint16(4, 20, true)
      cv.setUint16(6, 20, true)
      cv.setUint16(8, 0x0800, true)
      cv.setUint16(10, 0, true)
      cv.setUint16(12, dosTime, true)
      cv.setUint16(14, dosDate, true)
      cv.setUint32(16, crc, true)
      cv.setUint32(20, size, true)
      cv.setUint32(24, size, true)
      cv.setUint16(28, nameLen, true)
      cv.setUint16(30, 0, true)
      cv.setUint16(32, 0, true)
      cv.setUint16(34, 0, true)
      cv.setUint16(36, 0, true)
      cv.setUint32(38, 0, true)
      cv.setUint32(42, offset, true)

      centralChunks.push(centralHdr, nameBytes)
      offset += 30 + nameLen + size
    }

    let centralSize = 0
    for (const chunk of centralChunks) centralSize += chunk.length

    // End of Central Directory (22 bytes)
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

    return new Blob([...localChunks, ...centralChunks, eocd], { type: 'application/zip' })
  }

  function buildDirectoryTreeText(items) {
    const root = new Map()
    for (const item of items) {
      const parts = item.relativePath.split('/')
      let node = root
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const isFile = i === parts.length - 1
        if (!node.has(part)) {
          node.set(part, isFile ? null : new Map())
        }
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
        const connector = isLast ? '└── ' : '├── '
        lines.push(`${prefix}${connector}${name}${child ? '/' : ''}`)
        if (child) {
          walk(child, prefix + (isLast ? '    ' : '│   '))
        }
      })
    }
    walk(root, '')
    return lines.join('\n')
  }

  function createSingleMarkdownBlob(items) {
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

    for (const item of items) {
      parts.push(`### File: \`${item.relativePath}\``)
      if (item.isBinary && !item.content) {
        parts.push('_Binary file placeholder (empty)_', '')
        continue
      }
      // 自动计算安全围栏长度，避免文件内容中的反引号冲突
      const backtickMatches = item.content.match(/`{3,}/g)
      let fenceLen = 3
      if (backtickMatches) {
        for (const m of backtickMatches) {
          if (m.length >= fenceLen) fenceLen = m.length + 1
        }
      }
      const fence = '`'.repeat(fenceLen)
      const lang = item.language && item.language !== 'plaintext' ? item.language : ''
      parts.push(`${fence}${lang}`, item.content, fence, '')
    }

    return new Blob([parts.join('\n')], { type: 'text/markdown;charset=utf-8' })
  }

  async function buildArtifact(items, exportMode, customName, onProgress) {
    if (exportMode === 'single_md') {
      const blob = createSingleMarkdownBlob(items)
      const base = customName ? customName.replace(/\.(zip|md|txt)$/i, '') : null
      const name = base ? `${base}.md` : inferSmartFilename(items, 'md')
      const file = new File([blob], name, { type: 'text/markdown' })
      return { blob, file, name, mime: 'text/markdown', engine: 'Markdown' }
    }

    const ZipCtor = typeof JSZip !== 'undefined' ? JSZip : typeof window !== 'undefined' ? window.JSZip : null
    const base = customName ? customName.replace(/\.(zip|md|txt)$/i, '') : null
    const name = base ? `${base}.zip` : inferSmartFilename(items, 'zip')

    let blob
    let engine = 'JSZip'

    if (ZipCtor) {
      const zip = new ZipCtor()
      for (const item of items) {
        zip.file(item.relativePath, item.isBinary && !item.content ? '' : item.content)
      }
      blob = await zip.generateAsync(
        {
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 4 } // 兼顾速度与压缩率的甜蜜点
        },
        (meta) => {
          if (typeof onProgress === 'function') {
            onProgress(Math.round(meta.percent || 0))
          }
        }
      )
    } else {
      engine = 'Built-in STORE'
      blob = createFallbackStoreZipBlob(items)
    }

    const file = new File([blob], name, { type: 'application/zip' })
    return { blob, file, name, mime: 'application/zip', engine }
  }

  /* ==========================================================================
     4. 零 innerHTML 安全 DOM 构建工具（100% 免疫 Trusted Types）
     ========================================================================== */

  const BOOL_PROPS = new Set(['disabled', 'checked', 'readOnly', 'hidden', 'multiple', 'draggable', 'selected'])

  function safeEl(tag, props, ...children) {
    const el = document.createElement(tag)
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (val === undefined || val === null) continue
        if (key === 'className') {
          el.className = val
        } else if (key === 'style' && typeof val === 'object') {
          Object.assign(el.style, val)
        } else if (key.startsWith('on') && typeof val === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), val)
        } else if (key === 'textContent') {
          el.textContent = String(val)
        } else if (key === 'value') {
          el.value = String(val)
        } else if (BOOL_PROPS.has(key)) {
          el[key] = Boolean(val)
        } else {
          el.setAttribute(key, String(val))
        }
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
          if (item instanceof Node) {
            el.appendChild(item)
          } else if (item !== undefined && item !== null && item !== false) {
            el.appendChild(document.createTextNode(String(item)))
          }
        }
      }
    }

    return el
  }

  /* ==========================================================================
     5. 多通道附件注入引擎（修复 Firefox Xray 跨沙箱 File 构造 + 三通道注入）
     ========================================================================== */

  const PAGE_WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window.wrappedJSObject || window

  const NEEDS_XRAY_BRIDGE = typeof cloneInto === 'function' && PAGE_WIN !== window

  // 在 Firefox Xray 沙箱下，直接把原始字节数组克隆到页面空间并构造同域 File，
  // 彻底避免 cloneInto(sandboxFile, PAGE_WIN) 因无法克隆 DOM 反射器而静默降级失效
  async function createPageFile(file) {
    if (!NEEDS_XRAY_BRIDGE || !PAGE_WIN.File || !PAGE_WIN.Uint8Array) {
      return { file, rawFile: file, isPageSide: false }
    }
    try {
      const srcBytes = new Uint8Array(await file.arrayBuffer())
      let pageBytes
      try {
        pageBytes = cloneInto(srcBytes, PAGE_WIN)
      } catch {
        pageBytes = new PAGE_WIN.Uint8Array(srcBytes.length)
        pageBytes.set(srcBytes)
      }

      const pageParts = new PAGE_WIN.Array()
      pageParts.push(pageBytes)

      const pageOpts = cloneInto(
        {
          type: file.type || '',
          lastModified: file.lastModified || Date.now()
        },
        PAGE_WIN
      )

      const pageFile = new PAGE_WIN.File(pageParts, file.name, pageOpts)
      return { file: pageFile, rawFile: file, isPageSide: true }
    } catch {
      return { file, rawFile: file, isPageSide: false }
    }
  }

  // 基于已预处理的同域 File 同步构建 DataTransfer，避免跨通道重复 arrayBuffer() 拷贝并保护观测窗口
  function createPageDataTransferFromPrepared(prepared) {
    if (prepared?.isPageSide && PAGE_WIN.DataTransfer) {
      try {
        const dt = new PAGE_WIN.DataTransfer()
        dt.items.add(prepared.file)
        return { dt, isPageSide: true }
      } catch {
        // 降级到当前上下文构造
      }
    }
    const dt = new DataTransfer()
    dt.items.add((prepared && (prepared.rawFile || prepared.file)) || prepared)
    return { dt, isPageSide: false }
  }

  function createPageEvent(ctorName, type, initObj, usePageSide = true) {
    if (usePageSide && NEEDS_XRAY_BRIDGE && PAGE_WIN[ctorName]) {
      try {
        const clonedInit = cloneInto(initObj, PAGE_WIN, { wrapReflectors: true })
        return { event: new PAGE_WIN[ctorName](type, clonedInit), isPageSide: true }
      } catch {
        // 降级到当前上下文构造
      }
    }
    const Ctor = window[ctorName] || Event
    return { event: new Ctor(type, initObj), isPageSide: false }
  }

  // 确保事件对象与派发目标严格同侧（避免 Firefox Xray 跨 compartment 静默拒绝）
  function dispatchCompatEvent(target, eventObj, isPageSide) {
    if (isPageSide && target && target.wrappedJSObject) {
      try {
        return target.wrappedJSObject.dispatchEvent(eventObj)
      } catch {
        // 降级到 Xray 包装对象派发
      }
    }
    return target.dispatchEvent(eventObj)
  }

  function querySelectorLight(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector))
    } catch {
      return []
    }
  }

  function querySelectorAllDeep(selector, root = document, results = []) {
    try {
      const matched = root.querySelectorAll(selector)
      for (const node of matched) results.push(node)
    } catch {
      // 忽略非法选择器
    }
    const all = root.querySelectorAll('*')
    for (const el of all) {
      if (el.id === HOST_ID) continue
      if (el.shadowRoot) {
        querySelectorAllDeep(selector, el.shadowRoot, results)
      }
    }
    return results
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function findEditorElement() {
    const selectors = IS_GEMINI
      ? [
          'rich-textarea .ql-editor[contenteditable="true"]',
          'rich-textarea [contenteditable="true"]',
          '[contenteditable="true"][role="textbox"]',
          'rich-textarea',
          'textarea'
        ]
      : IS_AISTUDIO
        ? [
            'ms-autosize-textarea textarea',
            'textarea[aria-label]',
            'textarea',
            '[contenteditable="true"][role="textbox"]',
            '[contenteditable="true"]'
          ]
        : ['[contenteditable="true"]', 'textarea']

    // 优先 Light DOM 快速路径，避免长对话下全树扫描 Shadow DOM
    for (const sel of selectors) {
      const nodes = querySelectorLight(sel)
      const visible = nodes.find(isElementVisible)
      if (visible) return visible
    }

    for (const sel of selectors) {
      const nodes = querySelectorAllDeep(sel)
      const visible = nodes.find(isElementVisible)
      if (visible) return visible
      if (nodes[0]) return nodes[0]
    }
    return null
  }

  function isInputAcceptingFile(input, file) {
    if (!input || input.disabled || input.webkitdirectory || input.hasAttribute('webkitdirectory')) {
      return false
    }
    const accept = (input.getAttribute('accept') || '').trim().toLowerCase()
    if (!accept || accept === '*' || accept === '*/*') return true

    const isZip = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip'
    const tokens = accept.split(',').map((t) => t.trim())
    for (const t of tokens) {
      if (t === '*/*') return true
      if (isZip) {
        if (t === '.zip' || t === 'application/zip' || t === 'application/x-zip-compressed' || t === 'application/*') {
          return true
        }
      } else {
        if (t === '.md' || t === '.txt' || t === 'text/*' || t === 'text/plain' || t === 'text/markdown') {
          return true
        }
      }
    }
    return false
  }

  function findValidFileInputs(file) {
    let inputs = querySelectorLight('input[type="file"]').filter((el) => isInputAcceptingFile(el, file))
    if (inputs.length === 0) {
      inputs = querySelectorAllDeep('input[type="file"]').filter((el) => isInputAcceptingFile(el, file))
    }
    // 优先排无 accept 限制的通用上传 input
    inputs.sort((a, b) => {
      const aAccept = a.getAttribute('accept') ? 1 : 0
      const bAccept = b.getAttribute('accept') ? 1 : 0
      return aAccept - bAccept
    })
    return inputs
  }

  function findCandidateDropZones(customTarget) {
    const list = []
    if (customTarget && customTarget.nodeType === 1 && customTarget.isConnected) {
      list.push(customTarget)
    }

    const siteSelectors = IS_GEMINI
      ? [
          '[xapfileselectordropzone]',
          'xap-attachments-dropzone',
          '.input-area-container',
          '.text-input-field',
          'rich-textarea',
          'main'
        ]
      : IS_AISTUDIO
        ? ['ms-prompt-input-wrapper', '.prompt-input-wrapper', 'ms-autosize-textarea', 'textarea', 'main']
        : ['[contenteditable="true"]', 'textarea', 'main']

    for (const sel of siteSelectors) {
      const lightNodes = querySelectorLight(sel)
      const best = lightNodes.find(isElementVisible) || lightNodes[0]
      if (best && !list.includes(best)) {
        list.push(best)
      }
    }

    if (list.length === 0) {
      for (const sel of siteSelectors) {
        const nodes = querySelectorAllDeep(sel)
        const best = nodes.find(isElementVisible) || nodes[0]
        if (best && !list.includes(best)) {
          list.push(best)
        }
      }
    }

    const editor = findEditorElement()
    if (editor && !list.includes(editor)) {
      list.unshift(editor)
    }

    return list
  }

  function waitNextFrame(ms = 32) {
    return new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, ms))
    })
  }

  function observePageReaction(actionFn, fileName, timeoutMs = 450) {
    return new Promise((resolve) => {
      let settled = false
      let mutated = false

      const targetRoot = document.querySelector('main') || document.body
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.target && m.target.id === HOST_ID) continue
          if (m.addedNodes && m.addedNodes.length > 0) {
            for (const node of m.addedNodes) {
              if (node.nodeType !== 1) continue
              if (node.id === HOST_ID) continue
              const text = (node.textContent || '') + ' ' + (node.getAttribute?.('aria-label') || '')
              const cls = String(node.className || '').toLowerCase()
              const tag = node.tagName.toLowerCase()
              if (
                text.includes(fileName) ||
                cls.includes('file') ||
                cls.includes('attach') ||
                cls.includes('upload') ||
                cls.includes('chip') ||
                cls.includes('preview') ||
                cls.includes('progress') ||
                tag.includes('file') ||
                tag.includes('attachment') ||
                tag.includes('chip') ||
                tag === 'mat-progress-bar' ||
                tag === 'mat-spinner'
              ) {
                mutated = true
                break
              }
            }
          }
          if (mutated) break
        }

        if (mutated && !settled) {
          settled = true
          observer.disconnect()
          clearTimeout(timer)
          resolve(true)
        }
      })

      try {
        observer.observe(targetRoot, { childList: true, subtree: true })
      } catch {
        // 忽略观测失败
      }

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          observer.disconnect()
          resolve(mutated)
        }
      }, timeoutMs)

      Promise.resolve()
        .then(actionFn)
        .catch(() => {
          // 交由定时器自然收尾
        })
    })
  }

  async function dispatchDropSequence(zone, preparedFile) {
    const { dt, isPageSide } = createPageDataTransferFromPrepared(preparedFile)
    const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }

    const enter = createPageEvent('DragEvent', 'dragenter', init, isPageSide)
    dispatchCompatEvent(zone, enter.event, enter.isPageSide)
    await waitNextFrame(24)

    const over = createPageEvent('DragEvent', 'dragover', init, isPageSide)
    dispatchCompatEvent(zone, over.event, over.isPageSide)
    await waitNextFrame(24)

    const drop = createPageEvent('DragEvent', 'drop', init, isPageSide)
    dispatchCompatEvent(zone, drop.event, drop.isPageSide)
    return Boolean(drop.event.defaultPrevented)
  }

  async function injectAttachmentToPage(file, customDropTarget = null) {
    // 入口统一准备一次页面侧 File，后续所有通道零重复拷贝且不侵占 observePageReaction 计时窗口
    const preparedFile = await createPageFile(file)

    // 0. 若来自页内拖拽且有明确落点，优先在落点执行异步 Drop
    if (customDropTarget && customDropTarget.nodeType === 1) {
      let prevented = false
      const verified = await observePageReaction(
        async () => {
          prevented = await dispatchDropSequence(customDropTarget, preparedFile)
        },
        file.name,
        420
      )
      if (verified || prevented) {
        return { ok: true, verified, method: 'drop-target' }
      }
    }

    // 1. 通道 A：向编辑器派发 ClipboardEvent('paste')（240ms 快速回退，兼顾跟手与防重复上传）
    const editor = findEditorElement()
    if (editor) {
      let pastePrevented = false
      const verified = await observePageReaction(
        () => {
          try {
            editor.focus({ preventScroll: true })
          } catch {
            // 忽略聚焦失败
          }
          const { dt, isPageSide } = createPageDataTransferFromPrepared(preparedFile)
          const paste = createPageEvent(
            'ClipboardEvent',
            'paste',
            {
              bubbles: true,
              cancelable: true,
              composed: true,
              clipboardData: dt
            },
            isPageSide
          )
          dispatchCompatEvent(editor, paste.event, paste.isPageSide)
          pastePrevented = Boolean(paste.event.defaultPrevented)
        },
        file.name,
        240
      )
      if (verified || pastePrevented) {
        return { ok: true, verified, method: 'paste' }
      }
    }

    // 2. 通道 B：已过滤的有效 input[type="file"]（严格同侧对齐赋值）
    const validInputs = findValidFileInputs(file)
    for (const input of validInputs) {
      let assigned = false
      let lastRawInput = input
      const verified = await observePageReaction(
        () => {
          const { dt, isPageSide } = createPageDataTransferFromPrepared(preparedFile)
          const rawInput = isPageSide && input.wrappedJSObject ? input.wrappedJSObject : input
          lastRawInput = rawInput
          try {
            rawInput.files = dt.files
          } catch {
            if (rawInput !== input) {
              input.files = dt.files
              lastRawInput = input
            }
          }
          assigned = Boolean(lastRawInput.files && lastRawInput.files.length > 0)
          const inputEv = createPageEvent('Event', 'input', { bubbles: true, composed: true }, isPageSide)
          const changeEv = createPageEvent('Event', 'change', { bubbles: true, composed: true }, isPageSide)
          dispatchCompatEvent(input, inputEv.event, inputEv.isPageSide)
          dispatchCompatEvent(input, changeEv.event, changeEv.isPageSide)
        },
        file.name,
        450
      )
      if (verified) {
        return { ok: true, verified: true, method: 'file-input' }
      }
      if (assigned && validInputs.length === 1) {
        return { ok: true, verified: false, method: 'file-input' }
      }
      // 未触发有效上传且存在多个候选 input 时清理残留，避免影响后续通道
      if (assigned && validInputs.length > 1) {
        try {
          lastRawInput.value = ''
        } catch {
          // 忽略清空异常
        }
      }
    }

    // 3. 通道 C：站点 dropzone 异步 Drag & Drop 序列
    const dropZones = findCandidateDropZones(null)
    for (const zone of dropZones) {
      let prevented = false
      const verified = await observePageReaction(
        async () => {
          prevented = await dispatchDropSequence(zone, preparedFile)
        },
        file.name,
        420
      )
      if (verified || prevented) {
        return { ok: true, verified, method: 'dropzone' }
      }
    }

    return { ok: false, verified: false, method: 'none' }
  }

  /* ==========================================================================
     6. Shadow DOM 样式系统（自适应深浅主题 + 顶层 z-index + 跨浏览器滚动条）
     ========================================================================== */

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
      --bc-bg: rgba(24, 27, 34, 0.94);
      --bc-surface: rgba(38, 43, 54, 0.85);
      --bc-input-bg: rgba(14, 16, 22, 0.78);
      --bc-border: rgba(255, 255, 255, 0.12);
      --bc-text: #e6edf3;
      --bc-text-dim: #9aa5b4;
      --bc-primary: #3b82f6;
      --bc-primary-hover: #2563eb;
      --bc-accent: #10b981;
      --bc-warn-bg: rgba(245, 158, 11, 0.14);
      --bc-warn-border: rgba(245, 158, 11, 0.38);
      --bc-warn-text: #fbbf24;
      --bc-danger: #ef4444;
      --bc-shadow: 0 14px 38px rgba(0, 0, 0, 0.52), 0 2px 10px rgba(0, 0, 0, 0.28);
      --bc-scroll-thumb: rgba(255, 255, 255, 0.22);
    }

    :host([data-theme="light"]) {
      --bc-bg: rgba(255, 255, 255, 0.96);
      --bc-surface: rgba(243, 246, 250, 0.92);
      --bc-input-bg: rgba(248, 250, 252, 0.96);
      --bc-border: rgba(15, 23, 42, 0.12);
      --bc-text: #0f172a;
      --bc-text-dim: #64748b;
      --bc-warn-bg: rgba(245, 158, 11, 0.12);
      --bc-warn-border: rgba(217, 119, 6, 0.35);
      --bc-warn-text: #b45309;
      --bc-shadow: 0 14px 36px rgba(15, 23, 42, 0.18), 0 2px 10px rgba(15, 23, 42, 0.08);
      --bc-scroll-thumb: rgba(15, 23, 42, 0.22);
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    /* 自定义细窄滚动条（Chromium） */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: var(--bc-scroll-thumb);
      border-radius: 999px;
    }

    /* 独立置顶 Toast（面板收起时仍可见） */
    .bc-toast {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translate(-50%, -14px);
      padding: 8px 16px;
      background: #10b981;
      color: #fff;
      font-size: 12px;
      font-weight: 500;
      border-radius: 999px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 2147483647;
      max-width: min(520px, calc(100vw - 32px));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bc-toast.show {
      opacity: 1;
      transform: translate(-50%, 0);
    }

    /* 聊天框粘贴检测胶囊（非侵入式） */
    .bc-paste-pill {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translate(-50%, 16px);
      background: var(--bc-bg);
      color: var(--bc-text);
      border: 1px solid var(--bc-border);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border-radius: 999px;
      padding: 7px 10px 7px 14px;
      box-shadow: var(--bc-shadow);
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.22s ease, visibility 0.2s;
      z-index: 2147483646;
    }
    .bc-paste-pill.show {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translate(-50%, 0);
    }
    .bc-pill-btn {
      border: none;
      border-radius: 999px;
      padding: 4px 10px;
      background: var(--bc-primary);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .bc-pill-btn:hover {
      background: var(--bc-primary-hover);
    }
    .bc-pill-close {
      border: none;
      background: transparent;
      color: var(--bc-text-dim);
      cursor: pointer;
      padding: 2px 6px;
      font-size: 13px;
      border-radius: 50%;
    }
    .bc-pill-close:hover {
      color: var(--bc-text);
    }

    /* 可拖动悬浮球 */
    .bc-float-btn {
      position: fixed;
      width: 46px;
      height: 46px;
      border-radius: 50%;
      background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      box-shadow: 0 4px 16px rgba(59, 130, 246, 0.42);
      transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s ease, left 0.22s ease, right 0.22s ease;
      user-select: none;
      touch-action: none;
      font-size: 20px;
      border: 1px solid rgba(255, 255, 255, 0.25);
      z-index: 2147483645;
      outline: none;
    }
    .bc-float-btn.dragging {
      cursor: grabbing;
      transition: none;
      transform: scale(1.06);
    }
    .bc-float-btn:hover:not(.dragging) {
      transform: scale(1.08);
      box-shadow: 0 6px 22px rgba(59, 130, 246, 0.62);
    }
    .bc-float-btn:active:not(.dragging) {
      transform: scale(0.95);
    }

    /* 主面板 */
    .bc-panel {
      position: fixed;
      width: 450px;
      max-width: calc(100vw - 24px);
      background: var(--bc-bg);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid var(--bc-border);
      border-radius: 16px;
      box-shadow: var(--bc-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: opacity 0.22s ease, transform 0.24s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.22s;
      z-index: 2147483644;
    }
    .bc-panel.hidden {
      opacity: 0;
      visibility: hidden;
      transform: scale(0.93) translateY(10px);
      pointer-events: none;
    }
    .bc-panel.dragging-ghost {
      opacity: 0.16 !important;
      pointer-events: none !important;
    }

    /* 标题栏 */
    .bc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 11px 14px;
      border-bottom: 1px solid var(--bc-border);
      background: rgba(128, 128, 128, 0.05);
      flex-shrink: 0;
    }
    .bc-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .bc-title {
      font-weight: 600;
      font-size: 13.5px;
      color: var(--bc-text);
      white-space: nowrap;
    }
    .bc-tag {
      font-size: 10px;
      padding: 1px 6px;
      background: rgba(59, 130, 246, 0.16);
      color: #60a5fa;
      border-radius: 4px;
      border: 1px solid rgba(59, 130, 246, 0.3);
      white-space: nowrap;
    }
    :host([data-theme="light"]) .bc-tag {
      color: #2563eb;
    }
    .bc-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .bc-icon-btn {
      background: transparent;
      border: none;
      color: var(--bc-text-dim);
      padding: 4px 7px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.15s, color 0.15s;
    }
    .bc-icon-btn:hover {
      background: rgba(128, 128, 128, 0.14);
      color: var(--bc-text);
    }

    /* 主体区 */
    .bc-body {
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--bc-scroll-thumb) transparent;
    }

    /* 模式与快捷工具行 */
    .bc-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .bc-mode-switch {
      display: inline-flex;
      background: var(--bc-surface);
      border: 1px solid var(--bc-border);
      border-radius: 8px;
      padding: 2px;
      gap: 2px;
    }
    .bc-mode-btn {
      border: none;
      background: transparent;
      color: var(--bc-text-dim);
      padding: 3px 9px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .bc-mode-btn.active {
      background: var(--bc-primary);
      color: #fff;
    }

    .bc-quick-btn {
      border: 1px solid rgba(16, 185, 129, 0.4);
      background: rgba(16, 185, 129, 0.14);
      color: #10b981;
      border-radius: 7px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .bc-quick-btn:hover {
      background: rgba(16, 185, 129, 0.24);
    }

    /* 输入区 */
    .bc-input-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: var(--bc-text-dim);
      margin-bottom: 4px;
    }
    .bc-paste-btn {
      color: #3b82f6;
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      padding: 2px 4px;
      border-radius: 4px;
    }
    .bc-paste-btn:hover {
      text-decoration: underline;
    }
    .bc-large-badge {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      padding: 5px 9px;
      margin-bottom: 5px;
      border-radius: 6px;
      background: rgba(59, 130, 246, 0.14);
      border: 1px solid rgba(59, 130, 246, 0.3);
      color: #60a5fa;
    }
    :host([data-theme="light"]) .bc-large-badge {
      color: #1d4ed8;
    }
    .bc-textarea {
      width: 100%;
      height: 100px;
      background: var(--bc-input-bg);
      border: 1px solid var(--bc-border);
      border-radius: 8px;
      padding: 9px;
      color: var(--bc-text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      resize: vertical;
      outline: none;
      transition: border-color 0.18s;
      scrollbar-width: thin;
      scrollbar-color: var(--bc-scroll-thumb) transparent;
    }
    .bc-textarea:focus {
      border-color: var(--bc-primary);
    }

    /* 主按钮 */
    .bc-btn-primary {
      width: 100%;
      padding: 8px 14px;
      background: var(--bc-primary);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-weight: 600;
      font-size: 12.5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: background 0.15s, transform 0.1s;
    }
    .bc-btn-primary:hover:not(:disabled) {
      background: var(--bc-primary-hover);
    }
    .bc-btn-primary:active:not(:disabled) {
      transform: scale(0.99);
    }
    .bc-btn-primary:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }

    /* 警告条 */
    .bc-alert {
      display: none;
      padding: 7px 10px;
      border-radius: 8px;
      font-size: 11px;
      background: var(--bc-warn-bg);
      border: 1px solid var(--bc-warn-border);
      color: var(--bc-warn-text);
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .bc-alert-btn {
      border: 1px solid currentColor;
      background: transparent;
      color: inherit;
      font-size: 10.5px;
      padding: 2px 7px;
      border-radius: 5px;
      cursor: pointer;
      flex-shrink: 0;
    }

    /* 结果容器 */
    .bc-result-box {
      padding: 11px;
      background: var(--bc-surface);
      border: 1px solid var(--bc-border);
      border-radius: 10px;
      display: none;
      flex-direction: column;
      gap: 9px;
      animation: bcFadeIn 0.2s ease;
    }
    @keyframes bcFadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .bc-summary-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      font-weight: 600;
    }
    .bc-stat-badge {
      color: #10b981;
      background: rgba(16, 185, 129, 0.14);
      border: 1px solid rgba(16, 185, 129, 0.32);
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
    }

    /* 可拖拽卡片 */
    .bc-drag-card {
      padding: 11px 12px;
      border-radius: 8px;
      border: 1.5px dashed rgba(59, 130, 246, 0.55);
      background: rgba(59, 130, 246, 0.08);
      cursor: grab;
      display: flex;
      align-items: center;
      gap: 10px;
      transition: all 0.18s ease;
      user-select: none;
    }
    .bc-drag-card:hover {
      border-color: #60a5fa;
      background: rgba(59, 130, 246, 0.15);
    }
    .bc-drag-card:active {
      cursor: grabbing;
    }
    .bc-drag-icon {
      font-size: 24px;
      flex-shrink: 0;
    }
    .bc-drag-info {
      flex: 1;
      min-width: 0;
    }
    .bc-name-input {
      width: 100%;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--bc-text);
      font-size: 12.5px;
      font-weight: 600;
      padding: 1px 4px;
      margin-left: -4px;
      outline: none;
      text-overflow: ellipsis;
      user-select: text;
      cursor: text;
    }
    .bc-name-input:hover {
      border-color: var(--bc-border);
    }
    .bc-name-input:focus {
      background: var(--bc-input-bg);
      border-color: var(--bc-primary);
    }
    .bc-drag-desc {
      font-size: 11px;
      color: var(--bc-text-dim);
      margin-top: 2px;
    }

    /* 辅助按钮行 */
    .bc-button-group {
      display: flex;
      gap: 8px;
    }
    .bc-btn-sub {
      flex: 1;
      padding: 7px 10px;
      border-radius: 7px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      transition: all 0.15s;
      border: 1px solid var(--bc-border);
      background: rgba(128, 128, 128, 0.08);
      color: var(--bc-text);
    }
    .bc-btn-sub:hover:not(:disabled) {
      background: rgba(128, 128, 128, 0.16);
    }
    .bc-btn-sub:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .bc-btn-inject {
      background: rgba(16, 185, 129, 0.18);
      border-color: rgba(16, 185, 129, 0.42);
      color: #10b981;
      font-weight: 600;
    }
    .bc-btn-inject:hover:not(:disabled) {
      background: rgba(16, 185, 129, 0.28);
    }

    /* 文件树列表 */
    .bc-tree-toggle {
      font-size: 11px;
      color: var(--bc-text-dim);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 0;
      user-select: none;
    }
    .bc-tree-toggle:hover {
      color: var(--bc-text);
    }
    .bc-tree-list {
      max-height: 155px;
      overflow-y: auto;
      background: var(--bc-input-bg);
      border: 1px solid var(--bc-border);
      border-radius: 6px;
      padding: 5px 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      display: none;
      flex-direction: column;
      gap: 2px;
      scrollbar-width: thin;
      scrollbar-color: var(--bc-scroll-thumb) transparent;
    }
    .bc-tree-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 2px 4px;
      border-radius: 4px;
      color: var(--bc-text);
    }
    .bc-tree-item:hover {
      background: rgba(128, 128, 128, 0.1);
    }
    .bc-tree-item.dimmed {
      opacity: 0.52;
    }
    .bc-tree-left {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }
    .bc-tree-check {
      accent-color: var(--bc-primary);
      cursor: pointer;
      flex-shrink: 0;
    }
    .bc-tree-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bc-tree-dir {
      color: var(--bc-text-dim);
    }
    .bc-tree-badges {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
    }
    .bc-tree-badge {
      font-size: 10px;
      color: var(--bc-text-dim);
    }
    .bc-tree-warn {
      font-size: 9.5px;
      padding: 0 4px;
      border-radius: 3px;
      background: var(--bc-warn-bg);
      color: var(--bc-warn-text);
      border: 1px solid var(--bc-warn-border);
    }

    /* 设置抽屉 */
    .bc-settings {
      display: none;
      flex-direction: column;
      gap: 6px;
      padding: 9px 10px;
      background: var(--bc-surface);
      border: 1px solid var(--bc-border);
      border-radius: 8px;
      font-size: 11.5px;
    }
    .bc-settings.open {
      display: flex;
    }
    .bc-setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      color: var(--bc-text);
    }
    .bc-setting-row input {
      accent-color: var(--bc-primary);
      cursor: pointer;
    }
    .bc-footer-hint {
      font-size: 10.5px;
      color: var(--bc-text-dim);
      text-align: center;
      padding-top: 2px;
    }
  `

  /* ==========================================================================
     7. 主应用控制器
     ========================================================================== */

  function initApp() {
    if (document.getElementById(HOST_ID)) return

    const prefs = loadPrefs()

    const hostEl = document.createElement('div')
    hostEl.id = HOST_ID
    ;(document.body || document.documentElement).appendChild(hostEl)

    const shadow = hostEl.attachShadow({ mode: 'open' })

    // 优先 adoptedStyleSheets，不支持时降级为 textContent <style>（均 100% 合规 Trusted Types）
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

    // 主题自动适配（跟随页面背景色亮度与系统偏好，节流防抖避免频繁重排）
    let themeRafId = 0
    function syncTheme() {
      let nextTheme = 'dark'
      try {
        const bg = getComputedStyle(document.body).backgroundColor
        const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
        if (match) {
          const lum = 0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3])
          nextTheme = lum > 155 ? 'light' : 'dark'
        } else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
          nextTheme = 'light'
        }
      } catch {
        if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
          nextTheme = 'light'
        }
      }
      if (hostEl.getAttribute('data-theme') !== nextTheme) {
        hostEl.setAttribute('data-theme', nextTheme)
      }
    }
    function scheduleSyncTheme() {
      if (themeRafId) return
      themeRafId = requestAnimationFrame(() => {
        themeRafId = 0
        syncTheme()
      })
    }
    syncTheme()

    // SPA DOM 保活（防止 Angular 极端重渲染移除宿主容器，并限制属性监听范围减少无效触发）
    const keepAliveObserver = new MutationObserver(() => {
      if (!hostEl.isConnected) {
        ;(document.body || document.documentElement).appendChild(hostEl)
      }
      scheduleSyncTheme()
    })
    keepAliveObserver.observe(document.documentElement, {
      childList: true,
      subtree: false,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    })
    if (document.body) {
      keepAliveObserver.observe(document.body, {
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme']
      })
    }

    // 核心状态
    let isOpen = false
    let isDraggingCard = false
    let isTreeExpanded = false
    let rawTextMemory = null // 大文本内存直通区
    let parsedFiles = []
    let currentArtifact = null // { blob, file, name, mime, engine }
    let currentArtifactUrl = null
    let customFileName = ''
    let taskId = 0
    let toastTimer = null
    let repackTimer = null
    let pastePillTimer = null
    let pendingChatPasteText = ''
    let pendingChatPasteTarget = null

    function revokeCurrentUrl() {
      if (currentArtifactUrl) {
        URL.revokeObjectURL(currentArtifactUrl)
        currentArtifactUrl = null
      }
    }

    function resetArtifactState() {
      taskId++
      clearTimeout(repackTimer)
      revokeCurrentUrl()
      currentArtifact = null
      parsedFiles = []
      customFileName = ''
      resultContainer.style.display = 'none'
      sensitiveAlertEl.style.display = 'none'
      geminiLimitAlertEl.style.display = 'none'
    }

    function getActiveRawText() {
      return rawTextMemory !== null ? rawTextMemory : textareaEl.value
    }

    function setRawText(text) {
      if (text.length >= LARGE_TEXT_THRESHOLD) {
        rawTextMemory = text
        const byteSize = SHARED_ENCODER.encode(text).byteLength
        textareaEl.value = `${text.slice(0, PREVIEW_CHAR_LIMIT)}\n\n... [大文本内存直通预览，共 ${formatBytes(
          byteSize
        )}，已省略后续渲染以防卡顿] ...`
        largeTextLabel.textContent = `⚡ 已内存加载大文本 (${formatBytes(byteSize)})，60fps 零卡顿`
        largeBadgeEl.style.display = 'flex'
      } else {
        rawTextMemory = null
        textareaEl.value = text
        largeBadgeEl.style.display = 'none'
      }
    }

    // 尝试安全移除用户刚刚粘贴进聊天框的原始 BlockClip 文本（避免正文和附件重复）
    function tryRemovePastedTextFromTarget(target, pastedText) {
      if (!target || !target.isConnected || !pastedText) return
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
            target.value = val.slice(0, idx) + val.slice(idx + matchLen)
            const ev = createPageEvent('Event', 'input', { bubbles: true, composed: true }, NEEDS_XRAY_BRIDGE)
            dispatchCompatEvent(target, ev.event, ev.isPageSide)
          }
          return
        }

        const editable =
          target.closest?.('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]') ||
          (target.isContentEditable ? target : null)
        if (editable) {
          const curNorm = (editable.innerText || editable.textContent || '').replace(/\r\n?/g, '\n').trim()
          const pastedNorm = pastedText.replace(/\r\n?/g, '\n').trim()
          // Quill 等富文本编辑器常会增删空行段落，折叠空白做二次比对，同时杜绝误删用户已有提示词
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
              const ev = createPageEvent('Event', 'input', { bubbles: true, composed: true }, NEEDS_XRAY_BRIDGE)
              dispatchCompatEvent(editable, ev.event, ev.isPageSide)
            }
          }
        }
      } catch {
        // 忽略清理异常，不影响附件注入
      }
    }

    /* ------------------------- Toast & 非侵入胶囊 ------------------------- */

    const toastEl = safeEl('div', { className: 'bc-toast', role: 'status' })

    function showToast(msg, type = 'success', duration = 2600) {
      clearTimeout(toastTimer)
      toastEl.textContent = msg
      toastEl.style.background = type === 'error' ? '#ef4444' : type === 'warn' ? '#d97706' : '#10b981'
      toastEl.classList.add('show')
      toastTimer = setTimeout(() => {
        toastEl.classList.remove('show')
      }, duration)
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
                tryRemovePastedTextFromTarget(target, text)
              }
            }
          }
        },
        '⚡ 转为附件注入'
      ),
      safeEl(
        'button',
        {
          type: 'button',
          className: 'bc-pill-close',
          title: '忽略',
          onClick: hidePastePill
        },
        '✕'
      )
    )

    function showPastePill(fileCount, text, targetEl) {
      clearTimeout(pastePillTimer)
      pendingChatPasteText = text
      pendingChatPasteTarget = targetEl || null
      pillTextEl.textContent = `📦 检测到 BlockClip 代码 (${fileCount} 个文件)`
      pastePillEl.classList.add('show')
      pastePillTimer = setTimeout(hidePastePill, 7000)
    }

    function hidePastePill() {
      clearTimeout(pastePillTimer)
      pendingChatPasteText = ''
      pendingChatPasteTarget = null
      pastePillEl.classList.remove('show')
    }

    /* ------------------------- 悬浮球（可拖动 + 贴边 + 右键直通） ------------------------- */

    const floatBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-float-btn',
        title: IS_FIREFOX
          ? '左键：展开面板 | 右键 / Alt+Shift+Z：读取剪贴板并上传（需点确认） | 拖动：调整位置'
          : '左键：展开面板 | 右键 / Alt+Shift+Z：一键读取剪贴板并上传 | 拖动：调整位置',
        'aria-label': 'BlockClip to ZIP 助手'
      },
      '📦'
    )

    function applyFloatPosition() {
      const vh = window.innerHeight || 800
      const clampedBottom = Math.max(16, Math.min(vh - 64, Number(prefs.floatBottom) || 88))
      prefs.floatBottom = clampedBottom
      floatBtn.style.bottom = `${clampedBottom}px`
      if (prefs.floatSide === 'left') {
        floatBtn.style.left = '16px'
        floatBtn.style.right = 'auto'
      } else {
        floatBtn.style.right = '16px'
        floatBtn.style.left = 'auto'
      }
      if (isOpen) positionPanelSmart()
    }

    function positionPanelSmart() {
      const vw = window.innerWidth || 1280
      const vh = window.innerHeight || 800
      const rect = floatBtn.getBoundingClientRect()
      const isRight = rect.left + rect.width / 2 > vw / 2
      const openUpward = rect.top + rect.height / 2 > vh * 0.45

      if (isRight) {
        panelEl.style.right = '16px'
        panelEl.style.left = 'auto'
      } else {
        panelEl.style.left = '16px'
        panelEl.style.right = 'auto'
      }

      if (openUpward) {
        const bottomGap = Math.max(16, vh - rect.top + 10)
        panelEl.style.bottom = `${bottomGap}px`
        panelEl.style.top = 'auto'
        panelEl.style.maxHeight = `${Math.max(260, rect.top - 26)}px`
        panelEl.style.transformOrigin = isRight ? 'bottom right' : 'bottom left'
      } else {
        const topGap = Math.max(16, rect.bottom + 10)
        panelEl.style.top = `${topGap}px`
        panelEl.style.bottom = 'auto'
        panelEl.style.maxHeight = `${Math.max(260, vh - rect.bottom - 26)}px`
        panelEl.style.transformOrigin = isRight ? 'top right' : 'top left'
      }
    }

    // 悬浮球指针拖拽与点击区分（8px 位移防抖，适配高 DPI 触控板）
    let dragStartX = 0
    let dragStartY = 0
    let btnStartLeft = 0
    let btnStartBottom = 0
    let pointerMoved = false
    let isPointerDown = false

    floatBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return // 仅左键拖动/点击，放行右键直通
      isPointerDown = true
      pointerMoved = false
      dragStartX = e.clientX
      dragStartY = e.clientY
      const rect = floatBtn.getBoundingClientRect()
      btnStartLeft = rect.left
      btnStartBottom = window.innerHeight - rect.bottom
      try {
        floatBtn.setPointerCapture(e.pointerId)
      } catch {
        // 忽略不支持捕获的设备
      }
    })

    floatBtn.addEventListener('pointermove', (e) => {
      if (!isPointerDown) return
      const dx = e.clientX - dragStartX
      const dy = e.clientY - dragStartY
      if (!pointerMoved && Math.hypot(dx, dy) > 8) {
        pointerMoved = true
        floatBtn.classList.add('dragging')
      }
      if (!pointerMoved) return

      const vw = window.innerWidth
      const vh = window.innerHeight
      const nextLeft = Math.max(8, Math.min(vw - 54, btnStartLeft + dx))
      const nextBottom = Math.max(16, Math.min(vh - 64, btnStartBottom - dy))
      floatBtn.style.left = `${nextLeft}px`
      floatBtn.style.right = 'auto'
      floatBtn.style.bottom = `${nextBottom}px`
    })

    function finishFloatDrag(e) {
      if (!isPointerDown) return
      isPointerDown = false
      floatBtn.classList.remove('dragging')
      try {
        floatBtn.releasePointerCapture(e.pointerId)
      } catch {
        // 忽略
      }

      if (!pointerMoved) {
        togglePanel()
        return
      }

      const rect = floatBtn.getBoundingClientRect()
      prefs.floatSide = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right'
      prefs.floatBottom = Math.round(Math.max(16, Math.min(window.innerHeight - 64, window.innerHeight - rect.bottom)))
      savePrefs(prefs)
      applyFloatPosition()
    }

    floatBtn.addEventListener('pointerup', finishFloatDrag)
    floatBtn.addEventListener('pointercancel', finishFloatDrag)

    // 右键悬浮球：1 步直通（读剪贴板 -> 打包 -> 注入附件）
    floatBtn.addEventListener('contextmenu', async (e) => {
      e.preventDefault()
      await runInstantFromClipboard()
    })

    /* ------------------------- 面板内部组件构建 ------------------------- */

    const modeZipBtn = safeEl('button', { type: 'button', className: 'bc-mode-btn' }, '📦 ZIP 包')
    const modeMdBtn = safeEl('button', { type: 'button', className: 'bc-mode-btn' }, '📄 单文件 .md')

    function syncModeButtons() {
      modeZipBtn.className = `bc-mode-btn${prefs.exportMode === 'zip' ? ' active' : ''}`
      modeMdBtn.className = `bc-mode-btn${prefs.exportMode === 'single_md' ? ' active' : ''}`
      processBtn.textContent = prefs.exportMode === 'zip' ? '⚡ 还原层级并打包 ZIP' : '⚡ 合并并生成 .md 附件'
      downloadBtn.textContent = prefs.exportMode === 'zip' ? '💾 下载 ZIP' : '💾 下载 .md'
    }

    modeZipBtn.addEventListener('click', () => {
      if (prefs.exportMode === 'zip') return
      prefs.exportMode = 'zip'
      savePrefs(prefs)
      syncModeButtons()
      if (parsedFiles.length > 0) rebuildCurrentSelection(false)
    })

    modeMdBtn.addEventListener('click', () => {
      if (prefs.exportMode === 'single_md') return
      prefs.exportMode = 'single_md'
      savePrefs(prefs)
      syncModeButtons()
      if (parsedFiles.length > 0) rebuildCurrentSelection(false)
    })

    const instantClipboardBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-quick-btn',
        title: IS_FIREFOX
          ? '读取剪贴板 -> 自动打包 -> 注入附件（Firefox 需点击弹出的原生「粘贴」按钮）'
          : '读取剪贴板 -> 自动打包 -> 直接注入当前页面附件（快捷键 Alt+Shift+Z）',
        onClick: runInstantFromClipboard
      },
      '🚀 剪贴板一键上传'
    )

    // 设置抽屉
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
      makeSettingToggle('粘贴后自动解析并打包', 'autoPackOnPaste'),
      makeSettingToggle('默认跳过二进制占位文件', 'skipBinaryPlaceholders', (checked) => {
        if (parsedFiles.length > 0) {
          for (const f of parsedFiles) {
            if (f.isBinary) f.selected = !checked
          }
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
        onClick: () => settingsEl.classList.toggle('open')
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
          rawTextMemory = null
          textareaEl.value = ''
          largeBadgeEl.style.display = 'none'
          resetArtifactState()
          showToast('已清空')
        }
      },
      '🗑️'
    )

    const closeBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-icon-btn',
        title: '收起面板 (Esc)',
        onClick: () => setPanelOpen(false)
      },
      '✕'
    )

    // 大文本状态提示条
    const largeTextLabel = safeEl('span', {})
    const largeBadgeEl = safeEl(
      'div',
      { className: 'bc-large-badge' },
      largeTextLabel,
      safeEl(
        'button',
        {
          type: 'button',
          className: 'bc-alert-btn',
          onClick: () => {
            rawTextMemory = null
            textareaEl.value = ''
            largeBadgeEl.style.display = 'none'
            resetArtifactState()
          }
        },
        '清除'
      )
    )

    // 文本输入框（拦截超大粘贴防卡顿 + 粘贴自动打包）
    const textareaEl = safeEl('textarea', {
      className: 'bc-textarea',
      placeholder:
        '在此 Ctrl+V 粘贴 BlockClip 导出的文本（粘贴即自动打包）...\n例如：\nFile: src/index.ts\n```typescript\n// ...\n```'
    })

    textareaEl.addEventListener('paste', (e) => {
      const pasted = e.clipboardData ? e.clipboardData.getData('text/plain') : ''
      if (!pasted) return
      if (pasted.length >= LARGE_TEXT_THRESHOLD) {
        e.preventDefault()
        setRawText(pasted)
        if (prefs.autoPackOnPaste) {
          processRawText(pasted)
        }
        return
      }
      rawTextMemory = null
      largeBadgeEl.style.display = 'none'
      if (prefs.autoPackOnPaste) {
        setTimeout(() => {
          const val = textareaEl.value
          if (val && /^File:\s*.+/im.test(val)) {
            processRawText(val)
          }
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
          try {
            const clipText = await navigator.clipboard.readText()
            if (!clipText || !clipText.trim()) {
              showToast('剪贴板为空', 'warn')
              return
            }
            setRawText(clipText)
            if (prefs.autoPackOnPaste) {
              await processRawText(clipText)
            } else {
              showToast('已从剪贴板粘贴')
            }
          } catch {
            showToast(
              IS_FIREFOX
                ? 'Firefox 需点击原生「粘贴」确认，或直接在下方按 Ctrl+V'
                : '无法自动读取剪贴板，请直接 Ctrl+V 粘贴',
              'error',
              3400
            )
            textareaEl.focus()
          }
        }
      },
      '📋 读取剪贴板'
    )

    // 警告横幅（敏感文件 & Gemini 10 文件提醒）
    const sensitiveAlertText = safeEl('span', {})
    const sensitiveAlertEl = safeEl(
      'div',
      { className: 'bc-alert' },
      sensitiveAlertText,
      safeEl(
        'button',
        {
          type: 'button',
          className: 'bc-alert-btn',
          onClick: () => {
            for (const f of parsedFiles) {
              if (f.isSensitive) f.selected = false
            }
            renderFileTree()
            scheduleRepack(0)
            showToast('已取消勾选敏感文件并重新打包')
          }
        },
        '一键排除'
      )
    )

    const geminiLimitText = safeEl('span', {})
    const geminiLimitAlertEl = safeEl(
      'div',
      { className: 'bc-alert' },
      geminiLimitText,
      safeEl(
        'button',
        {
          type: 'button',
          className: 'bc-alert-btn',
          onClick: () => {
            prefs.exportMode = 'single_md'
            savePrefs(prefs)
            syncModeButtons()
            rebuildCurrentSelection(false)
          }
        },
        '切为单文件 .md'
      )
    )

    // 结果区
    const resultContainer = safeEl('div', { className: 'bc-result-box' })
    const summaryTextEl = safeEl('span', { textContent: '解析完成' })
    const statBadgeEl = safeEl('span', { className: 'bc-stat-badge', textContent: '0 B' })

    const nameInputEl = safeEl('input', {
      type: 'text',
      className: 'bc-name-input',
      value: 'blockclip_files.zip',
      title: '点击可自定义附件文件名'
    })

    // 轻量重命名：复用已生成的 Blob 直接重建 File，避免触发耗时的二次压缩
    function renameCurrentArtifact(rawName) {
      if (!currentArtifact) return
      const cleaned = rawName.trim().replace(/[\\/:*?"<>|]/g, '_')
      if (!cleaned) {
        nameInputEl.value = currentArtifact.name
        return
      }
      const ext = prefs.exportMode === 'single_md' ? 'md' : 'zip'
      const base = cleaned.replace(/\.(zip|md|txt)$/i, '')
      const nextName = base ? `${base}.${ext}` : currentArtifact.name
      customFileName = nextName
      if (nextName === currentArtifact.name) {
        nameInputEl.value = nextName
        return
      }
      const nextFile = new File([currentArtifact.blob], nextName, { type: currentArtifact.mime })
      currentArtifact = { ...currentArtifact, name: nextName, file: nextFile }
      nameInputEl.value = nextName
      showToast(`已重命名为 ${nextName}`)
    }

    // 防止在改名输入框里拖动或框选文字时与父级 draggable="true" 冲突（重点修复 Firefox）
    nameInputEl.addEventListener('mousedown', (e) => e.stopPropagation())
    nameInputEl.addEventListener('dragstart', (e) => e.preventDefault())
    nameInputEl.addEventListener('mouseenter', () => {
      dragCard.draggable = false
    })
    nameInputEl.addEventListener('mouseleave', () => {
      if (shadow.activeElement !== nameInputEl) {
        dragCard.draggable = true
      }
    })
    nameInputEl.addEventListener('focus', () => {
      dragCard.draggable = false
    })
    nameInputEl.addEventListener('blur', () => {
      dragCard.draggable = true
    })
    nameInputEl.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return
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
    nameInputEl.addEventListener('change', () => {
      renameCurrentArtifact(nameInputEl.value)
    })

    const dragCardDesc = safeEl('div', {
      className: 'bc-drag-desc',
      textContent: IS_FIREFOX
        ? '🖱️ 拖入对话区自动上传（保存到本地请点下方下载）'
        : '🖱️ 拖入对话区自动上传，或拖到桌面直接保存'
    })
    const dragCardIcon = safeEl('div', { className: 'bc-drag-icon' }, '📦')

    const dragCard = safeEl(
      'div',
      {
        className: 'bc-drag-card',
        draggable: true,
        title: IS_FIREFOX
          ? '按住拖到页面聊天框作为附件上传'
          : '按住拖到页面聊天框作为附件上传，或拖到浏览器外保存到桌面'
      },
      dragCardIcon,
      safeEl('div', { className: 'bc-drag-info' }, nameInputEl, dragCardDesc)
    )

    /* ------------------------- 页内拖拽桥接（核心稳定性修复） ------------------------- */

    function onWindowDragOver(e) {
      if (!isDraggingCard) return
      if (hostEl.contains(e.target)) return
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy'
      }
    }

    async function onWindowDrop(e) {
      if (!isDraggingCard) return
      if (hostEl.contains(e.target)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const dropTarget = e.target
      cleanupDragBridge()
      if (currentArtifact) {
        await performInject(currentArtifact.file, dropTarget)
      }
    }

    function cleanupDragBridge() {
      if (!isDraggingCard) return
      isDraggingCard = false
      panelEl.classList.remove('dragging-ghost')
      window.removeEventListener('dragover', onWindowDragOver, true)
      window.removeEventListener('drop', onWindowDrop, true)
    }

    dragCard.addEventListener('dragstart', (e) => {
      if (!currentArtifact) {
        e.preventDefault()
        return
      }
      isDraggingCard = true

      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'copy'
        e.dataTransfer.clearData()
        // 不设置 text/plain，彻底杜绝拖进输入框变成粘贴文件名文本的 Bug；同时满足 Firefox 启动拖拽要求
        e.dataTransfer.setData('application/x-blockclip-artifact', currentArtifact.name)
        // DownloadURL 为 Chromium 专属，仅在非 Firefox 环境写入
        if (!IS_FIREFOX && currentArtifactUrl) {
          e.dataTransfer.setData('DownloadURL', `${currentArtifact.mime}:${currentArtifact.name}:${currentArtifactUrl}`)
        }
      }

      window.addEventListener('dragover', onWindowDragOver, true)
      window.addEventListener('drop', onWindowDrop, true)

      // 下一帧半透明穿透面板，既保留清晰的拖拽残影，又避免面板遮挡底部输入框
      requestAnimationFrame(() => {
        if (isDraggingCard) panelEl.classList.add('dragging-ghost')
      })
    })

    dragCard.addEventListener('dragend', cleanupDragBridge)

    /* ------------------------- 注入 & 下载操作按钮 ------------------------- */

    async function performInject(file, customDropTarget = null) {
      injectBtn.disabled = true
      const prevText = injectBtn.textContent
      injectBtn.textContent = '⏳ 正在注入...'

      try {
        const res = await injectAttachmentToPage(file, customDropTarget)
        if (res.ok) {
          const channelTip = res.verified ? '' : '（已派发，请确认附件区）'
          showToast(`已注入 ${file.name}${channelTip}`, 'success')
          if (prefs.autoCloseAfterInject && isOpen) {
            setTimeout(() => {
              setPanelOpen(false)
              const editor = findEditorElement()
              if (editor) {
                try {
                  editor.focus({ preventScroll: true })
                } catch {
                  // 忽略
                }
              }
            }, 320)
          }
          return true
        }
        showToast('未能自动匹配上传框，请直接拖拽卡片或下载后上传', 'warn', 3500)
        return false
      } finally {
        injectBtn.disabled = false
        injectBtn.textContent = prevText
      }
    }

    const injectBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-btn-sub bc-btn-inject',
        title: '通过多通道引擎将附件直接注入当前对话框',
        onClick: async () => {
          if (!currentArtifact) return
          await performInject(currentArtifact.file)
        }
      },
      '📎 一键添加到附件'
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
          showToast(`开始下载 ${currentArtifact.name}`)
        }
      },
      '💾 下载 ZIP'
    )

    /* ------------------------- 可勾选文件树 ------------------------- */

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
        }
      },
      treeToggleTitle,
      treeToggleArrow
    )

    function scheduleRepack(delay = 280) {
      clearTimeout(repackTimer)
      repackTimer = setTimeout(() => {
        rebuildCurrentSelection(false)
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

      while (treeListEl.firstChild) {
        treeListEl.removeChild(treeListEl.firstChild)
      }
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

      if (sensitiveCount > 0) {
        sensitiveAlertText.textContent = `⚠️ 检测到 ${sensitiveCount} 个疑似敏感文件（如 .env / 密钥）`
        sensitiveAlertEl.style.display = 'flex'
      } else {
        sensitiveAlertEl.style.display = 'none'
      }

      if (IS_GEMINI && prefs.exportMode === 'zip' && selectedCount > 10) {
        geminiLimitText.textContent = `💡 当前含 ${selectedCount} 个文件，若 Gemini 拒收过多文件 ZIP 可切换为单文件`
        geminiLimitAlertEl.style.display = 'flex'
      } else {
        geminiLimitAlertEl.style.display = 'none'
      }
    }

    resultContainer.appendChild(safeEl('div', { className: 'bc-summary-row' }, summaryTextEl, statBadgeEl))
    resultContainer.appendChild(sensitiveAlertEl)
    resultContainer.appendChild(geminiLimitAlertEl)
    resultContainer.appendChild(dragCard)
    resultContainer.appendChild(safeEl('div', { className: 'bc-button-group' }, injectBtn, downloadBtn))
    resultContainer.appendChild(treeToggleEl)
    resultContainer.appendChild(treeListEl)

    /* ------------------------- 解析与打包核心调度 ------------------------- */

    async function rebuildCurrentSelection(showSuccessToast = true) {
      const selectedItems = parsedFiles.filter((f) => f.selected)
      if (selectedItems.length === 0) {
        revokeCurrentUrl()
        currentArtifact = null
        summaryTextEl.textContent = '未勾选任何文件'
        statBadgeEl.textContent = '0 B'
        injectBtn.disabled = true
        downloadBtn.disabled = true
        return null
      }

      const myTaskId = ++taskId
      processBtn.disabled = true
      injectBtn.disabled = true
      downloadBtn.disabled = true

      try {
        const artifact = await buildArtifact(selectedItems, prefs.exportMode, customFileName, (pct) => {
          if (myTaskId === taskId) {
            processBtn.textContent = `⏳ 正在压缩打包 ${pct}%...`
          }
        })

        // 防止异步竞态（打包期间被清空或触发了新任务）
        if (myTaskId !== taskId) return null

        revokeCurrentUrl()
        currentArtifact = artifact
        currentArtifactUrl = URL.createObjectURL(artifact.blob)

        const isZip = prefs.exportMode === 'zip'
        const fallbackSuffix = artifact.engine === 'Built-in STORE' ? ' · 内置无压缩' : ''
        summaryTextEl.textContent = `${isZip ? '还原成功' : '合并完成'} (${selectedItems.length} 个文件${fallbackSuffix})`
        statBadgeEl.textContent = formatBytes(artifact.blob.size)
        nameInputEl.value = artifact.name
        dragCardIcon.textContent = isZip ? '📦' : '📄'
        resultContainer.style.display = 'flex'
        injectBtn.disabled = false
        downloadBtn.disabled = false
        updateAlerts()

        if (showSuccessToast) {
          showToast(`已生成 ${artifact.name} (${formatBytes(artifact.blob.size)})`)
        }
        return artifact
      } catch (err) {
        if (myTaskId === taskId) {
          console.error('[BlockClip] 打包出错:', err)
          showToast(`生成失败: ${err?.message || String(err)}`, 'error')
        }
        return null
      } finally {
        if (myTaskId === taskId) {
          processBtn.disabled = false
          syncModeButtons()
        }
      }
    }

    async function processRawText(rawText, showSuccessToast = true) {
      if (!rawText || !rawText.trim()) {
        showToast('请先粘贴 BlockClip 导出的文本', 'warn')
        return null
      }

      const parsed = parseBlockClipText(rawText)
      if (parsed.length === 0) {
        showToast('未匹配到 BlockClip 格式（需包含 "File: ..." 与代码块）', 'error')
        return null
      }

      const merged = mergeParsedFiles(parsed)
      for (const item of merged) {
        if (item.isBinary && prefs.skipBinaryPlaceholders) {
          item.selected = false
        }
      }

      parsedFiles = merged
      customFileName = ''
      renderFileTree()
      return rebuildCurrentSelection(showSuccessToast)
    }

    async function runInstantPackAndInject(rawText) {
      setRawText(rawText)
      const artifact = await processRawText(rawText, false)
      if (!artifact) return false
      return performInject(artifact.file)
    }

    async function runInstantFromClipboard() {
      try {
        const clipText = await navigator.clipboard.readText()
        if (!clipText || !clipText.trim()) {
          showToast('剪贴板为空', 'warn')
          return
        }
        await runInstantPackAndInject(clipText)
      } catch {
        showToast(
          IS_FIREFOX
            ? 'Firefox 禁止静默读剪贴板：请在面板按 Ctrl+V，或开启“聊天框粘贴自动转附件”'
            : '无法读取剪贴板，请展开面板后按 Ctrl+V',
          'error',
          3800
        )
        setPanelOpen(true)
      }
    }

    const processBtn = safeEl(
      'button',
      {
        type: 'button',
        className: 'bc-btn-primary',
        onClick: async () => {
          await processRawText(getActiveRawText(), true)
        }
      },
      '⚡ 还原层级并打包 ZIP'
    )

    /* ------------------------- 面板组装与事件防穿透 ------------------------- */

    const panelEl = safeEl(
      'div',
      { className: 'bc-panel hidden' },
      safeEl(
        'div',
        { className: 'bc-header' },
        safeEl(
          'div',
          { className: 'bc-title-wrap' },
          safeEl('span', { className: 'bc-title' }, '📦 BlockClip to ZIP'),
          safeEl('span', { className: 'bc-tag' }, IS_AISTUDIO ? 'AI Studio' : 'Gemini')
        ),
        safeEl('div', { className: 'bc-actions' }, settingsBtn, clearBtn, closeBtn)
      ),
      safeEl(
        'div',
        { className: 'bc-body' },
        settingsEl,
        safeEl(
          'div',
          { className: 'bc-toolbar' },
          safeEl('div', { className: 'bc-mode-switch' }, modeZipBtn, modeMdBtn),
          instantClipboardBtn
        ),
        safeEl(
          'div',
          {},
          safeEl('div', { className: 'bc-input-header' }, safeEl('span', {}, 'BlockClip Markdown 内容:'), pasteBtn),
          largeBadgeEl,
          textareaEl
        ),
        processBtn,
        resultContainer,
        safeEl(
          'div',
          { className: 'bc-footer-hint' },
          IS_FIREFOX
            ? '提示：Firefox 建议开启设置中的“聊天框粘贴自动转附件”，直接 Ctrl+V 免弹窗上传'
            : '提示：右键悬浮球或按 Alt+Shift+Z 可不弹窗一键打包并上传'
        )
      )
    )

    // 阻止面板内按键冒泡到 Gemini / AI Studio 宿主快捷键系统
    for (const evType of ['keydown', 'keyup', 'keypress']) {
      panelEl.addEventListener(evType, (e) => {
        if (evType === 'keydown' && e.key === 'Escape') {
          e.stopPropagation()
          if (e.isComposing || e.keyCode === 229) return
          cleanupDragBridge()
          setPanelOpen(false)
          return
        }
        e.stopPropagation()
      })
    }

    function setPanelOpen(nextOpen) {
      isOpen = Boolean(nextOpen)
      if (isOpen) {
        syncTheme()
        positionPanelSmart()
        panelEl.classList.remove('hidden')
        requestAnimationFrame(() => textareaEl.focus({ preventScroll: true }))
      } else {
        panelEl.classList.add('hidden')
      }
    }

    function togglePanel() {
      setPanelOpen(!isOpen)
    }

    /* ------------------------- 全局快捷键 & 聊天框智能粘贴感知 ------------------------- */

    window.addEventListener(
      'keydown',
      (e) => {
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyZ' || e.key.toLowerCase() === 'z')) {
          e.preventDefault()
          runInstantFromClipboard()
        } else if (e.key === 'Escape') {
          if (e.isComposing || e.keyCode === 229) return
          cleanupDragBridge()
          if (shadow.activeElement === nameInputEl) return
          if (isOpen) {
            e.stopPropagation()
            setPanelOpen(false)
          }
        }
      },
      true
    )

    // 防止拖拽中途切窗导致面板停留在透明穿透状态
    window.addEventListener('blur', cleanupDragBridge)

    // 监听用户在 Gemini / AI Studio 聊天框直接粘贴 BlockClip 多文件文本
    document.addEventListener(
      'paste',
      (e) => {
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target]
        if (path.includes(hostEl)) return
        // 仅当粘贴内容不含文件且属于多文件 BlockClip 文本时介入
        const cd = e.clipboardData
        if (!cd || (cd.files && cd.files.length > 0)) return
        const text = cd.getData('text/plain')
        if (!looksLikeMultiFileBlockClip(text)) return

        const parsed = parseBlockClipText(text)
        if (parsed.length < 2) return

        if (prefs.autoInterceptChatPaste) {
          e.preventDefault()
          e.stopImmediatePropagation()
          runInstantPackAndInject(text)
        } else {
          // 在粘贴当下解析稳定的编辑器根节点，避免 Quill 重建内部 <p> 节点导致 target.isConnected 失效
          const rawEl = (path[0] && path[0].nodeType === 1 ? path[0] : e.target?.parentElement) || e.target
          const stableTarget =
            rawEl?.closest?.(
              'textarea, input, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
            ) || rawEl
          showPastePill(parsed.length, text, stableTarget)
        }
      },
      true
    )

    window.addEventListener('resize', () => {
      applyFloatPosition()
    })

    window.addEventListener('beforeunload', () => {
      cleanupDragBridge()
      window.removeEventListener('blur', cleanupDragBridge)
      revokeCurrentUrl()
      keepAliveObserver.disconnect()
    })

    // 挂载并初始化位置与状态
    shadow.appendChild(toastEl)
    shadow.appendChild(pastePillEl)
    shadow.appendChild(panelEl)
    shadow.appendChild(floatBtn)

    syncModeButtons()
    applyFloatPosition()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp, { once: true })
  } else {
    initApp()
  }
})()
