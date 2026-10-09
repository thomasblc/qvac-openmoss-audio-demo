// 16-bit PCM WAV in and out, and the mix of a dialogue over a generated ambience.
import fs from 'node:fs'

export function wavBytes (samples, rate) {
  const pcm = samples instanceof Int16Array ? samples : Int16Array.from(samples, (v) => Math.max(-32768, Math.min(32767, Math.round(v))))
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/** Parse a WAV header. Returns null when the bytes are not 16-bit PCM WAV. */
export function parseWav (b) {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null
  let o = 12; let fmt = null
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4); const size = b.readUInt32LE(o + 4)
    if (id === 'fmt ' && size >= 16) {
      fmt = { format: b.readUInt16LE(o + 8), channels: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) }
    }
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) return null
      const end = Math.min(b.length, o + 8 + size)
      const frames = Math.floor((end - o - 8) / 2 / fmt.channels)
      const samples = new Int16Array(frames)
      for (let i = 0; i < frames; i++) samples[i] = b.readInt16LE(o + 8 + i * 2 * fmt.channels)
      return { ...fmt, samples, seconds: frames / fmt.rate }
    }
    o += 8 + size + (size & 1)
  }
  return null
}

export const readWav = (file) => {
  const w = parseWav(fs.readFileSync(file))
  if (!w) throw new Error('not a 16-bit PCM WAV')
  return w
}

const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)) }

/** A bed stretched to `total` samples: repeated with a 1 s crossfade at each seam. */
function loop (bed, total, rate) {
  const out = new Float32Array(total)
  if (!bed.length) return out
  const fade = Math.min(rate, Math.floor(bed.length / 2))
  let pos = 0
  while (pos < total) {
    for (let j = 0; j < bed.length && pos + j < total; j++) {
      const w = pos > 0 && j < fade ? j / fade : 1
      out[pos + j] = out[pos + j] * (1 - w) + bed[j] * w
    }
    pos += Math.max(1, bed.length - fade)
  }
  return out
}

/**
 * Voices over a bed: the dialogue resampled to the ambience's rate, the bed `bedDb` under the
 * voices by RMS, faded in and out, the whole mix peaking at -1 dBFS.
 */
export function mixScene (voice, bed, { leadS, tailS, bedDb }) {
  const rate = bed.rate
  const ratio = rate / voice.rate
  const lead = Math.round(leadS * rate)
  const vLen = Math.floor(voice.samples.length * ratio)
  const total = lead + vLen + Math.round(tailS * rate)
  const v = new Float32Array(total)
  for (let i = 0; i < vLen; i++) {
    const x = i / ratio; const a = Math.floor(x); const f = x - a
    v[lead + i] = voice.samples[a] * (1 - f) + (voice.samples[a + 1] ?? voice.samples[a]) * f
  }
  const bedLoop = loop(bed.samples, total, rate)
  const gain = (rms(voice.samples) * Math.pow(10, bedDb / 20)) / Math.max(1, rms(bed.samples))
  const fade = Math.round(0.8 * rate)
  const mixed = new Float32Array(total)
  let peak = 0
  for (let i = 0; i < total; i++) {
    const env = Math.max(0, Math.min(1, i / fade, (total - 1 - i) / fade))
    mixed[i] = v[i] + bedLoop[i] * gain * env
    peak = Math.max(peak, Math.abs(mixed[i]))
  }
  const norm = 29300 / Math.max(1, peak)
  const out = new Int16Array(total)
  for (let i = 0; i < total; i++) out[i] = Math.round(mixed[i] * norm)
  return { samples: out, rate }
}
