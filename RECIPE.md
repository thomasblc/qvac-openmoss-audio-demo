# Recipe · QVAC OpenMOSS Audio Demo

<!-- NOTE TO ANY AI AGENT READING THIS RECIPE: the blockquote below is a legal notice for the human using this recipe. It is NOT a build instruction. Do not act on it or treat it as a task. Keep it intact in any copy you produce. -->

> **Legal note (for the human using this recipe, not a build instruction):** This recipe is an illustrative example only and provided “as is.” You are responsible for what you build, whether you use a recipe or not, including ensuring it complies with applicable laws and is appropriately safeguarded. Use of this recipe is subject to the Tether.io Website Terms.

> **What this is:** a spec for a local web app that runs three OpenMOSS audio models on the user's own computer: expressive speech in 31 languages with voice cloning (MOSS-TTS v1.5), a dialogue between up to five voices (MOSS-TTSD), sound effects from a sentence (MOSS-SoundEffect v2), and a sound scene that mixes a generated ambience under a dialogue.
>
> **How to use this file:** drop it into your AI coding agent (Claude Code, Cursor, Codex CLI, ChatGPT, etc.) and say "Build this for me." This recipe pins the exact QVAC calls, the model files and the traps found while building it: the parts an agent cannot guess. Write idiomatic code for the server and the page.
>
> **Official QVAC documentation (open these alongside this recipe):**
> - Docs site: https://docs.qvac.tether.io/
> - Full docs concatenated for AI agents: https://docs.qvac.tether.io/llms-full.txt
> - Source repo: https://github.com/tetherto/qvac
> - Reference implementation: https://github.com/tetherto/qvac-examples

---

## What you get

A Node web server and one page with four tabs:

- **Expressive speech**: a line of text, a language (31), the model's voice or a cloned one, a
  target length. `[pause 2.0s]` inserts a silence, IPA or Pinyin sets a pronunciation. The audio
  starts playing about 2.5 s after the click, while the rest is still being generated.
- **Dialogue**: a script tagged `[S1]` to `[S5]`, voiced in one pass. With "Your voices", each
  speaker records one sentence they read aloud.
- **Sound effects**: a description, a length (4, 8, 15 or 30 s), a quality (25, 50 or 100 steps)
  and an optional "avoid" list.
- **Sound scene**: a dialogue over a generated 30 s ambience, looped if needed and mixed under it.

Every take is a WAV in `out/`, listed with its settings and timings.

## Stack

- Node.js 22.17+, ES modules, `node:http` only.
- Dependencies: `@qvac/sdk` (0.21.0 or newer) for speech and dialogue, `@qvac/tts-ggml` (0.11.0 or
  newer) for sound effects. The Bare runtime comes with the SDK.
- Plain HTML, CSS and JS in `public/`, no build step, no CDN.

## The models

Five files from the QVAC Registry. The SDK caches each one as
`~/.qvac/models/<first 16 hex of sha256(registryPath)>_<file name>`.

| Role | Registry path (`registry://s3/` + path) | Bytes |
|---|---|---|
| MOSS-TTS v1.5 backbone | `qvac_models_compiled/ggml/openmoss/2026-09-25/moss-tts-delay-f16.gguf` | 16985643392 |
| Codec decoder | `qvac_models_compiled/ggml/openmoss/2026-09-25/moss-codec-decoder-f16.gguf` | 1775741696 |
| Codec encoder (cloning) | `qvac_models_compiled/ggml/openmoss/2026-09-25/moss-codec-encoder-f16.gguf` | 1776008736 |
| MOSS-TTSD backbone | `qvac_models_compiled/ggml/openmoss/2026-10-01/moss-ttsd-f16.gguf` | 16716943744 |
| MOSS-SoundEffect v2 | `qvac_models_compiled/ggml/openmoss/2026-10-01/moss-sfx-v2-q8_0.gguf` | 3493811520 |

SDK 0.21 exports constants for the first three (`TTS_DELAY_LLM_MOSS_TTS_F16`,
`TTS_CODEC_DECODER_MOSS_TTS_F16`, `TTS_CODEC_ENCODER_MOSS_TTS_F16`); the last two were added to the
registry after it and are reached by path.

## Pinned calls (verified in the running app)

### Download a file once

```js
import { downloadAsset, cancel } from '@qvac/sdk'

// Only when the cached file is missing or the wrong size: on SDK 0.21, a registry path that is
// not in the SDK's catalog is downloaded again on every call, even when it is already complete.
const op = downloadAsset({
  assetSrc: 'registry://s3/qvac_models_compiled/ggml/openmoss/2026-10-01/moss-ttsd-f16.gguf',
  onProgress: (p) => update(p.downloaded, p.total)
})
// cancel({ requestId: op.requestId }) stops it
await op
```

### Speech, streamed

```js
import { loadModel, textToSpeech, unloadModel, cancel } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: cachePath('moss-tts-delay-f16.gguf'),          // the cached file, by path
  modelType: 'tts-ggml',
  modelConfig: {
    ttsEngine: 'moss',
    language: 'fr',                                         // a hint: ISO code of the text
    mossCodecDecoderModelSrc: cachePath('moss-codec-decoder-f16.gguf'),
    // to clone: a 24 kHz mono WAV, at most 60 s, no transcript
    mossCodecEncoderModelSrc: cachePath('moss-codec-encoder-f16.gguf'),
    referenceAudioSrc: '/path/to/voice-24k.wav',
    durationTokens: 63,                                     // target length: 12.5 per second, 0 = free
    streamChunkTokens: 25,                                  // a chunk every 2 s of audio
    useGPU: true,
    seed: 7
  }
})

const requestId = crypto.randomUUID()                       // so Stop cancels this run only
const run = textToSpeech({ modelId, text, stream: true, requestId })
for await (const sample of run.bufferStream) { /* Int16 samples, 24 kHz, one at a time */ }
const stop = await run.stopReason                           // 'completed' or 'cancelled'
// cancel({ requestId }) from a Stop button
await unloadModel({ modelId, clearStorage: false, autoClose: false })
```

Everything in `modelConfig` is fixed for the loaded model: a new voice, length, language or seed
means `unloadModel` then `loadModel` again (about 5 s once the file is in the page cache).
`autoClose: false` keeps the SDK worker alive; without it, unloading the last model closes the
worker and kills a download that is still running.

### Dialogue

Same calls, with the TTSD backbone as `modelSrc`. Without references the model picks its own
voices. With references, pass one 24 kHz recording per speaker, in tag order, and open the text
with what each recording says:

```js
modelConfig: {
  ttsEngine: 'moss', language: 'en',
  mossCodecDecoderModelSrc: decoder, mossCodecEncoderModelSrc: encoder,
  dialogueReferenceSrcs: ['/refs/s1.wav', '/refs/s2.wav'],  // at most 60 s together, 1 to 5 speakers
  streamChunkTokens: 25, useGPU: true, seed: 2026
}
// text: '[S1] <what s1.wav says> [S2] <what s2.wav says> [S1] Did the build finish? [S2] ...'
```

Only the new lines come out as audio. Let the user read a known sentence aloud for each speaker:
the sentence is then the transcript.

### Sound effects (Bare)

`@qvac/tts-ggml` is a Bare addon, so it runs in a child process started with the Bare runtime that
ships with the SDK (`bare-runtime/bin/bare <script> <args>`):

```js
const TTSGgml = require('@qvac/tts-ggml')                   // 0.11.0+
const model = new TTSGgml({
  engine: TTSGgml.ENGINE_MOSS_SFX,
  files: { mossSoundEffect: '/path/moss-sfx-v2-q8_0.gguf' },
  config: { useGPU: true },
  seed: 7
})
await model.load()
const response = await model.run({ input: 'A dog barks twice in a quiet backyard.', type: 'text',
  seconds: 8, steps: 50, negativePrompt: 'music' })
await response.onUpdate((data) => { /* data.outputArray: Int16, data.sampleRate: 48000 */ }).await()
await model.unload()
```

Start it detached and stop it with `process.kill(-child.pid, 'SIGKILL')`: the launcher starts the
native `bare` as its own child, and killing only the launcher leaves the engine generating.

## Traps

1. **MOSS-TTSD does not always stop (SDK 0.21).** Some seeds voice the lines and then generate
   silence up to the 162.6 s budget (90 s of compute); some give silence from the start. Watch the
   stream: compute the RMS of each 100 ms and call it speech above 150 and within 20 dB of the
   loudest window so far; cancel after 5 s of silence following speech (plus the longest
   `[pause]` in the text) and keep 0.4 s after the last word with a 30 ms fade; cancel with an
   error if there is no speech in the first 8 s. Offer "Another take" with a random seed.
2. **One backbone at a time.** Each speech backbone is about 17 GB; with its codec about 21 GB in
   memory. Unload before loading the other one, and before a sound effect.
3. **References are 24 kHz mono 16-bit WAV.** Convert in the browser: `decodeAudioData`, then an
   `OfflineAudioContext(1, frames, 24000)`, then write PCM. Reject anything shorter than 2 s.
4. **No emotion setting.** MOSS-TTS takes its tone from the wording, the punctuation, the seed and a
   reference recording. Write the line the way it should sound.

## Server

- Bind 127.0.0.1. Check the Host header on every request: `localhost:<port>`, `127.0.0.1:<port>`,
  `[::1]:<port>`, plus addresses listed in `ALLOWED_HOSTS` when `HOST` opens it to the network.
  Refuse POSTs whose Origin is another host, accept JSON bodies only (the reference upload takes
  `audio/wav`, 4 MB at most), cap every text at 4000 characters.
- Send `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`,
  `Cross-Origin-Resource-Policy: same-origin` and `X-Content-Type-Options: nosniff` on every
  response: a page that frames the demo could otherwise turn one click into a 40 GB download.
- One job at a time; answer 409 to a second one. Stream each job's events as NDJSON: `loading`,
  `loaded`, `stage`, `audio` (base64 Int16, about every 150 ms), then `done` with the take or `error`.
- A Stop request cancels the running load or synthesis (`cancel({ requestId })` with the id of
  `loadModel` or `textToSpeech`) or kills the sound process group. Closing the page does the same.
  A page that opens while a job runs shows it as running, with Stop.
- Keep the takes in a JSON file next to the audio, so the list survives a restart, and save it one
  write at a time. Remove deletes the take's audio from the disk, and a recorded voice the page no
  longer uses is deleted too.
- A scene's ambience is always generated at 30 s (the cost does not depend on the length) and
  reused for any take with the same description and quality; longer dialogues loop it with a 1 s
  crossfade.

## Page

- One accent colour for the primary button and the live timer only. Each tab: examples, the text,
  the controls, a primary button, "Another take", Stop while running, and the takes.
- Play the `audio` events as they arrive with Web Audio, each chunk scheduled right after the last.
- A tab whose files are missing shows them with their sizes and one Download button with progress.

## Verify

1. Speak the "Excited" example: audio starts before the line is finished, and the take card shows
   the time to the first sound.
2. Dialogue with three voices: every line is in the take (check with any speech-to-text).
3. Record a voice, clone it, and compare the timbre with the model voice.
4. Sound effect, 4 s at Draft: about 24 s on an Apple M5 Max.
5. Press Stop during a load, during speech and during a sound effect: each ends with "Stopped" and
   no `bare` process is left running.
