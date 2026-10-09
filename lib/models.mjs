// The five OpenMOSS files this demo uses, where the QVAC SDK keeps them, and how they get there.
//
// All five come from the QVAC Registry. SDK 0.21 ships constants for the MOSS-TTS backbone and the
// two codec halves; MOSS-TTSD and MOSS-SoundEffect were added to the registry after it, so they
// are fetched by registry path. The SDK names every cached file `<sha256(path)[:16]>_<file>`.
//
// Presence is checked here, by name and exact size, and `downloadAsset` only runs for a file that
// is missing: on 0.21, asking the SDK for a registry path that is not in its catalog downloads it
// again even when the complete file is already cached.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The SDK's model cache (its default location).
export const CACHE = path.join(os.homedir(), '.qvac', 'models')
const REG = 'qvac_models_compiled/ggml/openmoss'

export const MODELS = {
  tts: { label: 'MOSS-TTS v1.5', constant: 'TTS_DELAY_LLM_MOSS_TTS_F16', path: `${REG}/2026-09-25/moss-tts-delay-f16.gguf`, bytes: 16985643392 },
  decoder: { label: 'MOSS codec decoder', constant: 'TTS_CODEC_DECODER_MOSS_TTS_F16', path: `${REG}/2026-09-25/moss-codec-decoder-f16.gguf`, bytes: 1775741696 },
  encoder: { label: 'MOSS codec encoder', constant: 'TTS_CODEC_ENCODER_MOSS_TTS_F16', path: `${REG}/2026-09-25/moss-codec-encoder-f16.gguf`, bytes: 1776008736 },
  ttsd: { label: 'MOSS-TTSD', path: `${REG}/2026-10-01/moss-ttsd-f16.gguf`, bytes: 16716943744 },
  sfx: { label: 'MOSS-SoundEffect v2', path: `${REG}/2026-10-01/moss-sfx-v2-q8_0.gguf`, bytes: 3493811520 }
}

// The encoder is listed for voice and dialogue because cloning needs it; without it the model
// voices still work.
export const NEEDS = {
  voice: ['tts', 'decoder', 'encoder'],
  dialogue: ['ttsd', 'decoder', 'encoder'],
  sfx: ['sfx'],
  scene: ['ttsd', 'decoder', 'encoder', 'sfx']
}

export const srcOf = (key) => `registry://s3/${MODELS[key].path}`

export function fileOf (key) {
  const p = MODELS[key].path
  return path.join(CACHE, `${crypto.createHash('sha256').update(p).digest('hex').slice(0, 16)}_${path.basename(p)}`)
}

export function present (key) {
  try { return fs.statSync(fileOf(key)).size === MODELS[key].bytes } catch { return false }
}

export const missing = (feature) => NEEDS[feature].filter((k) => !present(k))
export const gb = (bytes) => Math.round(bytes / 1e8) / 10

/** Downloads, one file at a time, through the SDK. */
export function createDownloader (sdk) {
  const jobs = {}          // key -> { state, downloaded, total, error, requestId }
  const queue = []
  let running = false

  async function pump () {
    if (running) return
    running = true
    while (queue.length) {
      const key = queue.shift()
      const job = jobs[key]
      if (job.state !== 'queued') continue
      if (present(key)) { job.state = 'done'; continue }
      job.state = 'downloading'
      try {
        const op = sdk.downloadAsset({
          assetSrc: srcOf(key),
          onProgress: (p) => { job.downloaded = p.downloaded; job.total = p.total || MODELS[key].bytes }
        })
        job.requestId = op.requestId
        await op
        job.state = present(key) ? 'done' : 'error'
        if (job.state === 'error') job.error = 'The file did not arrive complete'
      } catch (e) {
        job.state = /cancel/i.test(String(e?.message)) ? 'cancelled' : 'error'
        job.error = job.state === 'error' ? String(e?.message || e).slice(0, 200) : null
      }
    }
    running = false
  }

  return {
    jobs,
    start (feature) {
      for (const key of NEEDS[feature]) {
        if (present(key)) continue
        const j = jobs[key]
        if (j && (j.state === 'queued' || j.state === 'downloading')) continue
        jobs[key] = { state: 'queued', downloaded: 0, total: MODELS[key].bytes, error: null }
        queue.push(key)
      }
      pump()
    },
    async cancel () {
      for (const j of Object.values(jobs)) if (j.state === 'queued') j.state = 'cancelled'
      const live = Object.values(jobs).find((j) => j.state === 'downloading')
      if (live?.requestId) await sdk.cancel({ requestId: live.requestId }).catch(() => {})
    },
    busy: () => Object.values(jobs).some((j) => j.state === 'queued' || j.state === 'downloading')
  }
}

/** Look up a package the way Node does, starting from each directory given. */
export function findPackage (name, ...from) {
  for (const start of from) {
    for (let d = start; ; d = path.dirname(d)) {
      const p = path.join(d, 'node_modules', name)
      if (fs.existsSync(path.join(p, 'package.json'))) return p
      if (path.dirname(d) === d) break
    }
  }
  return null
}

/**
 * The sound-effect engine lives in `@qvac/tts-ggml` from 0.11.0 on. The SDK 0.21 bundles 0.10, so
 * the demo uses the addon directly; `QVAC_TTS_GGML` can point at another build of it.
 */
export function soundEngine (dir) {
  const pkg = process.env.QVAC_TTS_GGML ? path.resolve(process.env.QVAC_TTS_GGML) : findPackage('@qvac/tts-ggml', dir)
  if (!pkg) return { ok: false, reason: '@qvac/tts-ggml is not installed' }
  let version = '?'
  try { version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version } catch {}
  let source = ''
  for (const f of ['index.js', 'tts.js']) { try { source += fs.readFileSync(path.join(pkg, f), 'utf8') } catch {} }
  if (!source.includes('moss-sfx')) return { ok: false, reason: `@qvac/tts-ggml ${version} has no sound-effect engine (0.11.0 or newer needed)`, version }
  return { ok: true, dir: pkg, version }
}
