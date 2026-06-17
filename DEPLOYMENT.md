# SpyOnSpy Deployment Guide

SpyOnSpy is a full-stack React and Express app for SPY 0DTE monitoring. It needs a Node.js host that can run a backend server because the Tradier token must stay server-side.

## Required environment variables

Set these on your hosting provider:

```bash
TRADIER_TOKEN=your_tradier_api_token
NODE_ENV=production
PORT=5000
```

Do not put the Tradier token in frontend code.

## Build and start commands

Use these on Render, Railway, Fly.io, or any Node host:

```bash
npm install
npm run build
npm start
```

The app listens on `PORT` when the host provides one, otherwise port `5000`.

## Recommended hosting

### Render

1. Create a new Web Service.
2. Upload or connect this project.
3. Runtime: Node.
4. Build command: `npm install && npm run build`
5. Start command: `npm start`
6. Add environment variable `TRADIER_TOKEN`.
7. Deploy.

### Railway

1. Create a new project.
2. Upload this source or connect a GitHub repo.
3. Add environment variable `TRADIER_TOKEN`.
4. Railway should detect Node automatically.
5. Set start command to `npm start` if it does not auto-detect.

## Local testing

```bash
cp .env.example .env
npm install
npm run build
TRADIER_TOKEN=your_token npm start
```

Then open:

```text
http://localhost:5000
```

## Notes

- The app includes PWA metadata so it can be installed as a desktop or mobile shortcut from Chrome, Edge, Safari, or Android Chrome.
- Live SPY quotes use Tradier when `TRADIER_TOKEN` is set.
- If the token is missing or a provider request fails, the dashboard falls back to public seeding and replay/simulation mode.
- The local SQLite database files are not required for deployment and are intentionally excluded from the deployment ZIP.
