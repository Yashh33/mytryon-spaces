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
