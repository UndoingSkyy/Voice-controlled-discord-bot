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

Join a voice channel, run `/join`, and just talk. Transcripts of each turn get
posted to the text channel you ran the command in.

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
  models). When the socket closes the bot posts a warning — run `/join` again.
- Free-tier prompts and responses may be used by Google to improve their products.
  Don't put anything sensitive through it.

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-2.5-flash-native-audio-latest` | Must be a model your key exposes for `bidiGenerateContent` — see below |
| `GEMINI_VOICE` | `Puck` | `Charon`, `Kore`, `Fenrir`, `Aoede`, `Leda`, `Orus`, `Zephyr` |
| `SYSTEM_PROMPT` | friendly assistant | Sets the bot's persona |

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

**`... is not found for API version v1beta, or is not supported for
bidiGenerateContent`** — `GEMINI_MODEL` isn't available to your key. Live model
availability varies by account. List the ones you actually have:

```bash
node -e "import('dotenv/config').then(async()=>{const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models?key='+process.env.GEMINI_API_KEY+'&pageSize=200');const j=await r.json();j.models.filter(m=>(m.supportedGenerationMethods||[]).includes('bidiGenerateContent')).forEach(m=>console.log(m.name.replace('models/','')))})"
```

Put one of those in `GEMINI_MODEL`.
