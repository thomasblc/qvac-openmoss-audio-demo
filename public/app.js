'use strict'
// The page. Every model runs in the server; this file sends jobs, plays speech while it is being
// generated, records the voices to clone, and lists what was made.

const $ = (s, el = document) => el.querySelector(s)
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (v === true) el.setAttribute(k, '')
    else if (v !== false && v != null) el.setAttribute(k, v)
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)))
  return el
}

const FEATURES = [
  { id: 'voice', name: 'Expressive speech', model: 'MOSS-TTS v1.5', verb: 'Speak it', label: 'Text' },
  { id: 'dialogue', name: 'Dialogue', model: 'MOSS-TTSD', verb: 'Voice the dialogue', label: 'Script' },
  { id: 'sfx', name: 'Sound effects', model: 'MOSS-SoundEffect v2', verb: 'Make the sound', label: 'Sound' },
  { id: 'scene', name: 'Sound scene', model: 'MOSS-TTSD + MOSS-SoundEffect', verb: 'Build the scene', label: 'Script' }
]

const state = {
  server: null,
  feature: 'voice',
  running: false,
  fresh: null,            // the take to highlight
  playedLive: false,      // its audio was already heard while it was generated
  rec: null,              // the recording in progress
  form: {
    voice: { preset: 'excited', text: '', language: 'en', voice: 'model', ref: null, length: 0 },
    dialogue: { preset: 'night', text: '', language: 'en', voices: 'model', speakers: [] },
    sfx: { preset: 'rooster', text: '', seconds: 8, steps: 50, avoid: '' },
    scene: { preset: 'dog', text: '', ambience: '', voices: 'model', steps: 50, speakers: [] }
  }
}

function toast (msg) {
  const t = $('#toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toast.t)
  toast.t = setTimeout(() => { t.hidden = true }, 6000)
}

async function api (url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`)
  return data
}

async function refresh () {
  state.server = await (await fetch('/api/state')).json()
  for (const f of FEATURES) {
    const form = state.form[f.id]
    const p = state.server.presets[f.id].find((x) => x.id === form.preset)
    if (!form.text && p) applyPreset(f.id, p)
  }
}

function applyPreset (feature, p) {
  const form = state.form[feature]
  form.preset = p.id
  form.text = p.text
  if (p.language) form.language = p.language
  if (p.ambience) form.ambience = p.ambience
  if (p.steps) form.steps = p.steps
}

// ------------------------------------------------------------------------------ live audio
// Speech arrives in 2 s chunks while the rest is still being generated; each one is scheduled
// right after the previous, so they play as one take.
const live = { ctx: null, at: 0, nodes: [] }
function liveStart () {
  liveStop()
  live.ctx = live.ctx || new AudioContext()
  live.ctx.resume()
  live.at = 0
  live.nodes = []
}
function livePlay (b64, rate) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1)
  if (!pcm.length) return
  const buf = live.ctx.createBuffer(1, pcm.length, rate)
  const ch = buf.getChannelData(0)
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768
  const node = live.ctx.createBufferSource()
  node.buffer = buf
  node.connect(live.ctx.destination)
  const at = Math.max(live.ctx.currentTime + 0.08, live.at)
  node.start(at)
  live.at = at + buf.duration
  live.nodes.push(node)
}
function liveStop () { for (const n of live.nodes) { try { n.stop() } catch {} } live.nodes = [] }

// ------------------------------------------------------------------------------ recording
/** Any audio the browser can decode -> 24 kHz mono 16-bit WAV, the format MOSS clones from. */
async function toWav24k (blob) {
  const ctx = new AudioContext()
  let decoded
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()) } finally { ctx.close() }
  if (decoded.duration > 60) throw new Error(`This recording is ${Math.round(decoded.duration)} s; use 60 s or less`)
  if (decoded.duration < 2) throw new Error('This recording is shorter than 2 s')
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 24000), 24000)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const data = (await off.startRendering()).getChannelData(0)
  let peak = 0
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  const gain = peak > 0 ? Math.min(4, 0.89 / peak) : 1
  const out = new DataView(new ArrayBuffer(44 + data.length * 2))
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); out.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, 24000, true)
  out.setUint32(28, 48000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, data.length * 2, true)
  for (let i = 0; i < data.length; i++) out.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(data[i] * gain * 32767))), true)
  return new Blob([out.buffer], { type: 'audio/wav' })
}

async function uploadRef (blob) {
  const wav = await toWav24k(blob)
  const res = await fetch('/api/ref', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'The recording was refused')
  return data
}

/** Record from the microphone until stopped, at most 20 s. `slot` names who is recording. */
async function startRecording (slot, onRef) {
  let stream
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false } }) } catch {
    toast('The microphone is blocked. Allow it for this page, or add a file instead.')
    return
  }
  let recorder
  try { recorder = new MediaRecorder(stream) } catch {
    stream.getTracks().forEach((t) => t.stop())
    toast('This browser cannot record here. Add a file instead.')
    return
  }
  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop())
    clearInterval(state.rec?.timer)
    state.rec = null
    try { onRef(await uploadRef(new Blob(chunks, { type: recorder.mimeType }))) } catch (e) { toast(e.message) }
    render()
  }
  state.rec = { slot, recorder, t0: performance.now(), timer: setInterval(() => {
    const el = $('#rec-time')
    const s = (performance.now() - state.rec.t0) / 1000
    if (el) el.textContent = `${s.toFixed(0)} s`
    if (s >= 20) recorder.stop()
  }, 250) }
  try { recorder.start() } catch {
    clearInterval(state.rec.timer)
    state.rec = null
    stream.getTracks().forEach((t) => t.stop())
    toast('The recording could not start. Add a file instead.')
  }
  render()
}

/** Delete a recorded voice on the server once nothing on the page uses it any more. */
function forgetRef (id) {
  const used = [state.form.voice.ref, ...state.form.dialogue.speakers.map((s) => s.ref), ...state.form.scene.speakers.map((s) => s.ref)]
  if (!used.some((r) => r && r.id === id)) api('/api/ref/delete', { id }).catch(() => {})
}

function pickFile (onRef) {
  const input = h('input', { type: 'file', accept: 'audio/*' })
  input.addEventListener('change', async () => {
    const file = input.files[0]
    if (!file) return
    try { onRef(await uploadRef(file)) } catch (e) { toast(e.message) }
    render()
  })
  input.click()
}

/** Record / Add a file, or the voice already given with a way to drop it. */
function voiceSource (slot, ref, onRef, onClear) {
  const recording = state.rec?.slot === slot
  if (recording) {
    return h('div', { class: 'recrow' },
      h('button', { type: 'button', class: 'rec on', onclick: () => state.rec.recorder.stop() }, 'Stop'),
      h('span', { class: 'rectime', id: 'rec-time' }, '0 s'))
  }
  if (ref) {
    return h('div', { class: 'recrow' },
      h('audio', { controls: true, preload: 'metadata', src: `/refs/${ref.id}.wav` }),
      h('span', { class: 'rectime' }, `${ref.seconds.toFixed(1)} s`),
      h('button', { type: 'button', class: 'del', disabled: state.running, onclick: () => { onClear(); forgetRef(ref.id); render() } }, 'Remove'))
  }
  const blocked = state.running || !!state.rec
  return h('div', { class: 'recrow' },
    h('button', { type: 'button', class: 'rec', disabled: blocked, onclick: () => startRecording(slot, onRef) }, 'Record'),
    h('button', { type: 'button', class: 'ghost', disabled: blocked, onclick: () => pickFile(onRef) }, 'Add a file'))
}

// ------------------------------------------------------------------------------------- nav
function engineChip () {
  const chip = $('#engine')
  const l = state.server?.loaded
  chip.textContent = l ? `Loaded: ${l}` : 'Nothing loaded'
  chip.classList.toggle('live', !!l)
}

function renderNav () {
  $('#list').replaceChildren(...FEATURES.map((f) => {
    const st = state.server.features[f.id]
    const note = st.missing.length ? `Download ${st.needGb} GB` : st.engine ? 'Sound engine missing' : f.model
    return h('li', {}, h('button', {
      type: 'button',
      'aria-current': String(state.feature === f.id),
      disabled: state.running,
      onclick: () => { state.feature = f.id; state.fresh = null; render() }
    }, h('span', { class: 'n' }, f.name), h('span', { class: st.missing.length || st.engine ? 'm warn' : 'm' }, note)))
  }))
}

// ---------------------------------------------------------------------------------- panels
function render () {
  if (!state.server) return
  renderNav()
  engineChip()
  const f = FEATURES.find((x) => x.id === state.feature)
  $('#panel').replaceChildren(
    h('header', { class: 'head' }, h('h2', {}, f.name), h('p', { class: 'model' }, f.model)),
    makePanel(f))
}

function seg (label, options, value, onPick) {
  return h('div', { class: 'ctl' },
    h('span', { class: 'lbl' }, label),
    h('div', { class: 'seg', role: 'group', 'aria-label': label },
      options.map(([v, text]) => h('button', {
        type: 'button', 'aria-pressed': String(v === value), disabled: state.running,
        onclick: () => { onPick(v); render() }
      }, text))))
}

function languagePicker (form) {
  const sel = h('select', { id: 'lang', class: 'select', disabled: state.running },
    state.server.languages.map(([code, name]) => h('option', { value: code, selected: code === form.language }, name)))
  sel.addEventListener('change', () => { form.language = sel.value })
  return h('label', { class: 'ctl', for: 'lang' }, h('span', { class: 'lbl' }, 'Language'), sel)
}

function downloadCard (feature) {
  const st = state.server.features[feature]
  const jobs = state.server.downloads
  const active = st.missing.some((m) => ['queued', 'downloading'].includes(jobs[m.key]?.state))
  const rows = st.missing.map((m) => {
    const j = jobs[m.key]
    const pct = j && j.total ? Math.floor((j.downloaded / j.total) * 100) : 0
    const status = !j ? `${m.gb} GB`
      : j.state === 'downloading' ? `${pct}%`
        : j.state === 'queued' ? 'Waiting'
          : j.state === 'error' ? 'Failed' : j.state === 'cancelled' ? 'Stopped' : `${m.gb} GB`
    return h('li', { class: 'dl' },
      h('span', { class: 'dl-name' }, m.label),
      h('span', { class: j?.state === 'error' ? 'dl-status why' : 'dl-status' }, status),
      h('div', { class: 'meter', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': m.label },
        h('i', { style: `--p:${pct}%` })))
  })
  const err = st.missing.map((m) => jobs[m.key]).find((j) => j?.state === 'error')
  return h('div', { class: 'card download' },
    h('ul', { class: 'dls' }, rows),
    err ? h('p', { class: 'why small' }, err.error) : null,
    h('div', { class: 'action' },
      active
        ? h('button', { type: 'button', class: 'ghost', onclick: () => api('/api/download/cancel').then(poll) }, 'Stop downloading')
        : h('button', { type: 'button', class: 'run', onclick: () => api('/api/download', { feature }).then(poll) }, `Download ${st.needGb} GB`),
      h('span', { class: 'hint' }, 'From the QVAC Registry, once')))
}

function speakerRows (form, script) {
  const count = Math.min(5, Math.max(1, ...[...script.matchAll(/\[S(\d)\]/g)].map((m) => Number(m[1]))))
  while (form.speakers.length < count) form.speakers.push({ ref: null, transcript: state.server.readAloud[form.speakers.length] })
  return h('div', { class: 'speakers' }, form.speakers.slice(0, count).map((s, i) => {
    const said = h('input', { class: 'input line', id: `said-${i}`, value: s.transcript, disabled: state.running, spellcheck: 'false', 'data-content': true })
    said.addEventListener('input', () => { s.transcript = said.value })
    return h('div', { class: 'speaker' },
      h('span', { class: 'tag' }, `S${i + 1}`),
      h('div', { class: 'speaker-body' },
        h('label', { class: 'lbl', for: `said-${i}` }, s.ref ? 'What it says' : 'Read aloud'),
        said,
        voiceSource(`speaker-${i}`, s.ref, (r) => { s.ref = r }, () => { s.ref = null })))
  }))
}

function estimate (feature, form) {
  if (feature === 'sfx') return `about ${state.server.sfxSeconds[form.steps]} s`
  if (feature === 'scene') return `about ${15 + state.server.sfxSeconds[form.steps]} s`
  return ''
}

function makePanel (f) {
  const form = state.form[f.id]
  const st = state.server.features[f.id]
  const wrap = h('div', {})
  if (st.missing.length) wrap.append(downloadCard(f.id))

  wrap.append(h('div', { class: 'presets', role: 'group', 'aria-label': 'Examples' },
    state.server.presets[f.id].map((p) => h('button', {
      type: 'button', class: 'preset', 'aria-pressed': String(form.preset === p.id), disabled: state.running,
      onclick: () => { applyPreset(f.id, p); render() }
    }, p.label))))

  const scripted = f.id === 'dialogue' || f.id === 'scene'
  const ta = h('textarea', { class: scripted ? 'input script' : 'input', id: 'text', rows: scripted ? 6 : 3, spellcheck: 'false', disabled: state.running, 'data-content': true })
  ta.value = form.text
  ta.addEventListener('input', () => {
    form.text = ta.value
    form.preset = null
    for (const b of wrap.querySelectorAll('.preset')) b.setAttribute('aria-pressed', 'false')
  })
  const field = h('label', { class: 'field', for: 'text' }, h('span', { class: 'lbl' }, f.label), ta)
  wrap.append(field)

  if (f.id === 'voice') {
    field.append(h('div', { class: 'tools' },
      h('button', { type: 'button', class: 'ghost small', disabled: state.running, onclick: () => insertAtCursor(ta, ' [pause 1.0s] ', form) }, 'Insert a pause'),
      h('span', { class: 'hint small' }, 'IPA like /təˈmɑːtoʊ/ or Pinyin like ni3 hao3 sets a pronunciation')))
    wrap.append(h('div', { class: 'controls' },
      languagePicker(form),
      seg('Voice', [['model', 'Model voice'], ['clone', 'Your voice']], form.voice, (v) => { form.voice = v }),
      seg('Length', [[0, 'Free'], [5, '5 s'], [8, '8 s'], [12, '12 s']], form.length, (v) => { form.length = v })))
    if (form.voice === 'clone') {
      wrap.append(h('div', { class: 'card clone' },
        h('span', { class: 'lbl' }, 'Voice to clone'),
        voiceSource('voice', form.ref, (r) => { form.ref = r }, () => { form.ref = null })))
    }
  }
  if (f.id === 'dialogue' || f.id === 'scene') {
    if (f.id === 'scene') {
      const amb = h('textarea', { class: 'input', id: 'ambience', rows: 2, spellcheck: 'false', disabled: state.running, 'data-content': true })
      amb.value = form.ambience
      amb.addEventListener('input', () => { form.ambience = amb.value; form.preset = null })
      wrap.append(h('label', { class: 'field', for: 'ambience' }, h('span', { class: 'lbl' }, 'Ambience'), amb))
    }
    wrap.append(h('div', { class: 'controls' },
      f.id === 'dialogue' ? languagePicker(form) : null,
      seg('Voices', [['model', 'Model voices'], ['clone', 'Your voices']], form.voices, (v) => { form.voices = v }),
      f.id === 'scene' ? seg('Ambience', [[25, 'Draft'], [50, 'Standard']], form.steps, (v) => { form.steps = v }) : null))
    if (form.voices === 'clone') wrap.append(speakerRows(form, form.text))
  }
  if (f.id === 'sfx') {
    const avoid = h('input', { class: 'input line', id: 'avoid', value: form.avoid, placeholder: 'music, speech', disabled: state.running, spellcheck: 'false' })
    avoid.addEventListener('input', () => { form.avoid = avoid.value })
    wrap.append(h('div', { class: 'controls' },
      seg('Length', [[4, '4 s'], [8, '8 s'], [15, '15 s'], [30, '30 s']], form.seconds, (v) => { form.seconds = v }),
      seg('Quality', [[25, 'Draft'], [50, 'Standard'], [100, 'Full']], form.steps, (v) => { form.steps = v }),
      h('label', { class: 'ctl grow', for: 'avoid' }, h('span', { class: 'lbl' }, 'Avoid'), avoid)))
  }

  const elsewhere = !state.running && state.server.busy ? 'Another job is still running' : null
  const blocked = elsewhere || (st.missing.length ? 'Download the models first' : st.engine || null)
  const run = h('button', { type: 'button', class: 'run', id: 'run', disabled: state.running || !!blocked, title: blocked }, f.verb)
  const again = h('button', { type: 'button', class: 'ghost', disabled: state.running || !!blocked, title: blocked || 'Same settings, another random seed' }, 'Another take')
  const stop = h('button', { type: 'button', class: 'ghost', hidden: !state.running && !elsewhere, onclick: () => api('/api/stop').catch(() => {}) }, 'Stop')
  const hint = h('span', { class: blocked ? 'hint why' : 'hint', id: 'hint' }, blocked || estimate(f.id, form))
  run.addEventListener('click', () => go(f, false))
  again.addEventListener('click', () => go(f, true))
  wrap.append(h('div', { class: 'action' }, run, again, stop, hint))
  wrap.append(takeList(f.id))
  return wrap
}

function insertAtCursor (ta, text, form) {
  const a = ta.selectionStart ?? ta.value.length
  const b = ta.selectionEnd ?? a
  ta.value = ta.value.slice(0, a) + text + ta.value.slice(b)
  form.text = ta.value
  form.preset = null
  ta.focus()
  ta.selectionStart = ta.selectionEnd = a + text.length
}

function takeList (feature) {
  const list = state.server.takes.filter((t) => t.feature === feature)
  const box = h('div', { class: 'takes' })
  if (!list.length) return box
  box.append(h('p', { class: 'takes-h' }, `${list.length} ${list.length === 1 ? 'take' : 'takes'}`))
  const langName = Object.fromEntries(state.server.languages)
  for (const t of list.slice(0, 12)) {
    const meta = [
      `${t.seconds.toFixed(1)} s audio`,
      `${(t.ms / 1000).toFixed(1)} s to make`,
      t.firstMs != null && feature === 'voice' ? `first sound ${(t.firstMs / 1000).toFixed(1)} s` : null,
      t.language && t.language !== 'en' ? langName[t.language] : null,
      t.voice === 'clone' ? 'cloned voice' : null,
      t.steps && feature === 'sfx' ? `${t.steps} steps` : null,
      feature === 'scene' && t.bedReused ? 'ambience reused' : null
    ].filter(Boolean)
    const audio = h('audio', { controls: true, preload: 'metadata', src: `/out/${encodeURIComponent(t.file)}` })
    const card = h('article', { class: state.fresh === t.id ? 'take fresh' : 'take' },
      h('p', { class: 'said', 'data-content': true }, t.text),
      t.ambience ? h('p', { class: 'amb', 'data-content': true }, t.ambience) : null,
      audio,
      h('div', { class: 'meta' }, meta.map((m) => h('span', { class: 'fact' }, m)), h('span', { class: 'grow' }),
        h('a', { class: 'del', href: `/out/${encodeURIComponent(t.file)}`, download: t.file }, 'Save'),
        h('button', { type: 'button', class: 'del', disabled: state.running, onclick: async () => {
          await api('/api/takes/delete', { id: t.id }).catch((e) => toast(e.message))
          await refresh(); render()
        } }, 'Remove')))
    box.append(card)
    if (state.fresh === t.id && !state.playedLive && state.autoplayed !== t.id) {
      state.autoplayed = t.id
      queueMicrotask(() => audio.play().catch(() => {}))
    }
  }
  return box
}

// ---------------------------------------------------------------------------------- running
/** POST, then read the NDJSON stream. */
async function streamJob (body, onEvent) {
  const res = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok || !res.body) {
    let msg = `The server answered ${res.status}`
    try { msg = (await res.json()).error || msg } catch {}
    throw new Error(msg)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''; let last = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const ev = JSON.parse(line)
      onEvent(ev)
      if (ev.t === 'done' || ev.t === 'error') last = ev
    }
  }
  if (!last) throw new Error('The engine stopped without an answer')
  if (last.t === 'error') throw new Error(last.message)
  return last
}

async function go (f, random) {
  const form = state.form[f.id]
  if (!form.text.trim()) { toast('Write something first'); return }
  const body = { feature: f.id, random, text: form.text, language: form.language }
  if (f.id === 'voice') Object.assign(body, { voice: form.voice, refId: form.ref?.id, length: form.length })
  if (f.id === 'dialogue' || f.id === 'scene') {
    Object.assign(body, { voices: form.voices, speakers: form.speakers.map((s) => ({ refId: s.ref?.id, transcript: s.transcript })) })
  }
  if (f.id === 'sfx') Object.assign(body, { seconds: form.seconds, steps: form.steps, avoid: form.avoid })
  if (f.id === 'scene') Object.assign(body, { ambience: form.ambience, steps: form.steps })

  state.running = true
  state.fresh = null
  state.playedLive = false
  liveStart()
  render()
  const hint = $('#hint')
  let phase = 'Starting'
  const t0 = performance.now()
  hint.classList.add('live')
  const tick = () => { hint.textContent = `${phase} · ${((performance.now() - t0) / 1000).toFixed(0)} s` }
  tick()
  const timer = setInterval(tick, 250)
  try {
    const ev = await streamJob(body, (e) => {
      if (e.t === 'loading') { phase = `Loading ${e.model}`; state.server.loaded = null; engineChip() }
      if (e.t === 'loaded') phase = 'Generating'
      if (e.t === 'stage') phase = e.label
      if (e.t === 'audio') { livePlay(e.pcm, e.rate); state.playedLive = true; phase = 'Playing while it is generated' }
    })
    state.fresh = ev.take.id
  } catch (e) {
    liveStop()
    toast(e.message)
  } finally {
    clearInterval(timer)
    state.running = false
    try { await refresh() } catch { toast('The server stopped answering. Start it again, then reload.') }
    render()
    if (state.server.busy) watchBusy()
  }
}

// While a download runs the page polls; otherwise it only asks after an action.
// Only the nav and the progress bars are redrawn while downloading, so a take that is playing
// keeps playing; the panel is redrawn once, when the downloads end.
let polling = null
function poll () {
  clearInterval(polling)
  const step = async () => {
    try { await refresh() } catch { return }
    const downloading = Object.values(state.server.downloads).some((j) => j.state === 'queued' || j.state === 'downloading')
    if (downloading) { renderNav(); updateMeters() } else { clearInterval(polling); if (!state.running) render() }
  }
  step()
  polling = setInterval(step, 1000)
}

// A job started before this page loaded (another tab, or a reload): show it as running, with Stop,
// until it ends.
let watching = null
function watchBusy () {
  if (watching) return
  watching = setInterval(async () => {
    try { await refresh() } catch { return }
    if (!state.server.busy) { clearInterval(watching); watching = null; if (!state.running) render() }
  }, 2000)
}
function updateMeters () {
  const card = $('.download')
  if (card) card.replaceWith(downloadCard(state.feature))
}

;(async () => {
  await refresh()
  render()
  if (Object.values(state.server.downloads).some((j) => j.state === 'queued' || j.state === 'downloading')) poll()
  if (state.server.busy) watchBusy()
})()
