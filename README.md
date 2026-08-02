# Discord ↔ Gemini real-time voice bot

Talk to Gemini out loud in a Discord voice channel. It listens, thinks, and answers
in a natural voice — no push-to-talk, and you can interrupt it mid-sentence.

## How it works

This uses the **Gemini Live API**, which takes audio in and gives audio back over a
single WebSocket. That replaces the usual STT → LLM → TTS chain, so there's one
network hop instead of three and latency stays conversational.

```
Discord voice (48kHz stereo Opus)
    ↓  opus decode + downsample
Gemini Live WebSocket (16kHz PCM in / 24kHz PCM out)
    ↓  upsample
Discord voice
```

Resampling is plain integer math in [src/audio.js](src/audio.js) — both ratios are
whole numbers (3:1 and 1:2), so there's no ffmpeg dependency.

## Prerequisites

- **Node:** tested on Node 24. Run `node -v` to verify. On Windows, installing
  the Visual Studio Build Tools is recommended if you want a native `@discordjs/opus`.
- **A Discord application and a Gemini API key:** see Setup below.

## Setup

**1. Discord application** — at https://discord.com/developers/applications:
create an app, go to **Bot** and copy the token, then **OAuth2 → URL Generator**,
tick `bot` + `applications.commands` and the `Connect` / `Speak` permissions, and
open the generated URL to invite it to your server. No privileged intents needed.

**2. Gemini key** — grab a free-tier key at https://aistudio.google.com/apikey.

**3. Configure:**

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `GEMINI_API_KEY`.

Quick start (copy & paste)

```bash
# Unix / macOS
cp .env.example .env

# PowerShell (Windows)
Copy-Item .env.example .env

npm install
npm run deploy -- YOUR_GUILD_ID
npm start
```

**4. Install and register the slash commands.** Pass your server (guild) ID to
register instantly — global registration can take up to an hour to appear:

```bash
npm install
```

```bash
npm run deploy -- YOUR_GUILD_ID
```

**5. Run it:**

```bash
npm start
```


## Commands

| Command | What it does |
| --- | --- |
| `/join` | Joins your current voice channel and opens the live session |
| `/leave` | Ends the session and disconnects |
| `/say <text>` | Types a message into the ongoing voice conversation |
| `/play <query>` | Plays a local track, radio station, or direct audio link |
| `/stop` · `/skip` | Stops the music, or moves to the next track |
| `/waifu [tag]` | Posts an anime image |

Join a voice channel, run `/join`, and just talk. Transcripts of each turn get
posted to the text channel you ran the command in.

Almost everything is also available by voice — moderation, music, memory,
search and images are all tools the model can call. The slash commands are just
a direct route to the common ones.

## Response latency

Measured time from asking to the first audio byte:

| Model | First audio |
| --- | --- |
| `gemini-3.1-flash-live-preview` | **~775 ms** |
| `gemini-2.5-flash-native-audio-latest` | ~2100 ms |

The model choice dominates everything else — the 2.5 native-audio models have a
warmer voice but are roughly three times slower to start speaking.

On top of the model, three timers add delay to *every* reply, and all of them
are silence the bot waits through before it will answer:

| Setting | Default | What it costs |
| --- | --- | --- |
| `VAD_SILENCE_MS` | 350 | Silence before Gemini calls the turn finished |
| `TURN_SILENCE_MS` | 300 | Silence before Discord closes the audio stream |
| `SPEECH_HANGOVER_MS` | 350 | Extra silence still being streamed to Gemini |

Lower them for snappier replies; too low and a pause mid-sentence gets treated
as the end of your turn, so the bot answers half a question. Raise them if it
keeps interrupting you.

## Staying connected

Gemini Live sessions expire after roughly ten minutes. The bot doesn't end the
call when that happens: it opens a new socket and resumes the same conversation
from a **session resumption handle**, so the model still remembers what was
said. The voice connection and playback stream are never touched, so from the
channel's point of view nothing happened.

It also acts on the server's `goAway` warning, reconnecting *before* the socket
drops rather than after, which puts the brief gap in a pause rather than
mid-sentence. Failed attempts back off exponentially (1s, 2s, 4s… capped at
15s) up to `GEMINI_MAX_RECONNECT` tries; only then does it give up and ask for
`/join`. If the server rejects a stale handle, it retries without one — a
conversation that lost its history still beats no bot.

## Handling multiple people and background noise

Two problems come free with a shared voice channel, and both are handled before
audio reaches Gemini.

**Noise.** Discord opens an audio stream for *any* sound — typing, breathing, a
TV in another room. Fed to a speech model that becomes hallucinated words and
constant interruptions. A gate in [src/audio.js](src/audio.js) only forwards
audio once it has been loud enough for long enough to be real speech, with a
pre-roll buffer so the first syllable survives and a hangover so pauses between
words don't chop sentences apart.

**Speaker confusion.** Everyone arrives as one mixed stream with no indication
the voice changed, so the model treats several people as one person with a
shifting personality. Two things fix that: only one speaker holds the floor at a
time (overlapping talkers are dropped rather than smeared together), and the
model is sent `[Rock is now speaking]` whenever the floor changes.

Tune with `NOISE_GATE_RMS` if it mishears. Reference levels: silence ~35,
keyboard noise ~170, speech well over 1000; the default threshold is 500.

```bash
DEBUG_GATE=1 npm start
```

Raise it if noise still gets through; lower it if quiet talkers get cut off.

The floor rule has a deliberate cost: when two people talk at once, the second
is discarded, not queued. That's the right trade for a model that cannot
separate mixed voices, but it does mean genuine crosstalk loses a speaker.

## Wake word

By default the bot answers everything it hears, which is fine one-on-one and
unbearable in a busy channel. Set `WAKE_WORD=Kamiya` and it only speaks when
addressed by name:

```
"I was playing Cyberpunk last night"   -> silence
"Hey Kamiya, what's Phantom Liberty?"  -> answers
"...and is it any good?"               -> answers (follow-up window)
```

After being addressed it stays responsive for `WAKE_FOLLOWUP_SEC` (45s default),
so a back-and-forth doesn't need the name every time. Matching tolerates one
misheard character — "Camiya" and "Kamia" both wake it.

**What this does and doesn't do.** There's no local speech recognition here, so
audio still goes to Gemini and it still composes a reply; the gate decides
whether that reply is *played*. It fixes the room, not your quota. Doing it
properly would need an on-device wake-word engine (Porcupine, openWakeWord)
running before anything is sent.

## Reading chat aloud

With `READ_MESSAGES=1`, anything typed in the channel you ran `/join` in gets
read out in voice — useful when everyone's hands are on a controller:

```
John types: "I'll be five minutes late"
   -> the bot says: "John: I'll be five minutes late."
```

The bot's own posts (transcripts, moderation notes, image embeds) land in that
same channel, so they are skipped by author — otherwise it would read itself
and never stop. System messages, empty/attachment-only posts, and messages in
other channels are ignored too. A 2-second gap between reads keeps a busy chat
from turning into a monologue, and long messages are truncated at
`READ_MAX_CHARS` rather than read in full.

Requires the **Message Content Intent** (privileged) in the Developer Portal.

## Welcoming people

With `WELCOME_VOICE=1` the bot greets arrivals in voice rather than posting a
canned line:

```
Alex joins the server
   -> "Hey Alex, welcome! What have you been playing lately?"
```

It greets people joining the bot's voice channel, and — if it's already in a
call — people brand new to the server. Bots are never greeted, and there's a
per-person cooldown (`WELCOME_COOLDOWN_MIN`, 5 min) so someone with a flaky
connection doesn't get greeted on every reconnect.

The new-member greeting needs the **Server Members Intent**; greeting people who
join the voice channel does not.

## Activity awareness

With `PROACTIVE_ACTIVITY=1` (plus `ENABLE_PRESENCE=1`) the bot notices when
someone in the channel starts a game or puts music on, and may say something:

```
Rock starts playing Cyberpunk 2077
   -> "Oh, Cyberpunk — how's Phantom Liberty treating you?"
```

Only newly-started activities count, and there's a per-person cooldown
(`ACTIVITY_COOLDOWN_MIN`, 10 min default). The model is told to stay quiet if
the room is mid-conversation, so it's a nudge rather than an announcement — but
it *is* the model's judgement, so expect it to occasionally chime in when you'd
rather it didn't. Raise the cooldown or turn it off if it grates.

## Music

Ask by voice — "play some lofi", "put on Groove Salad", "skip this", "turn the
music down" — or use `/play`, `/stop`, `/skip`.

Three kinds of source:

| Source | Example |
| --- | --- |
| Local files | drop audio in `music/`, then "play <filename>" |
| Radio stations | `lofi`, `chillhop`, `jazz`, `groove`, `synth`, `metal` |
| Direct audio links | any URL that points at an actual audio file |

Music is mixed into the same stream the bot speaks through, and **ducks to 20%
while it talks** — measured at 22% of full volume during speech, recovering to
98% afterwards. The gain eases rather than jumping, so there's no click, and it
holds through the gaps between words instead of surging back mid-sentence.

Decoding uses a bundled ffmpeg (`ffmpeg-static`), so there's nothing to install
separately. Tune with `MUSIC_VOLUME` and `MUSIC_DUCK`.

### No YouTube

YouTube links are refused, with an explanation rather than a silent failure.
Extracting audio from YouTube breaks their terms of service — it's what got
Groovy and Rythm shut down by Google — and the scraping libraries that do it
break every few weeks when YouTube changes its player. Local files, radio
streams and direct links don't have either problem.

## Web search

Ask it to look something up and it answers from live results, then posts the
written answer with its sources into the text channel:

```
"Search for what's new in Node 24"
   -> speaks a two-sentence summary
   -> posts an embed: the full answer + numbered, clickable sources
```

This uses Gemini's built-in **Google Search grounding**, not a third-party
search API — no extra key, no separate quota, and it coexists with the bot's
own function tools in one session. Duplicate citations are collapsed and at
most five sources are listed.

The split is deliberate: voice is bad at URLs, so the model is told to keep the
spoken answer to two or three sentences and never read links aloud, while the
channel keeps the readable version you can click later.

On by default. `WEB_SEARCH=0` disables it, which also reduces free-tier usage.

## Memory and reminders

Ask it to remember something and it will, across restarts:

```
"Remember that Rock's number is 555-0123"      -> stored
"What's Rock's number?"                        -> recalls it
"Remind me I have a meeting at 8am"            -> pings you at 8, out loud
"Forget the wifi password"                     -> confirms, then deletes
```

| Tool | What it does |
| --- | --- |
| `remember_this` | Stores a fact, number, preference or decision |
| `set_reminder` | Stores it *and* says it at a given time |
| `recall_memory` | Searches what's been remembered |
| `forget_memory` | Deletes an item (two-step, like other destructive actions) |
| `get_current_time` | So "8am tomorrow" resolves to the right day |

Reminders are delivered in the text channel with an @mention *and* spoken aloud
if a call is live. Everything is written to `memory-store.json` immediately —
a reminder that vanishes on restart is worse than no reminder, because someone
is relying on it. Anything that came due while the bot was offline is delivered
late rather than dropped, labelled with how late it is.

`get_current_time` exists because the model has no reliable clock. Without it
"8am tomorrow" becomes a guess; with it, the model converts to a real timestamp
and the code rejects anything already in the past.

**On privacy:** memories are stored as plain text in `memory-store.json`
(gitignored) and are shared per-server — anyone in the same guild can recall
what anyone else saved. That's usually what you want for "remind us about the
raid", and not what you want for passwords. Don't store secrets in it.

## Anime images (waifu.im)

Ask by voice — "send a waifu", "post a maid picture", "I like Raiden Shogun,
remember that" — and the image lands in the text channel you ran `/join` in.
There is also `/waifu [tag]` for direct use.

| Tool | What it does |
| --- | --- |
| `send_waifu_image` | Posts an image, optionally filtered by tag/orientation/gif |
| `set_waifu_preference` | Remembers someone's tags for when they don't name one |
| `list_waifu_tags` | The real tag list, so it offers valid choices |

Preferences are per-person, saved in `waifu-prefs.json` (gitignored).

**Adult tags require an age-restricted channel.** `ero`, `ecchi`, `hentai`,
`milf`, `oppai`, `ass`, `paizuri` and `oral` are refused unless Discord's own
NSFW flag is set on the channel, and they're hidden from `list_waifu_tags`
there too. That's Discord's mechanism, and posting adult content in a
non-age-restricted channel is against their terms.

### Providers and why there are two

`api.waifu.im/search` sits behind a Cloudflare rule that refuses non-browser
clients — `curl` gets 403 exactly like Node does, while `/tags` on the same host
answers fine. An API token does **not** help: the challenge is served before
authentication is even considered. Some networks additionally block the other
common hosts at DNS level (`api.waifu.pics` → `ENOTFOUND`).

So the bot uses whichever source actually answers:

| `WAIFU_PROVIDER` | Behaviour |
| --- | --- |
| `auto` (default) | Try waifu.im, silently fall back to nekos.life |
| `waifu.im` | Primary only — fail loudly if blocked |
| `nekos.life` | Skip the primary entirely |

The embed footer names the source that served each image.

nekos.life has a smaller vocabulary, so waifu.im tags are mapped onto its
nearest category (`maid`, `uniform`, `selfies` → `waifu`; adult tags → `lewd`)
and character tags like `raiden-shogun` have no equivalent. Age-restriction
gating applies to both providers identically.

If waifu.im ever becomes reachable for you — their Discord can allowlist a
token — set `WAIFU_PROVIDER=waifu.im` to get the full tag set back.

## Voice moderation

Say what you want and Gemini calls the matching tool — "mute Alex", "give Sam
the Member role", "kick Jordan out of the call", "delete the last ten messages".

| Tool | Required permission |
| --- | --- |
| `mute_member` / `deafen_member` | Mute Members / Deafen Members |
| `disconnect_member` | Move Members |
| `move_member` | Move Members |
| `get_member_activity` | none (read-only, needs `ENABLE_PRESENCE=1`) |
| `timeout_member` | Timeout Members |
| `manage_role` | Manage Roles |
| `delete_messages` | Manage Messages |
| `list_members` | none (read-only) |

**Authorisation is checked against the person who spoke, not the bot.** If a
user without Mute Members says "mute Alex", it's refused — otherwise anyone able
to join the voice channel could borrow the bot's admin rights by talking. On top
of that:

- Discord's role hierarchy is enforced for *both* parties: you can't act on
  someone ranked at or above you, and neither can the bot.
- The server owner and yourself are never valid targets.
- If the bot can't confidently tell who spoke (nobody talked in the last 30s),
  it refuses rather than guessing.
- Ambiguous names make it ask instead of picking someone.
- Every action is posted to the text channel, so voice moderation leaves a trail.

Attribution uses the most recent speaker, which is reliable in normal
conversation but is a heuristic — if two people talk over each other as a
command lands, it could attribute to the wrong one. The permission and hierarchy
checks still apply to whoever it picks, so the blast radius is limited to people
who already hold the permission.

### Destructive actions are two-step

`delete_messages`, `disconnect_member` and `timeout_member` never act on the
first call. It returns "not done yet, ask first"; the model asks out loud; and
only an identical second call carries it out.

This is enforced in code rather than left to the model, because instructing it
to "confirm first" does not work — it performs the action, *then* asks, and
performs it again when you agree. Ask for 5 deleted messages and you lose 10.
With the gate, the first call cannot delete anything, so that is impossible.

Changing the request (5 messages to 3) starts a fresh confirmation rather than
inheriting the old one, and a pending confirmation expires after
`MOD_CONFIRM_TTL_SEC` (2 min) so an abandoned question can't be answered later.
Set `MOD_CONFIRM_DESTRUCTIVE=0` to act on first request instead.

**Try it in dry-run first.** Set `MOD_DRY_RUN=1` and everything is logged and
narrated but nothing actually changes — worth doing while you learn how well it
hears your server's names.

### Member activity

"What's Sam playing?" reports their game, Spotify track, stream, or status.
This needs the **privileged** presence intent, so it's opt-in:

1. Developer Portal → your app → Bot → Privileged Gateway Intents
2. Enable **Presence Intent** and **Server Members Intent**
3. Set `ENABLE_PRESENCE=1`

Order matters — requesting the intent before enabling it makes login fail
outright. Left unset, the bot runs normally and only this one tool is
unavailable. Nothing is reported for members who are invisible or who hide
their activity.

### Spoken profanity filter

Off by default. Set `PROFANITY_FILTER=1` to enable: first offence gets a spoken
warning, the next gets an automatic server mute that lifts itself after
`PROFANITY_MUTE_MIN` minutes. Strikes reset after `PROFANITY_DECAY_MIN` minutes
of clean speech, so one slip doesn't follow someone around all night.

Customise the word list in `profanity.txt` (one word per line, `#` for comments)
or via `PROFANITY_WORDS`. The built-in default is deliberately small.

Matching folds case, padding ("fuuuck"), and symbol substitution ("sh!t"), and
is whole-word — "Scunthorpe", "assassin", "shiitake" and "pass" don't trigger it.

**The important limitation:** this punishes automatically, with nobody
reviewing it. Two things can go wrong — speech-to-text mishears, and with
several people talking the transcript can't be pinned to one speaker. So
enforcement only runs when **exactly one person spoke during that turn**;
overlapping voices are skipped and logged. It also can't tell a slur from a
quotation or someone discussing the word. Run it with `MOD_DRY_RUN=1` for a
while and read the log before letting it mute anyone for real.

## Free tier notes

- The Live API on the free tier allows a small number of concurrent sessions and
  is rate-limited per minute and per day. One bot in one voice channel fits; a
  busy server will hit limits.
- Live sessions have a maximum duration (~10 min for audio-only on current
  models). The bot handles this itself — see below.
- Free-tier prompts and responses may be used by Google to improve their products.
  Don't put anything sensitive through it.

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-2.5-flash-native-audio-latest` | Must be a model your key exposes for `bidiGenerateContent` — see below |
| `GEMINI_VOICE` | `Puck` | `Charon`, `Kore`, `Fenrir`, `Aoede`, `Leda`, `Orus`, `Zephyr` |
| `SYSTEM_PROMPT` | direct answerer | Sets the bot's persona — see below |

## Conversational style

Left to itself the model ends nearly every reply with a follow-up question —
"would you like me to…", "anything else?" — which in a voice channel means it
talks over people and never finishes a thought. A `STYLE_INSTRUCTION` in
[src/voice-session.js](src/voice-session.js) shuts that off: answer the
question, be specific, then stop. Length follows what the question needs rather
than a fixed "one or two sentences".

The only questions it may still ask are safety checks — which of several people
a moderation command meant, and the confirmation step before something
irreversible. Those aren't conversation, and removing them would mean muting
the wrong person.

If you want it chattier again, loosen `SYSTEM_PROMPT` in `.env`; the style rules
in code stay in force either way.

## Layout

| File | Role |
| --- | --- |
| [src/index.js](src/index.js) | Discord client, slash-command handlers |
| [src/voice-session.js](src/voice-session.js) | Per-guild session: voice connection ↔ Gemini wiring |
| [src/gemini-live.js](src/gemini-live.js) | Live API WebSocket wrapper, emits `audio` / `text` / `interrupted` |
| [src/moderation-tools.js](src/moderation-tools.js) | Tool schemas + permission/hierarchy enforcement |
| [src/audio.js](src/audio.js) | Resampling and the continuous playback stream |
| [src/single-instance.js](src/single-instance.js) | Refuses to start a second copy |

## Secrets & Security

- Keep API keys out of source control. Store them in a local `.env` (already
  ignored) and commit only `.env.example` with placeholders.
- If real tokens were committed, rotate them immediately (Discord bot token,
  Gemini API key) and remove the offending file from the repository index:

```bash
git rm --cached .env
git commit -m "Remove tracked .env containing secrets"
```

- To purge secrets from the repository history permanently, use a history
  rewrite tool such as `git filter-repo` or the BFG Repo-Cleaner. Example (BFG):

```bash
# install bfg, then:
bfg --delete-files .env
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

- Add production keys to GitHub as repository Secrets (Settings → Secrets →
  Actions / Codespaces / Dependabot) and reference them in workflows instead of
  hard-coding values.

## Troubleshooting

**Bot joins but never responds** — it must not be server-deafened; check the
channel's permissions and that it isn't muted by a role.

**Choppy playback** — `opusscript` is a pure-JS decoder, chosen here because the
native `@discordjs/opus` has no prebuilt binary for Node 24 on Windows. If you
install Visual Studio Build Tools you can `npm i @discordjs/opus` for a faster,
lower-CPU decoder; prism-media picks it up automatically.

**`Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)`** —
a DAVE (end-to-end encryption) packet the receiver couldn't decrypt. It is
thrown from a UDP callback, so it used to take the whole process down. Two
things now prevent that: the failure tolerance is raised far above the default
36, and `index.js` treats the error as survivable instead of fatal.

Do **not** try to fix it by disabling DAVE — the voice gateway then refuses the
connection and you get "never became Ready" instead. `DAVE_ENCRYPTION=0` exists
only for experimenting.

**Bot joins but the connection never becomes Ready** — you're probably on an old
`@discordjs/voice`. Discord's current voice gateway requires DAVE (end-to-end
encryption) support, added in 0.19; older releases get dropped right after
identify. This project needs **>= 0.19.2**, which pulls in `@snazzah/davey`:

```bash
npm ls @discordjs/voice
```

**"This bot is already running (pid N)"** — a second copy is live. That's the
guard doing its job: two instances break slash commands (`10062 Unknown
interaction`) and fight over the single voice session Discord allows per guild.

**Tracing a voice failure** — run with `DEBUG_VOICE=1` to log the handshake:

```bash
DEBUG_VOICE=1 npm start
```

Networking codes go `0 OpeningWs → 1 Identifying → 2 UdpHandshaking →
3 SelectingProtocol → 4 Ready`. Stalling at `1` means Discord closed the voice
websocket (library too old / bad session); stalling at `2` means outbound UDP is
blocked by a firewall.

**Bot joins, then leaves after a few seconds** — the voice connection succeeded
but Gemini rejected the session. Test that leg on its own:

```bash
npm run test:gemini
```

**`You exceeded your current quota`** — the free tier's daily Live API budget is
gone; it resets on Google's daily cycle. Long calls and search grounding both
consume it faster. `WEB_SEARCH=0` and a shorter session help; nothing in the
code can work around it.

**`... is not found for API version v1beta, or is not supported for
bidiGenerateContent`** — `GEMINI_MODEL` isn't available to your key. Live model
availability varies by account. List the ones you actually have:

```bash
node -e "import('dotenv/config').then(async()=>{const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models?key='+process.env.GEMINI_API_KEY+'&pageSize=200');const j=await r.json();j.models.filter(m=>(m.supportedGenerationMethods||[]).includes('bidiGenerateContent')).forEach(m=>console.log(m.name.replace('models/','')))})"
```

Put one of those in `GEMINI_MODEL`.
