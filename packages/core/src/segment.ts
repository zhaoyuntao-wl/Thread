// 中文分词封装（0-e 定案：jieba 预分词 shadow 列，@node-rs/jieba napi-rs 预编译）。
// 2.x API：Jieba.withDict(dict) 需显式加载词典（dict.txt 随包分发）；loadDict() 已弃用。
// 容错：jieba 加载失败（平台无预编译二进制等）→ 降级为单字空格（unicode61 可索引），
// 检索质量降级而非报错——符合"旁路可失败不阻塞主路径"约定（AGENTS.md 工作流约定 2/3）。
import { createRequire } from "node:module"

type JiebaInstance = { cut: (text: string, hmm?: boolean) => string[] }

let jieba: JiebaInstance | undefined
let loadTried = false

// ESM 无全局 require（type: module），用 createRequire 加载 CJS 原生包
const esmRequire = createRequire(import.meta.url)

function loadJieba(): JiebaInstance | undefined {
  if (loadTried) {
    return jieba
  }
  loadTried = true
  try {
    // 动态加载：顶层 import 失败会直接崩（原生模块缺平台二进制时），此处兜底
    const mod = esmRequire("@node-rs/jieba") as {
      Jieba: { withDict: (dict: unknown) => JiebaInstance }
    }
    const { dict } = esmRequire("@node-rs/jieba/dict") as { dict: unknown }
    jieba = mod.Jieba.withDict(dict)
  } catch {
    jieba = undefined
  }
  return jieba
}

// CJK 单字空格化（降级路径 + 保底）：每个中文字符两侧加空格，unicode61 按空格分词
export function cjkSpace(text: string): string {
  return text
    .replace(/([\u3400-\u9fff\uf900-\ufaff])/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim()
}

// 纯标点/符号 token 过滤（jieba 会把"、""，""："等切为独立 token，FTS 索引是噪声）
const PUNCT_RE = /^[\p{P}\p{S}\s]+$/u

// 查询侧停用词（高频虚词/泛化词）：全 OR 语义下这些词会把无关内容拉进候选集，
// 过滤后召回精度交给 BM25 排序。仅查询路径使用——索引保留全文（"决策"等词须能命中）。
const QUERY_STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "与", "及", "或", "把", "被", "就", "都", "而", "等",
  "之", "其", "这", "那", "也", "还", "于", "以", "为", "对", "从", "到", "吗", "呢",
  "吧", "啊", "哦", "嗯", "我", "你", "他", "她", "它", "我们", "你们", "他们", "咱们",
  "怎么", "什么", "如何", "为啥", "为什么", "一个", "这个", "那个", "一下", "一下下",
  "有", "没", "不", "没", "无", "请", "帮", "要", "想", "能", "会", "去", "来",
])

function cleanTokens(tokens: string[], { stopwords }: { stopwords?: boolean } = {}): string[] {
  return tokens.filter((t) => {
    if (t.trim().length === 0 || PUNCT_RE.test(t)) {
      return false
    }
    if (stopwords && QUERY_STOPWORDS.has(t)) {
      return false
    }
    return true
  })
}

// 预分词：jieba 词级分词 → 空格连接（供 FTS body_seg 列索引）；失败降级单字
export function segment(text: string): string {
  const j = loadJieba()
  if (j) {
    try {
      return cleanTokens(j.cut(text)).join(" ")
    } catch {
      // 分词异常降级单字
    }
  }
  return cjkSpace(text)
}

// 查询侧对称分词：返回 token 列表（jieba 词级 + 停用词过滤）；失败降级单字
export function segmentQuery(query: string): string[] {
  const j = loadJieba()
  if (j) {
    try {
      const tokens = cleanTokens(j.cut(query), { stopwords: true })
      if (tokens.length > 0) {
        return tokens
      }
    } catch {
      // 分词异常降级单字
    }
  }
  return cjkSpace(query).split(/\s+/).filter(Boolean)
}
