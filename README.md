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
3. In the Firebase console, enable Firestore for your project. The app uses Firestore collections named `tasks` and `members`.
4. Run the app locally:
   `npm run dev`

## Vercel environment variables
For Vercel deploy, add the same `VITE_` Firebase keys to the project environment settings.

If you want Slack login / notification integration, also add:
- `VITE_SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `VITE_SLACK_REDIRECT_URI`

> Note: Slack OAuth requires a backend route to securely exchange the OAuth code for an access token and then send notifications to Slack.
> Set `VITE_SLACK_REDIRECT_URI` to `https://<your-app>.vercel.app/api/slack/callback`.
