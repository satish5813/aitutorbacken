// Translate text into any language (free Google endpoint), with in-memory cache.
const cache = new Map() // key: `${lang}|${text}` -> translated

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'हिन्दी (Hindi)' },
  { code: 'te', name: 'తెలుగు (Telugu)' },
  { code: 'ta', name: 'தமிழ் (Tamil)' },
  { code: 'kn', name: 'ಕನ್ನಡ (Kannada)' },
  { code: 'ml', name: 'മലയാളം (Malayalam)' },
  { code: 'mr', name: 'मराठी (Marathi)' },
  { code: 'bn', name: 'বাংলা (Bengali)' },
  { code: 'gu', name: 'ગુજરાતી (Gujarati)' },
  { code: 'ur', name: 'اردو (Urdu)' },
  { code: 'ar', name: 'العربية (Arabic)' },
  { code: 'es', name: 'Español (Spanish)' },
  { code: 'fr', name: 'Français (French)' },
  { code: 'de', name: 'Deutsch (German)' },
  { code: 'zh-CN', name: '中文 (Chinese)' },
  { code: 'ja', name: '日本語 (Japanese)' },
  { code: 'ru', name: 'Русский (Russian)' },
  { code: 'pt', name: 'Português (Portuguese)' },
]

async function one(text, lang) {
  const key = `${lang}|${text}`
  if (cache.has(key)) return cache.get(key)
  try {
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='
      + encodeURIComponent(lang) + '&dt=t&q=' + encodeURIComponent(text)
    const r = await fetch(u)
    const j = await r.json()
    const out = j[0].map((s) => s[0]).join('')
    cache.set(key, out)
    return out
  } catch {
    return text // fall back to original on failure
  }
}

export async function translateTexts(texts, lang) {
  if (!lang || lang === 'en') return texts
  return Promise.all(texts.map((t) => one(String(t || ''), lang)))
}
