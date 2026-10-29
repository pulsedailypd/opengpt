# OpenGPT

A ChatGPT-style app with:
- Streaming AI chat, chat history, Markdown + code blocks with copy buttons
- Login through a separate **Firebase-hosted sign-in website** (Google + email/password), then automatic return to the app, logged in
- **"Hey Open"** voice wake-up (plus a mic button for one-off dictation, and spoken replies to voice questions)
- Your AI API key stays on the server. The browser never sees it.

```
opengpt/
├─ server.js          Express server: verifies Firebase login, calls the AI API
├─ .env.example       Copy to .env and fill in
├─ public/            The app (index.html, app.js, style.css, config.js)
└─ auth-site/         The login website you deploy to Firebase Hosting
```

## How login works
1. User presses **Log in** in the app and is sent to your auth website (`auth-site`).
2. They sign in with Google or email.
3. The auth website sends them back to the app with their Firebase token.
4. The app calls `/api/chat` with that token. The server verifies it before talking to the AI.

---

## Step 1: Create the Firebase project and login website

1. Go to https://console.firebase.google.com, click **Add project**, and name it.
2. **Build > Authentication > Get started > Sign-in method**. Enable **Email/Password** and **Google**.
3. **Project settings (gear icon) > General > Your apps > Web (</>)**. Register an app (name it OpenGPT). Copy the `firebaseConfig` values.
4. Open `auth-site/index.html` and paste them into `firebaseConfig`.
   Also set `ALLOWED_APP_ORIGINS` to the address(es) where your app runs (e.g. `http://localhost:3000` and later your real domain).
5. Deploy the login website:
   ```bash
   npm install -g firebase-tools
   firebase login
   cd auth-site
   firebase init hosting     # choose your project, public directory ".", single-page app: No, don't overwrite index.html
   firebase deploy --only hosting
   ```
   You get a URL like `https://your-project.web.app`. This is your login website. `*.web.app` and `localhost` are already authorized for sign-in.

   To test locally first: `cd auth-site && npx serve -l 5000` then use `http://localhost:5000`.
6. If your app will run on your own domain, add it in **Authentication > Settings > Authorized domains** (only needed when the login page itself is served from that domain; the app domain only needs to be in `ALLOWED_APP_ORIGINS`).

## Step 2: Connect the app

1. In `public/config.js` set `authUrl` (your login website URL) and `firebaseApiKey` (the `apiKey` from step 3).
2. Copy `.env.example` to `.env` and fill in:
   - `FIREBASE_PROJECT_ID`: your Firebase project ID
   - `AI_API_KEY`: your AI provider key
   - `AI_BASE_URL` / `AI_MODEL`: any OpenAI-compatible API works. Check your provider's docs for the current model name.
3. Run it (Node 18 or newer):
   ```bash
   npm install
   npm start
   ```
4. Open http://localhost:3000, press **Log in**, sign in, and you land back in the app.

## Voice wake-up: "Hey Open"
- Click **Hey Open: off** in the top bar to turn it on and allow the microphone.
- Say "Hey Open, what's the capital of Japan?" in one go, or say "Hey Open", wait for the chime, then ask.
- Replies to voice questions are read aloud. The mic button in the message box dictates one message.

Limits to know about:
- Works in Chrome, Edge and Safari. Firefox doesn't support speech recognition.
- Needs `https://` or `localhost`, and **the OpenGPT tab must be open**. A website can't listen after the browser or tab is closed. Waking up a closed app needs a native desktop/mobile app (for example Electron with an on-device wake-word engine such as Picovoice Porcupine).
- Browser speech recognition sends audio to the browser vendor's speech service.

## Deploying the app
Host the `opengpt` folder on any Node host (Render, Railway, Fly.io, a VPS). Set the `.env` values as environment variables, then:
1. Update `authUrl` if needed, and add the app's public URL to `ALLOWED_APP_ORIGINS` in `auth-site/index.html`, then redeploy the auth site.
2. Serve over HTTPS.

## Security notes
- The login redirect is restricted by `ALLOWED_APP_ORIGINS`, so only your app can receive a sign-in.
- The ID token travels in the URL fragment (not sent to servers) and the app removes it from the address bar immediately.
- Chats are stored in this browser's localStorage, per user. For cross-device history, add a database (Firestore) later.
- Add real rate limiting and usage caps before opening the app to the public. The included limiter is a basic in-memory one.
