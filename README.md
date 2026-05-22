<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/3b82aed9-6e8b-4078-a43c-33eb21e47b11

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Create a `.env.local` file and configure your Firebase values:
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`
3. In the Firebase console, enable **Firestore** for your project.
4. Deploy security rules from `firestore.rules` (Firebase Console → Firestore → Rules → paste & publish), or run `firebase deploy --only firestore:rules`.
5. The app uses collections: `members` (user accounts by email), `tasks`, `chatMessages`.

### Shared team usage (important for Vercel URL)

When everyone opens the same app URL and logs in with their email:

- **First login** → account is created and saved (Firestore + local backup).
- **Next visit** → same email auto-logs in (session saved in browser).
- **Members tab** → shows everyone who has logged in (synced via Firestore in real time).

**You must set all `VITE_FIREBASE_*` variables on Vercel.** Without them, data stays only in each browser and members cannot see each other across devices.

6. Run the app locally:
   `npm run dev`

## Deploy (GitHub → Vercel)

This repo is wired for **push-to-deploy**:

1. **Auto-push to GitHub** (one-time setup on your machine):
   ```bash
   npm run setup:deploy
   ```
   After this, every `git commit` on your machine automatically runs `git push`, so GitHub stays up to date.

2. **Vercel updates** (choose one):
   - **Recommended:** In [Vercel Dashboard](https://vercel.com) → Project **task-app** → Settings → Git, connect `bemeengineer1234-code/task-app` and enable **Production Branch: main**. Each push to `main` triggers a deploy (no extra secrets).
   - **Optional:** GitHub Actions workflow `.github/workflows/vercel-production.yml` deploys via CLI. Add repository secret `VERCEL_TOKEN` from [Vercel Account Tokens](https://vercel.com/account/tokens).

3. **CI:** `.github/workflows/ci.yml` runs lint + build on every push/PR to `main`.

Manual push (if hooks are not enabled):
```bash
git add -A
git commit -m "your message"
git push origin main
```

## Vercel environment variables
For Vercel deploy, add the same `VITE_` Firebase keys to the project environment settings.

If you want Slack login / notification integration, also add:
- `VITE_SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `VITE_SLACK_REDIRECT_URI`

> Note: Slack OAuth requires a backend route to securely exchange the OAuth code for an access token and then send notifications to Slack.
> Set `VITE_SLACK_REDIRECT_URI` to `https://<your-app>.vercel.app/api/slack/callback`.
