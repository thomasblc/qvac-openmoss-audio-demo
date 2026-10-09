// One sound effect, in the Bare runtime, then exit.
//
// MOSS-SoundEffect runs in `@qvac/tts-ggml` (0.11.0 and newer), a Bare native addon that Node
// cannot require. The server starts this file once per clip and reads one JSON object per line
// from stdout:
//
//   argv   <addon dir> <model.gguf> <out.wav> <job json>
//   out    { t: 'loaded', ms }
//          { t: 'done', seconds, rate, ms }
//          { t: 'error', message }
//
// One process per clip, not a long-lived worker: the model loads in a few seconds against
// 30 to 100 seconds of generation, and exiting hands its 3.5 GB back before the voices reload.
// The engine's own logging goes to stderr, which the server writes to out/engine.log.
const fs = require('bare-fs')

const [, , addonDir, modelPath, outPath, jobJson] = Bare.argv
const emit = (event) => console.log(JSON.stringify(event))

function wavBytes (pcm, rate) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

async function main () {
  const job = JSON.parse(jobJson)
  const TTSGgml = require(addonDir)
  const t0 = Date.now()
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS_SFX,
    files: { mossSoundEffect: modelPath },
    config: { useGPU: true },
    seed: job.seed,
    opts: { stats: true }
  })
  await model.load()
  emit({ t: 'loaded', ms: Date.now() - t0 })

  const t1 = Date.now()
  const response = await model.run({
    input: job.prompt,
    type: 'text',
    seconds: job.seconds,
    steps: job.steps,
    ...(job.negativePrompt ? { negativePrompt: job.negativePrompt } : {})
  })
  const chunks = []
  let rate = 48000
  await response.onUpdate((data) => {
    if (data && data.outputArray && data.outputArray.length) {
      chunks.push(data.outputArray instanceof Int16Array ? data.outputArray : Int16Array.from(data.outputArray))
    }
    if (data && data.sampleRate) rate = data.sampleRate
  }).await()
  let n = 0
  for (const c of chunks) n += c.length
  if (!n) throw new Error('The sound engine returned no audio')
  const pcm = new Int16Array(n)
  let o = 0
  for (const c of chunks) { pcm.set(c, o); o += c.length }
  fs.writeFileSync(outPath, wavBytes(pcm, rate))
  emit({ t: 'done', seconds: n / rate, rate, ms: Date.now() - t1 })
  try { await model.unload() } catch {}
}

main().then(() => Bare.exit(0), (err) => {
  const message = String((err && err.message) || err)
  emit({ t: 'error', message })
  console.error(`sfx failed: ${message}`)
  // Let the two lines reach the pipes before the process goes.
  setTimeout(() => Bare.exit(1), 100)
})
