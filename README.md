# YT Video Chatbot

End-to-end system for video-centric AI assistance with:
- Telegram bot chat and commands(Optional to connect)
- Chrome extension side-panel chat on YouTube
- Transcript/summary/highlight ingestion from Whisper service
- Multi-mode chat (`friendly`, `normal`, `educational`)
- Proactive in-video guidance triggered by watch behavior and content importance
<img width="700"  alt="image" src="https://github.com/user-attachments/assets/a8a0229b-f84e-4b20-acd9-2159dcb0cab1" />

<img width="778" height="344" alt="chat" src="https://github.com/user-attachments/assets/55612491-c935-4cf1-b5b9-cf76b19a45d4" />

## 1) Setup and Run

## 1.1 Prerequisites

- Node.js 18+
- PostgreSQL
- Redis
- Whisper service reachable by backend
- LLM endpoint compatible with OpenAI chat completions API
- Optional: YouTube Data API key (for recommendations)

## 1.2 Install

```bash
npm install
```

## 1.3 Configure Environment

Create `.env` from `env.example`, then ensure these keys are set:

- Required
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_BOT_USERNAME`
  - `DATABASE_URL`
  - `REDIS_URL`
- Strongly recommended
  - `LLM_BASE_URL` (if missing, defaults to `http://host.docker.internal:1234/v1`)
  - `LLM_MODEL`
  - `WHISPER_URL`
  - `YOUTUBE_API_KEY` (needed for `/recommendations` real YouTube search hits)

Proactive tuning vars (optional):
- `PROACTIVE_PAUSE_SECONDS`
- `PROACTIVE_COOLDOWN_SECONDS`
- `PROACTIVE_DEFINITION_THRESHOLD`
- `PROACTIVE_COMPLEX_THRESHOLD`
- `PROACTIVE_SECTION_COOLDOWN_SECONDS`
- `PROACTIVE_RESUME_BREAK_SECONDS`
- `PROACTIVE_SEEK_JUMP_SECONDS`
- `PROACTIVE_KEY_MOMENT_MIN_DELAY_SECONDS`
- `PROACTIVE_KEY_MOMENT_MAX_DELAY_SECONDS`
- `PROACTIVE_EVENT_COALESCE_MS`
- `PROACTIVE_EVENT_RETRY_MS`
- `PROACTIVE_REPLY_WINDOW_SECONDS`
- `PROACTIVE_SHORT_REPLY_MAX_CHARS`

## 1.4) Quick Start Checklist

1. Fill `.env` values (DB, Redis, Telegram, LLM, Whisper)
2. `npm install`
3. `npm run migrate`
4. `npm run dev`
5. Load extension unpacked from `extension/`
6. Pair extension with Telegram `/start pair_<code>`
7. Open YouTube video + chat window
8. Generate transcript/summary and start chatting/proactive testing


Docker set up:

```bash
# 1) Stop app stack
docker compose down

# 2) Remove all DB/Redis volumes (DESTROYS data)
docker compose down -v

# 3) Start services fresh (builds the Whisper image on first run)
docker compose up -d --build

# 4) Re-run DB schema
npm run migrate

# 5) Start app
npm run dev
```

---


## 2) Proactive Trigger Conditions 


Primary trigger reasons in `src/services/proactive/triggers.js`:

- `long_pause`
  - fires when paused longer than `pauseSeconds` policy threshold
- `resume_after_break`
  - on play after inactivity >= `RESUME_BREAK_SECONDS`
- `video_complete`
  - end event or near-end boundary and not already sent
- `rewatch_confusion`
  - repeated backward seeks in recent window
- `hesitation_confusion`
  - repeated quick pause/play cycles
- `forward_jump`
  - seek/progress jump larger than adaptive jump threshold
- `definition`
  - segment score passes definition threshold
- `complex_concept`
  - segment score passes complexity threshold
- `rhetorical_question`
  - segment contains question and enough def/complex evidence
- `section_start`
  - section boundary cues (time gap / discourse cue / early boundary)
- `progress_checkpoint`
  - milestone checkpoints by watch progress ratio
- `key_moment`
  - segment aligns with summary/highlights importance score
  - delayed by highlight timing window or sustained importance fallback

### 2.1 Key Moment Delay Logic

`key_moment` does not fire instantly:
- If in a highlight window:
  - wait until a delayed point inside the window
  - delay clamped by `PROACTIVE_KEY_MOMENT_MIN_DELAY_SECONDS` and `PROACTIVE_KEY_MOMENT_MAX_DELAY_SECONDS`
- If no timed highlight:
  - requires sustained importance (~16s fallback behavior)


## 3) Telegram Commands


Registered in `src/bot/index.js`:
- `/start`
- `/help`
- `/summary`
- `/watchlist`
- `/switch <number>`
- `/source`
- `/save`
- `/recommendations [count]`
- `/question [type] [count]`
- `/highlight`
- `/current`
- `/mode <friendly|normal|educational>`
- `/clear`

---
<img width="604"  alt="image" src="https://github.com/user-attachments/assets/8a66b7bc-c4ad-4cf9-ab52-9c3aef9ae211" />
<img width="700"  alt="image" src="https://github.com/user-attachments/assets/117f4edb-51f1-4cdc-9730-7c6246b72d4a" />

