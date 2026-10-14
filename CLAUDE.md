# mytryon-spaces — working rules (read first, every session)

## Deploys
- The live app (used by Reflection Lifestyle) runs on Render from the `production` branch. Auto-deploy is OFF.
- Always work on `main`. Commit and push only to `main`. Never commit, merge or push to `production`, and never trigger a Render deploy.
- Yash merges main → production and clicks Manual Deploy himself, at quiet times (before the showroom opens or after it closes).
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
