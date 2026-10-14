# TrainingPro (TrainTrack-Web)

Workplace **training & competency management** system for Akara Resources (Chatree gold mine, Thailand).
It manages employees, courses, competencies, records, and includes an **AI Content Studio** that generates
training manuals, plans, SOPs, forms, operational guidelines and more from uploaded source material.

- **Stack:** Node.js + Express, SQLite (WAL), vanilla-JS single-page app (no framework)
- **AI:** Anthropic Claude (content generation / translation) and OpenAI (image generation), via a central AI gateway
- **Entry point:** `server.js`

---

## Prerequisites

- **Node.js 18+** (LTS recommended)
- **npm**
- (Windows) nothing else required — SQLite is bundled via the `sqlite3` dependency

---

## Setup

```bash
# 1. Clone
git clone https://github.com/Mason-tati/TrainingPro.git
cd TrainingPro

# 2. Install dependencies
npm install
```

That's it for files — **the database is created automatically** on first run from
[`database/schema.sql`](database/schema.sql) (tables are created with `CREATE TABLE IF NOT EXISTS`).
No database file is included in the repo.

> **Note:** `database/*.db`, `uploads/`, `node_modules/`, and API keys are intentionally **not** committed
> (see [`.gitignore`](.gitignore)). A fresh clone starts with an empty database and no credentials.

---

## Running

```bash
# Default port (3000)
npm start

# Or choose a port (e.g. 5050)
PORT=5050 npm start           # macOS/Linux
$env:PORT=5050; npm start     # Windows PowerShell

# Development (auto-restart on file changes)
npm run dev
```

Then open **http://localhost:3000** (or your chosen port).

### First login

A default administrator account is created on first run:

```
Username: admin
Password: admin123
```

> ⚠️ **Change this password immediately** after first login (Admin → Users). The server logs a
> high-severity warning while the default credential is still in use.

---

## Configuration

### AI API keys (required for the AI Content Studio)

Keys are stored **encrypted at rest** in the database (never in the repo). Set them either way:

- **In the app:** Admin → Settings → paste your Anthropic and/or OpenAI keys, **or**
- **Environment variables:** `OPENAI_API_KEY` (OpenAI); the Anthropic key is read from app settings.

Without an Anthropic key, document generation/translation is unavailable; without an OpenAI key, AI image
generation is unavailable. The rest of the app (records, competencies, forms, exports) works regardless.

### Company branding

Company name, logo and document terminology replacements are configured under **Admin → Settings**
(stored in the `tblConfig` table).

---

## Project structure

```
server.js             # Express app entry point
lib/                  # Core libraries
  content.js          #   AI content generation, DOCX/XLSX/HTML builders
  ai-gateway.js       #   Central AI provider gateway (audit + policy)
  secret-config.js    #   Encrypted API-key storage
routes/               # API route handlers (content, exams, settings, …)
public/               # Front-end SPA
  index.html
  js/app.js           #   All client logic
  css/style.css
database/
  db.js               #   DB access + auto-init from schema
  schema.sql          #   Full database schema (data files are NOT committed)
uploads/              # Uploaded source documents (git-ignored at runtime)
docs/ARCHITECTURE.md  # Architecture & design notes
tests/                # Automated test suite (unit / api / db / docgen …)
```

---

## Testing

```bash
npm test              # full suite
npm run test:unit     # unit tests only
npm run test:ai       # AI gateway / content tests
npm run test:security # security tests
```

Tests run offline (a network guard blocks outbound calls).

---

## Notes

- **Data is not in the repo.** The database (with all records and API keys) and uploaded documents stay on
  the machine that runs the app. To move real data between machines, copy the `database/` and `uploads/`
  folders directly (not via Git).
- **Large memory headroom:** the `start` script runs Node with `--max-old-space-size=4096` for large
  document generation.

---

*Internal software for Akara Resources. Not for public distribution.*
