// QVAC OpenMOSS audio demo: expressive speech, multi-voice dialogue, sound effects and sound
// scenes from three OpenMOSS models, on one computer.
//
//   npm start   ->  http://localhost:3102
//
// Speech and dialogue run through the QVAC SDK (`textToSpeech`, `ttsEngine: 'moss'`). Sound effects
// run through `@qvac/tts-ggml`, the SDK's speech addon, in a short Bare process per clip, until the
// SDK exposes them itself. One model is held at a time: the two speech backbones are 17 GB each.
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as sdk from '@qvac/sdk'
import { PRESETS, LANGUAGES, READ_ALOUD } from './lib/presets.mjs'
import { MODELS, NEEDS, CACHE, fileOf, missing, gb, createDownloader, findPackage, soundEngine } from './lib/models.mjs'
import { wavBytes, parseWav, readWav, mixScene } from './lib/wav.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3102)
const HOST = process.env.HOST || '127.0.0.1'
const OUT = path.join(DIR, 'out')
const REFS = path.join(OUT, 'refs')
const TAKES = path.join(OUT, 'takes.json')
fs.mkdirSync(REFS, { recursive: true })
const log = fs.createWriteStream(path.join(OUT, 'engine.log'), { flags: 'a' })

// MOSS speaks at 24 kHz and counts length in codec frames, 12.5 per second.
const FRAMES_PER_S = 12.5
const SEEDS = { voice: 1234, dialogue: 2026, sfx: 7 }
// Measured on a 36 GB MacBook Pro (Metal): a sound effect costs the same at any length, because
// the model always denoises a 30 s latent and crops it.
const SFX_SECONDS = { 25: 24, 50: 50, 100: 100 }
const SCENE = { leadS: 1.0, tailS: 1.5, bedDb: -10 }
const MAX_REF_S = 60

// --------------------------------------------------------------------------------- takes
// On disk, not in memory: the audio survives a restart, so the list must too. A take that
// leaves the list takes its audio with it: Remove means the file is gone, not just hidden.
const MAX_TAKES = 200
const MAX_TEXT = 4000
let takes = []
try { takes = JSON.parse(fs.readFileSync(TAKES, 'utf8')) } catch (e) {
  // A damaged list is kept aside, not overwritten by the next take.
  if (e.code !== 'ENOENT') { try { fs.renameSync(TAKES, `${TAKES}.bad-${Date.now()}`) } catch {} }
}
const takeFiles = (t) => [t.file, t.voicesFile, t.bedFile].filter((f) => typeof f === 'string')
async function dropFiles (gone) {
  const kept = new Set(takes.flatMap(takeFiles))
  for (const t of gone) {
    for (const f of takeFiles(t)) if (!kept.has(f)) await fsp.unlink(path.join(OUT, path.basename(f))).catch(() => {})
  }
}
// Saves run one after the other: two at once would share the .tmp file.
let saving = Promise.resolve()
function saveTakes () {
  const run = saving.then(async () => {
    const gone = takes.slice(MAX_TAKES)
    takes = takes.slice(0, MAX_TAKES)
    await fsp.writeFile(TAKES + '.tmp', JSON.stringify(takes, null, 1))
    await fsp.rename(TAKES + '.tmp', TAKES)
    await dropFiles(gone)
  })
  saving = run.catch(() => {})
  return run
}
const clip = (v, n = MAX_TEXT) => String(v || '').trim().slice(0, n)
async function addTake (take) { takes.unshift(take); await saveTakes(); return take }

// ---------------------------------------------------------------------------------- models
const downloads = createDownloader(sdk)
let sound = soundEngine(DIR)
let current = null           // { key, kind, modelId }
let busy = null              // { feature, cancel, stop }
let sfxKill = null           // ends a running sound-effect process group

/** Stop pressed while a model was loading: end the job before the next step starts. */
function stopped () { if (busy?.stop) throw new Error('Stopped') }

async function unloadSpeech () {
  if (!current) return
  const c = current
  current = null
  // autoClose: false keeps the SDK worker up; unloading the last model would otherwise close it
  // and take a running download with it.
  await sdk.unloadModel({ modelId: c.modelId, clearStorage: false, autoClose: false })
    .catch((e) => log.write(`[${new Date().toISOString()}] unload failed: ${e?.message || e}\n`))
}

/** Load the speech backbone a job needs. Reference voices, length and seed are fixed per load. */
async function ensureSpeech (kind, opts, emit) {
  const key = JSON.stringify({ kind, ...opts })
  if (current && current.key === key) return current.modelId
  await unloadSpeech()
  stopped()
  emit({ t: 'loading', model: kind === 'voice' ? 'MOSS-TTS v1.5' : 'MOSS-TTSD' })
  const t0 = Date.now()
  const cloning = kind === 'voice' ? !!opts.ref : opts.refs.length > 0
  const op = sdk.loadModel({
    modelSrc: fileOf(kind === 'voice' ? 'tts' : 'ttsd'),
    modelType: 'tts-ggml',
    modelConfig: {
      ttsEngine: 'moss',
      language: opts.language,
      mossCodecDecoderModelSrc: fileOf('decoder'),
      ...(cloning ? { mossCodecEncoderModelSrc: fileOf('encoder') } : {}),
      ...(kind === 'voice' && opts.ref ? { referenceAudioSrc: opts.ref } : {}),
      ...(kind === 'dialogue' && opts.refs.length ? { dialogueReferenceSrcs: opts.refs } : {}),
      ...(opts.durationTokens ? { durationTokens: opts.durationTokens } : {}),
      // Audio arrives every 25 codec frames (2 s) while the rest is still being generated.
      streamChunkTokens: 25,
      useGPU: true,
      seed: opts.seed
    }
  })
  // Stop during a load cancels the load itself, not only what comes after it.
  if (busy) busy.cancel = () => sdk.cancel({ requestId: op.requestId }).catch(() => {})
  const modelId = await op
  current = { key, kind, modelId }
  emit({ t: 'loaded', ms: Date.now() - t0 })
  stopped()
  return modelId
}

// With the SDK 0.21 defaults, MOSS-TTSD sometimes never ends a dialogue: the lines come out in the
// first seconds, then silence runs to the 162.6 s generation budget (90 s of compute), and on
// some seeds the whole take is silent. So the stream is watched: a long silence after the last
// word ends the take there, and no word in the first 8 s gives up early. A 100 ms window is
// speech when it is above a floor and within 20 dB of the loudest window so far, so a quiet
// cloned voice still counts.
const RATE = 24000
const SPEECH_FLOOR = 150        // about -47 dBFS
const TRAIL_S = 5               // plus the longest [pause] in the text
const NOTHING_S = 8

/** Synthesize, streaming the audio to the page as it comes. Returns Int16 samples. */
async function speak (modelId, text, emit, live) {
  const t0 = Date.now()
  // Our own request id, so Stop can cancel this synthesis and nothing else.
  const requestId = crypto.randomUUID()
  const run = sdk.textToSpeech({ modelId, text, stream: true, requestId })
  let guard = null              // why the watch stopped the run, if it did
  const cancel = () => sdk.cancel({ requestId }).catch(() => {})
  if (busy) busy.cancel = cancel
  if (busy?.stop) cancel()
  const longestPause = Math.max(0, ...[...text.matchAll(/\[pause (\d{1,2}(?:\.\d)?)s\]/g)].map((m) => Number(m[1])))
  const trail = (TRAIL_S + longestPause) * RATE
  let loudest = 0
  const all = []
  let pending = []
  let firstMs = null
  let lastSpeech = -1           // sample index of the end of the last loud 100 ms window
  let win = 0; let winN = 0
  const flush = () => {
    if (!pending.length) return
    const pcm = Int16Array.from(pending)
    pending = []
    if (live) emit({ t: 'audio', rate: RATE, pcm: Buffer.from(pcm.buffer).toString('base64') })
  }
  const timer = setInterval(flush, 150)
  try {
    for await (const s of run.bufferStream) {
      if (firstMs === null) firstMs = Date.now() - t0
      all.push(s)
      pending.push(s)
      win += s * s
      if (++winN === RATE / 10) {
        const rms = Math.sqrt(win / winN)
        loudest = Math.max(loudest, rms)
        if (rms > SPEECH_FLOOR && rms > loudest * 0.1) lastSpeech = all.length
        win = 0; winN = 0
        if (!guard && lastSpeech < 0 && all.length >= NOTHING_S * RATE) { guard = 'silent'; cancel() }
        if (!guard && lastSpeech >= 0 && all.length - lastSpeech >= trail) { guard = 'ended'; cancel() }
      }
    }
  } finally {
    clearInterval(timer)
  }
  flush()
  const stop = await run.stopReason
  if (stop === 'cancelled' && !guard) throw new Error('Stopped')
  if (guard === 'silent' || lastSpeech < 0) throw new Error('The voices came back silent. Try Another take: it uses another seed.')
  const samples = Int16Array.from(all)
  if (guard !== 'ended') return { samples, rate: (await run.sampleRate) ?? RATE, firstMs, ms: Date.now() - t0, cut: false }
  // Cut the run-out silence: keep 0.4 s after the last word, faded over 30 ms.
  const end = Math.min(samples.length, lastSpeech + Math.round(0.4 * RATE))
  const fade = Math.round(0.03 * RATE)
  for (let i = 0; i < fade && end - 1 - i >= 0; i++) samples[end - 1 - i] = Math.round(samples[end - 1 - i] * (i / fade))
  return { samples: samples.slice(0, end), rate: (await run.sampleRate) ?? RATE, firstMs, ms: Date.now() - t0, cut: true }
}

/** Find the Bare runtime next to the SDK that installed it. */
function bareLauncher () {
  const sdkDir = findPackage('@qvac/sdk', DIR)
  const bare = findPackage('bare-runtime', DIR, sdkDir || DIR)
  return bare ? path.join(bare, 'bin', 'bare') : null
}

/** One sound effect in a short Bare process (see engine/sfx.cjs). */
async function soundEffect (job, emit) {
  sound = soundEngine(DIR)
  if (!sound.ok) throw new Error(sound.reason)
  const launcher = bareLauncher()
  if (!launcher) throw new Error('The Bare runtime is missing; reinstall the dependencies')
  // The sound model needs the memory the speech backbone holds.
  await unloadSpeech()
  stopped()
  emit({ t: 'loading', model: 'MOSS-SoundEffect v2' })
  const file = `${job.name}-${Date.now()}.wav`
  const child = spawn(process.execPath, [launcher, path.join(DIR, 'engine', 'sfx.cjs'),
    sound.dir, fileOf('sfx'), path.join(OUT, file), JSON.stringify(job)], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  // The launcher starts the native `bare` as its own child: kill the whole process group, or the
  // engine keeps generating, holding the pipe and the GPU, after Stop.
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
  sfxKill = kill
  if (busy) busy.cancel = kill
  child.stderr.pipe(log, { end: false })
  let spawnError = null
  child.on('error', (e) => { spawnError = e.message })
  let result = null
  let error = null
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      if (ev.t === 'loaded') emit({ t: 'loaded', ms: ev.ms })
      if (ev.t === 'done') result = ev
      if (ev.t === 'error') error = ev.message
    }
  })
  const code = await new Promise((resolve) => child.on('close', resolve))
  sfxKill = null
  if (busy?.stop) throw new Error('Stopped')
  if (result) return { file, seconds: result.seconds, ms: result.ms }
  throw new Error(error || spawnError || (code === null ? 'Stopped' : `The sound engine stopped (exit ${code}); see out/engine.log`))
}

// ------------------------------------------------------------------------------------ jobs
/** A problem with what the user asked for, found before any model work. */
class UserError extends Error {}
const presetOf = (feature, text) => PRESETS[feature].find((p) => p.text === text.trim())
const randomSeed = () => crypto.randomInt(1, 2 ** 31 - 1)
const langOf = (code) => (LANGUAGES.some(([c]) => c === code) ? code : 'en')

function refPath (id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return null
  const p = path.join(REFS, `${id}.wav`)
  return fs.existsSync(p) ? p : null
}

/** A dialogue script: one line per speaker turn, tagged [S1] to [S5], tags numbered from 1. */
function parseScript (text) {
  const script = clip(text).split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
  const tags = [...script.matchAll(/\[S(\d)\]/g)].map((m) => Number(m[1]))
  if (!tags.length || !script.startsWith('[S')) throw new UserError('Start each line with a speaker tag, [S1] or [S2]')
  const speakers = Math.max(...tags)
  if (speakers > 5) throw new UserError('MOSS-TTSD takes up to five speakers, [S1] to [S5]')
  for (let n = 1; n <= speakers; n++) if (!tags.includes(n)) throw new UserError(`[S${n}] never speaks: number the speakers from [S1]`)
  return { script, speakers }
}

/** The dialogue's text and reference recordings, with each recording's transcript first. */
function dialogueInput (body) {
  const { script, speakers } = parseScript(body.text)
  if (body.voices !== 'clone') return { text: script, refs: [], speakers }
  const given = Array.isArray(body.speakers) ? body.speakers : []
  const refs = []
  const lines = []
  let total = 0
  for (let n = 1; n <= speakers; n++) {
    const s = given[n - 1] || {}
    const p = refPath(s.refId)
    const said = clip(s.transcript, 600)
    if (!p || !said) throw new UserError(`Record or add a voice for [S${n}], with what it says`)
    total += readWav(p).seconds
    refs.push(p)
    lines.push(`[S${n}] ${said}`)
  }
  if (total > MAX_REF_S) throw new UserError(`The recorded voices add up to ${Math.round(total)} s; keep them under ${MAX_REF_S} s together`)
  return { text: `${lines.join(' ')} ${script}`, refs, speakers }
}

async function runVoice (body, emit) {
  const text = clip(body.text)
  if (!text) throw new UserError('Write something to say first')
  const preset = presetOf('voice', text)
  const seed = body.random ? randomSeed() : (preset?.seed ?? SEEDS.voice)
  const ref = body.voice === 'clone' ? refPath(body.refId) : null
  if (body.voice === 'clone' && !ref) throw new UserError('Record or add a voice to clone first')
  const length = [3, 5, 8, 12, 20].includes(Number(body.length)) ? Number(body.length) : 0
  const language = langOf(body.language)
  const modelId = await ensureSpeech('voice', { language, ref, durationTokens: Math.round(length * FRAMES_PER_S), seed }, emit)
  emit({ t: 'stage', label: 'Speaking' })
  const out = await speak(modelId, text, emit, true)
  const file = `voice-${Date.now()}.wav`
  await fsp.writeFile(path.join(OUT, file), wavBytes(out.samples, out.rate))
  return addTake({ id: file, feature: 'voice', file, text, language, voice: ref ? 'clone' : 'model', length, seed,
    seconds: out.samples.length / out.rate, ms: out.ms, firstMs: out.firstMs, at: Date.now() })
}

async function runDialogue (body, emit, { live = true, name = 'dialogue' } = {}) {
  const input = dialogueInput(body)
  const preset = presetOf('dialogue', String(body.text || '')) || presetOf('scene', String(body.text || ''))
  const seed = body.random ? randomSeed() : (preset?.seed ?? SEEDS.dialogue)
  const language = langOf(body.language)
  const modelId = await ensureSpeech('dialogue', { language, refs: input.refs, seed }, emit)
  emit({ t: 'stage', label: 'Voicing the dialogue' })
  const out = await speak(modelId, input.text, emit, live)
  const file = `${name}-${Date.now()}.wav`
  await fsp.writeFile(path.join(OUT, file), wavBytes(out.samples, out.rate))
  return { file, samples: out.samples, rate: out.rate, ms: out.ms, firstMs: out.firstMs, seed, language,
    speakers: input.speakers, voice: input.refs.length ? 'clone' : 'model' }
}

function sfxJob (body, name) {
  const text = clip(body.text, 1000)
  if (!text) throw new UserError('Describe a sound first')
  const steps = [25, 50, 100].includes(Number(body.steps)) ? Number(body.steps) : 50
  const seconds = [4, 8, 15, 30].includes(Number(body.seconds)) ? Number(body.seconds) : 8
  const avoid = clip(body.avoid, 300)
  return { prompt: text, seconds, steps, seed: body.random ? randomSeed() : SEEDS.sfx, name, ...(avoid ? { negativePrompt: avoid } : {}) }
}

async function runSfx (body, emit) {
  const job = sfxJob(body, 'sfx')
  emit({ t: 'stage', label: 'Generating the sound' })
  const r = await soundEffect(job, emit)
  return addTake({ id: r.file, feature: 'sfx', file: r.file, text: job.prompt, avoid: job.negativePrompt || '',
    steps: job.steps, seed: job.seed, seconds: r.seconds, ms: r.ms, at: Date.now() })
}

// A bed costs the same at any length (the model always makes 30 s and crops), so every bed is
// 30 s and is reused for any take with the same ambience and quality: a second take of a scene
// costs only the voices. The beds are files, so the cache is rebuilt from the takes.
const bedCache = new Map()
for (const t of takes) if (t.bedKey && t.bedFile) bedCache.set(t.bedKey, t.bedFile)

async function runScene (body, emit) {
  const ambience = clip(body.ambience, 1000)
  if (!ambience) throw new UserError('Describe the ambience first')
  const steps = [25, 50].includes(Number(body.steps)) ? Number(body.steps) : 25
  const d = await runDialogue(body, emit, { live: false, name: 'scene-voices' })
  try {
    return await sceneOver(d, body, ambience, steps, emit)
  } catch (e) {
    // No take will point at the voices of a scene that failed: do not leave them in out/.
    await fsp.unlink(path.join(OUT, d.file)).catch(() => {})
    throw e
  }
}

async function sceneOver (d, body, ambience, steps, emit) {
  const seconds = 30
  const key = `${ambience}|${steps}`
  let bedFile = bedCache.get(key)
  let bedMs = 0
  if (!bedFile || !fs.existsSync(path.join(OUT, bedFile))) {
    emit({ t: 'stage', label: 'Generating the ambience' })
    const b = await soundEffect({ prompt: ambience, seconds, steps, seed: SEEDS.sfx, name: 'scene-bed' }, emit)
    bedFile = b.file; bedMs = b.ms
    bedCache.set(key, bedFile)
  }
  let bed = null
  try { bed = readWav(path.join(OUT, bedFile)) } catch {}
  if (!bed || bed.samples.length < bed.rate) {
    bedCache.delete(key)
    throw new Error('The ambience came back empty. Try again.')
  }
  const mixed = mixScene({ samples: d.samples, rate: d.rate }, bed, SCENE)
  const file = `scene-${Date.now()}.wav`
  await fsp.writeFile(path.join(OUT, file), wavBytes(mixed.samples, mixed.rate))
  return addTake({ id: file, feature: 'scene', file, text: clip(body.text), ambience, steps,
    voice: d.voice, seed: d.seed, seconds: mixed.samples.length / mixed.rate, ms: d.ms + bedMs,
    voicesFile: d.file, bedFile, bedKey: key, bedReused: bedMs === 0, at: Date.now() })
}

const RUNNERS = {
  voice: runVoice,
  dialogue: async (body, emit) => {
    const d = await runDialogue(body, emit)
    return addTake({ id: d.file, feature: 'dialogue', file: d.file, text: clip(body.text), language: d.language,
      voice: d.voice, speakers: d.speakers, seed: d.seed, seconds: d.samples.length / d.rate, ms: d.ms, firstMs: d.firstMs, at: Date.now() })
  },
  sfx: runSfx,
  scene: runScene
}

// ------------------------------------------------------------------------------------ HTTP
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' }

// Bound to this computer; a page on another origin, or a DNS name pointed at 127.0.0.1, gets nothing.
// Always checked, also when HOST opens the demo to the network: then ALLOWED_HOSTS lists the
// addresses the other devices use (for example 192.168.1.20:3102).
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST)
const OWN_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`,
  ...(LOOPBACK ? [] : [HOST.includes(':') ? `[${HOST}]:${PORT}` : `${HOST}:${PORT}`]),
  ...String(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)])
const hostAllowed = (req) => OWN_HOSTS.has(String(req.headers.host || '').toLowerCase())
function sameOrigin (req) {
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

function send (res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function readBody (req, limit) {
  const parts = []; let n = 0
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('Request too large'); parts.push(c) }
  return Buffer.concat(parts)
}
async function readJson (req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new Error('JSON only')
  const body = JSON.parse((await readBody(req, 1e6)).toString() || '{}')
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Bad request')
  return body
}

function state () {
  sound = soundEngine(DIR)
  const features = {}
  for (const f of Object.keys(NEEDS)) {
    const lack = missing(f)
    features[f] = {
      missing: lack.map((k) => ({ key: k, label: MODELS[k].label, gb: gb(MODELS[k].bytes) })),
      needGb: gb(lack.reduce((s, k) => s + MODELS[k].bytes, 0)),
      engine: f === 'sfx' || f === 'scene' ? (sound.ok ? null : sound.reason) : null
    }
  }
  return {
    features,
    downloads: downloads.jobs,
    loaded: current ? (current.kind === 'voice' ? 'MOSS-TTS v1.5' : 'MOSS-TTSD') : null,
    busy: busy?.feature || null,
    presets: PRESETS,
    languages: LANGUAGES,
    readAloud: READ_ALOUD,
    sfxSeconds: SFX_SECONDS,
    sdk: sdkVersion,
    takes
  }
}

/** Stream a job's events to the page as NDJSON. */
async function stream (req, res, feature, body) {
  const job = { feature, cancel: null, stop: false }
  busy = job
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
  const emit = (ev) => { if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n') }
  // The page closing mid-job stops the job: no one is left to hear it.
  res.on('close', () => { if (busy === job && !res.writableFinished) { job.stop = true; job.cancel?.() } })
  const t0 = Date.now()
  try {
    const take = await RUNNERS[feature](body, emit)
    emit({ t: 'done', take, totalMs: Date.now() - t0 })
  } catch (e) {
    // A cancelled load or synthesis surfaces as the SDK's own error: it was a Stop.
    const message = busy?.stop ? 'Stopped' : String(e?.message || e)
    log.write(`[${new Date().toISOString()}] ${feature}: ${message}\n`)
    // After an unexpected failure the loaded model may be gone with the SDK worker: load again
    // next time rather than reuse an id that no longer exists.
    if (!(e instanceof UserError) && message !== 'Stopped' && !message.startsWith('The voices came back silent')) await unloadSpeech()
    emit({ t: 'error', message: message.split('\n')[0].slice(0, 300) })
  } finally {
    busy = null
    res.end()
  }
}

function serveFile (req, res, file) {
  const stat = fs.statSync(file)
  const type = TYPES[path.extname(file)] || 'application/octet-stream'
  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    // bytes=-N is the last N bytes.
    const suffix = m && !m[1] && m[2]
    const start = suffix ? Math.max(0, stat.size - Number(m[2])) : m && m[1] ? Number(m[1]) : 0
    const end = !suffix && m && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1
    if (!m || start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
      return res.end()
    }
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 })
    return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
  }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': stat.size })
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res)
}

const server = http.createServer(async (req, res) => {
  // No other site may frame the page (a hidden iframe could turn a click into a 40 GB download)
  // or embed the audio.
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (!hostAllowed(req)) return send(res, 403, { error: 'host' })
  const url = new URL(req.url, `http://localhost:${PORT}`)
  try {
    if (req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'origin' })

      if (url.pathname === '/api/run') {
        const body = await readJson(req)
        const feature = typeof body.feature === 'string' && Object.hasOwn(RUNNERS, body.feature) ? body.feature : null
        if (!feature) return send(res, 400, { error: 'Unknown feature' })
        if (busy) return send(res, 409, { error: 'Another job is running' })
        const lack = missing(feature)
        if (lack.length) return send(res, 400, { error: `Download the models first (${lack.map((k) => MODELS[k].label).join(', ')})` })
        // A file at full size is still being checked while its download job runs.
        if (NEEDS[feature].some((k) => downloads.jobs[k]?.state === 'downloading')) return send(res, 409, { error: 'A model for this tab is still downloading' })
        if ((feature === 'sfx' || feature === 'scene') && !soundEngine(DIR).ok) return send(res, 400, { error: soundEngine(DIR).reason })
        return stream(req, res, feature, body)
      }

      if (url.pathname === '/api/stop') {
        if (busy) busy.stop = true
        busy?.cancel?.()
        return send(res, 200, { ok: true })
      }

      // A voice to clone: 24 kHz mono 16-bit WAV, which the page makes from a recording or a file.
      if (url.pathname === '/api/ref') {
        if (!/^audio\/wav\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'WAV only' })
        const bytes = await readBody(req, 4e6)
        const w = parseWav(bytes)
        if (!w || w.rate !== 24000 || w.channels !== 1) return send(res, 400, { error: 'Send a 24 kHz mono 16-bit WAV' })
        if (w.seconds < 2) return send(res, 400, { error: 'The recording is shorter than 2 s' })
        if (w.seconds > MAX_REF_S) return send(res, 400, { error: `The recording is longer than ${MAX_REF_S} s` })
        const id = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)
        await fsp.writeFile(path.join(REFS, `${id}.wav`), wavBytes(w.samples, 24000))
        return send(res, 200, { id, seconds: w.seconds })
      }

      if (url.pathname === '/api/download') {
        const body = await readJson(req)
        if (!Object.hasOwn(NEEDS, body.feature)) return send(res, 400, { error: 'Unknown feature' })
        downloads.start(body.feature)
        return send(res, 200, { ok: true })
      }
      if (url.pathname === '/api/download/cancel') {
        await downloads.cancel()
        return send(res, 200, { ok: true })
      }

      if (url.pathname === '/api/takes/delete') {
        const { id } = await readJson(req)
        const gone = takes.filter((t) => t.id === id)
        takes = takes.filter((t) => t.id !== id)
        await saveTakes()
        await dropFiles(gone)
        return send(res, 200, { ok: true })
      }

      // A recorded voice the page no longer uses: delete the recording itself.
      if (url.pathname === '/api/ref/delete') {
        const { id } = await readJson(req)
        const p = refPath(id)
        if (p) await fsp.unlink(p).catch(() => {})
        return send(res, 200, { ok: true })
      }
      return send(res, 404, { error: 'not found' })
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' })
    if (url.pathname === '/api/state') return send(res, 200, state())

    if (url.pathname.startsWith('/out/') || url.pathname.startsWith('/refs/')) {
      const base = url.pathname.startsWith('/out/') ? OUT : REFS
      const name = path.basename(decodeURIComponent(url.pathname.split('/').pop()))
      const file = path.join(base, name)
      if (!name.endsWith('.wav') || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' })
      return serveFile(req, res, file)
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    const pub = path.join(DIR, 'public')
    const file = path.join(pub, rel)
    if (!file.startsWith(pub + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' })
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' })
    return res.end(await fsp.readFile(file))
  } catch (e) {
    if (!res.headersSent) return send(res, 400, { error: String(e?.message || e).slice(0, 200) })
    res.end()
  }
})
server.requestTimeout = 30000

let sdkVersion = '?'
try { sdkVersion = JSON.parse(fs.readFileSync(path.join(findPackage('@qvac/sdk', DIR), 'package.json'), 'utf8')).version } catch {}

// Already running? Say so and open it, rather than crash on the busy port.
server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err
  const link = `http://localhost:${PORT}`
  let ours = false
  try { ours = Array.isArray((await (await fetch(`${link}/api/state`)).json()).takes) } catch {}
  if (ours) {
    console.log(`The demo is already running at ${link}`)
    if (process.platform === 'darwin' && !process.env.NO_OPEN) spawn('open', [link], { stdio: 'ignore' }).on('error', () => {})
    process.exit(0)
  }
  console.error(`Port ${PORT} is used by another program. Quit it, or start on another port: PORT=${PORT + 1} npm start`)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`\nQVAC OpenMOSS audio demo  http://localhost:${PORT}   (QVAC SDK ${sdkVersion})`)
  for (const f of Object.keys(NEEDS)) {
    const m = missing(f)
    const s = (f === 'sfx' || f === 'scene') && !sound.ok ? `  (${sound.reason})` : ''
    console.log(`  ${f.padEnd(9)} ${m.length ? `download ${gb(m.reduce((a, k) => a + MODELS[k].bytes, 0))} GB in the page` : 'ready'}${s}`)
  }
  console.log(`  models: ${CACHE}\n  engine log: out/engine.log\n`)
  if (!LOOPBACK) console.log(`  HOST=${HOST}: anyone on this network can use the demo. Requests must name one of: ${[...OWN_HOSTS].join(', ')} (add more with ALLOWED_HOSTS).\n`)
})

async function quit () {
  busy?.cancel?.()
  sfxKill?.()
  await unloadSpeech()
  process.exit(0)
}
process.on('SIGINT', quit)
process.on('SIGTERM', quit)
process.on('SIGHUP', quit)
// A crash must not leave a detached sound engine running on the GPU.
process.on('exit', () => sfxKill?.())
process.on('unhandledRejection', (err) => log.write(`unhandled: ${err?.message || err}\n`))
