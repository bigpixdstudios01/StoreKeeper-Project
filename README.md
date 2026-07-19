# StoreKeeper360 — Retail Inventory Manager

A full-stack retail inventory, sales, and profit/loss tracking app. Consolidated into just **two code files** for simple uploading and editing from a phone.

---

## File Structure

```
storekeeper360/
├── index.html          ← EVERYTHING frontend: HTML, CSS, JS, logo, all inline
├── api/
│   └── index.js         ← EVERYTHING backend: all routes, all logic, one file
├── vercel.json           ← Routing + no-cache headers
├── package.json
├── .env                   ← Your real Supabase credentials (never upload this)
├── .env.example            ← Safe template version
├── .gitignore
└── supabase/
    └── schema.sql           ← Run this once in Supabase's SQL Editor (setup only, not app code)
```

Only **one folder** (`api/`) plus the one-time `supabase/schema.sql` setup script — everything else is a single file at the root.

---

## Before You Start

**Do you still have your existing Supabase project** (the one with URL `jgpnmdsspzrgxrnpofwc.supabase.co`)?
- **If yes** — you don't need to touch Supabase at all. Skip straight to "Fresh GitHub Repo" below. Your existing data, users, and schema are untouched.
- **If you deleted that too** — you'll need to create a new Supabase project and run `supabase/schema.sql` again, then update the credentials in both `.env` and `index.html` (search for `SUPABASE_URL` near the top of the big `<script>` block).

---

## Step 1 — Create a Fresh GitHub Repository

1. Go to **github.com** → **New repository**
2. Name it anything (e.g. `StoreKeeper360`)
3. Leave it empty — don't add a README, .gitignore, or license (we already have our own)
4. **Create repository**

---

## Step 2 — Push This Project (via Termux)

```bash
cd ~/storage/downloads
unzip -o storekeeper360-final.zip
cd storekeeper360-final

git init
git add .
git status
```

**Before committing, check this output carefully:**
- Every file should be listed **without any folder prefix** (e.g. `index.html`, not `storekeeper360-final/index.html`) — if you see a prefix, you're one folder too high; `cd` into the actual project folder first
- `.env` should **NOT** appear in the list (it's protected by `.gitignore`) — if it does, stop and tell me

Once that looks right:
```bash
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

When prompted for a password, use a **GitHub Personal Access Token** (Settings → Developer settings → Personal access tokens → Generate new token classic → check "repo" scope), pasted via your keyboard's clipboard button — not typed manually.

---

## Step 3 — Create a Fresh Vercel Project

1. **vercel.com** → **Add New → Project**
2. Import your new GitHub repo
3. Before deploying, add these **Environment Variables**:
   ```
   SUPABASE_URL = https://jgpnmdsspzrgxrnpofwc.supabase.co
   SUPABASE_SERVICE_ROLE_KEY = (your service_role key)
   ```
   (Get this again from Supabase → Project Settings → API if you don't have it saved)
4. **Deploy**

---

## Step 4 — Connect Supabase to Your New Domain

1. Copy your new Vercel URL (e.g. `https://your-new-project.vercel.app`)
2. Supabase → **Authentication → URL Configuration → Redirect URLs**
3. Make sure your new URL is listed there (remove any old ones pointing to your previous Vercel domain if you like, though extra entries don't hurt)

---

## Step 5 — Test

Visit your new live URL in a private/incognito tab first (avoids any leftover cache from testing). Try:
- Sign up / log in
- Add a product, record a sale with each payment method
- Check the receipt modal appears and both tabs (Merchant/Customer) work
- Try light/dark theme toggle
- Try "Forgot password" end to end

If anything shows a **red error banner** at the top of the page, screenshot it and send it over — that banner shows the exact JavaScript error, file, and line number, so we can fix it immediately without needing browser dev tools.

---

## Security Reminder

Your `.env` file contains your real service_role key. It's excluded from git via `.gitignore` — always double check `git status` doesn't list it before pushing. If you ever accidentally expose it, regenerate it from **Supabase → Project Settings → API → service_role → Reset**.
