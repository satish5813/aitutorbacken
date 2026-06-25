// Auto-fetch a YouTube transcript — pure Node, no external tools.
import { YoutubeTranscript } from 'youtube-transcript'

// pull the 11-char video id from any YouTube URL form
export function extractVideoId(url) {
  if (!url) return null
  const m = String(url).match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/)
  return m ? m[1] : null
}

// returns an array of [seconds, text] chunks (~16s each), or null if unavailable
export async function fetchTranscript(videoId) {
  try {
    const segs = await YoutubeTranscript.fetchTranscript(videoId)
    if (!segs || !segs.length) return null

    const chunks = []
    let curT = null, buf = []
    for (const s of segs) {
      const t = Math.floor((s.offset ?? 0) / 1000)     // ms -> s
      const x = String(s.text || '').replace(/\s+/g, ' ').trim()
      if (curT === null) curT = t
      if (x) buf.push(x)
      if (t - curT >= 16) {
        if (buf.length) chunks.push([curT, buf.join(' ')])
        curT = null; buf = []
      }
    }
    if (buf.length) chunks.push([curT ?? 0, buf.join(' ')])

    // capitalise first letter of each chunk
    return chunks
      .filter(([, x]) => x)
      .map(([t, x]) => [t, x.charAt(0).toUpperCase() + x.slice(1)])
  } catch {
    return null
  }
}
