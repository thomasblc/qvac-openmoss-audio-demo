// The examples on each tab. Seeds are pinned where a take was picked by ear, so the example
// plays back the same way every time it is generated.

export const LANGUAGES = [
  ['en', 'English'], ['zh', 'Chinese'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['ja', 'Japanese'], ['pt', 'Portuguese'], ['it', 'Italian'], ['ko', 'Korean'], ['ru', 'Russian'],
  ['ar', 'Arabic'], ['hi', 'Hindi'], ['nl', 'Dutch'], ['pl', 'Polish'], ['tr', 'Turkish'],
  ['yue', 'Cantonese'], ['cs', 'Czech'], ['da', 'Danish'], ['fa', 'Persian'], ['fi', 'Finnish'],
  ['el', 'Greek'], ['he', 'Hebrew'], ['hu', 'Hungarian'], ['mk', 'Macedonian'], ['ms', 'Malay'],
  ['ro', 'Romanian'], ['sw', 'Swahili'], ['sv', 'Swedish'], ['tl', 'Tagalog'], ['th', 'Thai'],
  ['vi', 'Vietnamese']
]

export const PRESETS = {
  voice: [
    // MOSS-TTS has no emotion setting: the wording, the punctuation and the seed carry it.
    { id: 'excited', label: 'Excited', seed: 7, language: 'en', text: 'Oh my gosh, we did it! We actually did it! I cannot believe it, this is the best day ever! Come here, you have to hear this!' },
    { id: 'sad', label: 'Sad', seed: 7, language: 'en', text: 'I really thought... we would have more time. Now the room feels so empty without you. I miss your voice. I just wish I could hear it, one more time.' },
    { id: 'angry', label: 'Angry', language: 'en', text: 'Enough! You promised this would be fixed, and nothing has changed! I am tired of excuses. Take responsibility and fix this right now!' },
    { id: 'pause', label: 'Pauses', language: 'en', text: 'First, a short pause. [pause 0.5s] Now, a longer one. [pause 2.0s] And now we continue speaking.' },
    { id: 'ipa', label: 'Pronunciation', language: 'en', text: 'Some people say /təˈmeɪtoʊ/, and some people say /təˈmɑːtoʊ/.' },
    { id: 'french', label: 'French', seed: 7, language: 'fr', text: "Le pont s'ouvre à l'aube. Apporte la carte, et ne fais pas confiance au marchand." },
    { id: 'japanese', label: 'Japanese', seed: 7, language: 'ja', text: '橋は夜明けに開く。地図を持っていけ。そして、商人を信じるな。' }
  ],
  dialogue: [
    { id: 'night', label: 'Night shift', text: '[S1] Welcome back to The Night Shift. Leo, I hear your story starts with a broken coffee machine.\n[S2] It does. Around midnight it died, and while I looked for a cable, an old radio started saying my name.\n[S1] Your actual name? Please tell me you ran.\n[S2] I did not. It was my colleagues. A speaker, a microphone, and a very elaborate prank.' },
    { id: 'launch', label: 'Launch day', text: '[S1] Did the build finish?\n[S2] Every test passed, and the release notes are written.\n[S1] Then we ship it before lunch.\n[S2] Before coffee, if you push the button now.' },
    { id: 'tavern', label: 'Three voices', text: '[S1] Welcome, travellers. Rooms are two silver a night.\n[S2] Two silver? The last inn charged us one.\n[S3] And the last inn had rats in the beds.\n[S1] She is right. Ours only has a cat.' }
  ],
  sfx: [
    { id: 'f1', label: 'Race car', text: 'A Formula One race car accelerates hard, its engine rises to a high-pitched roar, then it speeds past and fades into the distance.' },
    { id: 'ship', label: 'Spaceship', text: 'A massive spaceship powers up with a deep pulsing hum. Its engines build into a powerful roaring rumble, then it blasts past with a sweeping sci-fi whoosh and fades into the distance.' },
    { id: 'wolf', label: 'Wolf pack', text: 'A pack of wolves howls in a quiet forest at night. One wolf begins with a long, deep howl, then several others join with overlapping rising and falling howls. Their calls echo through the forest and gradually fade into the distance.' },
    { id: 'rooster', label: 'Roosters', text: 'Several roosters crow at dawn on a quiet farm. One nearby rooster lets out a loud, raspy cock-a-doodle-doo, then others answer from farther away. Their repeated calls overlap, with brief pauses and faint chicken clucks in the background.' }
  ],
  scene: [
    { id: 'dog', label: 'Dog next door', steps: 50, text: '[S1] Is that your dog barking again?\n[S2] Yes, sorry. He barks at every bike that goes past.\n[S1] Every bike? We live next to a cycle lane.\n[S2] I know. He has a very busy day.',
      ambience: 'A medium-sized dog barking in a backyard nearby: a few sharp barks, a pause, then barking again, with birds and light wind in the background.' },
    { id: 'rain', label: 'Night shift', steps: 25, text: '[S1] Welcome back to The Night Shift. Leo, I hear your story starts with a broken coffee machine.\n[S2] It does. Around midnight it died, and while I looked for a cable, an old radio started saying my name.',
      ambience: 'Steady rain against a window at night, an old radio hissing with faint static, a distant car passing now and then.' },
    { id: 'office', label: 'Launch day', steps: 25, text: '[S1] Did the build finish?\n[S2] Every test passed, and the release notes are written.\n[S1] Then we ship it before lunch.\n[S2] Before coffee, if you push the button now.',
      ambience: 'A busy open-plan office, keyboards typing, quiet chatter, a coffee machine hissing in the background.' }
  ]
}

// What each speaker reads aloud to lend their voice to the dialogue. MOSS-TTSD continues a
// recording from its transcript, so a known sentence is the transcript.
export const READ_ALOUD = [
  'The library closes at nine, but the reading room stays open until ten on weekdays.',
  'I took the early train this morning, and the whole carriage smelled of fresh coffee.',
  'If the weather holds, we will walk along the river and have lunch at the old mill.',
  'My grandmother kept every letter she ever received in a tin box under her bed.',
  'The new bridge took four years to build, and it opened on the first day of spring.'
]
