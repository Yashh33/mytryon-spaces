# mytryon-spaces — working rules (read first, every session)

## Deploys
- The live app (used by Reflection Lifestyle) runs on Render from the `production` branch. Auto-deploy is OFF.
- Always work on `main`. Commit and push only to `main`. Never commit, merge or push to `production`, and never trigger a Render deploy.
- Yash or his partner merges main → production and clicks Manual Deploy himself, at quiet times (before the showroom opens or after it closes).
- Never say a change is "live". Say: "Pushed to main — goes live when you merge to production and deploy."
- Before every push: `git pull --rebase` (a second developer also pushes to main).

## Database
- Local runs use the SAME Supabase database as the live app. Test only in Yash's demo shop. Never create, edit or delete Reflection Lifestyle's data. No image generation unless Yash asks.
- On deploy, the app's startup code runs database changes (ALTER TABLE etc.) automatically.
- If a task adds, changes or removes a table or column, or changes rows in the settings table:
  1. Run `python scripts/backup_db.py` BEFORE touching the database.
  2. End the task report with the line: "DATABASE CHANGE — run `python scripts/backup_db.py` again right before deploying."
- Backups live in `supabase-db-backup/` (git-ignored — never commit backups; they contain customer data).

## Prompts
- Prompts edited at /admin/prompt are stored in the database and go live instantly. Never change saved settings in the live database unless Yash asks.

## End of every task, report
- Commits pushed to main.
- Database change: yes/no. Settings change: yes/no.
- Anything Yash must do in Render, GitHub or Supabase.

## Two developers
- Yash and his partner both work on this repo, each with Claude (chat) for planning and Claude Code (VS Code) for coding. The same rules apply to both.
- Never both work at the same time. Always `git pull` before starting.

## No testing by Claude Code
- Do not run browser tests, do not start a test database, and do not generate images. They cost credits and time; the developer tests himself.
- After changes: check the app builds without errors (backend starts, frontend builds), commit and push to main, then restart the local servers on the new code.

## Local servers
Windows PowerShell, from the repo folder. The backend needs the `.env` file (it points at the live Supabase database — see Database above).

Backend (first terminal) — http://127.0.0.1:8000:
```powershell
.\venv\Scripts\Activate.ps1
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Frontend (second terminal) — open http://localhost:5173 (Vite sends `/api` and `/media` to the backend on 127.0.0.1:8000, see `frontend/vite.config.js`):
```powershell
cd frontend
npm run dev
```

If PowerShell refuses to run `Activate.ps1`, run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

Image model settings (in `.env` locally, in Render → Environment for the live app; if missing, the defaults below are used):
```
# The OpenAI image model for room renders, "Fix this" and the product studio (default gpt-image-2.5-flare)
IMAGE_MODEL=gpt-image-2.5-flare
# Its quality: low, medium, high, xhigh, max or auto (default high; 2.5 "high" costs about what GPT Image 2 "medium" did)
IMAGE_QUALITY=high
```
To switch back to GPT Image 2: `IMAGE_MODEL=gpt-image-2` and `IMAGE_QUALITY=medium`, then restart the backend.

## Experiments (Draw on photo)
Four switches, in `.env` locally and in Render → Environment for the live app; restart the backend after changing them. If one is missing, the code uses "off".
```
# on: the original wall wording (the gap writer's wall answers); off: piece sentences say nothing about walls
DRAW_WALL_WORDS=on
# on: the "OPEN FLOOR AROUND EACH SOFA" section and its gap writer call; off: neither
DRAW_OPEN_FLOOR=on
# on: each piece gets a sentence saying which way its seats face in the photo, worked out in code from its shape; off: nothing changes
DRAW_FACING=off
# on: a white arrow on each guide box pointing the way its seats face, and the prompt says so; off: nothing changes
DRAW_ARROWS=off
```

| Config | WALL_WORDS | OPEN_FLOOR | FACING | ARROWS | Status |
|---|---|---|---|---|---|
| Original (safe fallback) | on | on | off | off | Known good — go back to this if experiments fail |
| Variant A | off | off | off | off | Discarded: sofa near a wall turned to face along it |
| Variant B | off | on | off | off | Discarded (not needed) |
| S21 facing sentence | off | off | on | off | Works — keep. S21 fixed: front direction = black-edge middle → opposite-edge middle (perspective-safe); the arrow uses the same vector |
| S23 end sentence (part of FACING=on) | off | off | on | any | S23 reinstated: needed for corner sofas (mirrored 2/2 without it) — which end of the long part the lounge / shorter part is at, as seen in the photo |
| S22 arrows | off | off | on | on | Testing |
| S11 seat counts | any | any | any | any | Testing — picked on the Furniture step (L-shape, corner, curved); "Not sure" = no seat count |
| S24 back cushions | not the original | | | | Testing — one back cushion per seat, in every config except the original |

To fall back: set WALL_WORDS=on, OPEN_FLOOR=on, FACING=off, ARROWS=off, restart the backend. With no seat count picked, that gives exactly the original prompt and guide image.

The Debug panel's info line shows the switches that made each render and each piece's seats (e.g. "walls off · open floor off · facing on · arrows on · 1 seats: 3 + lounge · 2 seats: 3").

## Deploying (done by a person, never by Claude Code)
- If the task changed the database: run `python scripts/backup_db.py` first.
- Then:
  ```
  git checkout main
  git pull
  git status            (must be clean)
  git checkout production
  git pull
  git merge main
  git push
  git checkout main
  ```
- Then Render → Manual Deploy → Deploy latest commit. If it breaks: Render → Events → Rollback.

## Codebase dumps
- `codebase-dump*.txt` and `codebase_dump*.txt` are git-ignored. Never commit them.
