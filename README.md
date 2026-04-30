# Tech Close News

A small web app that pulls the top 10 US-listed technology-sector gainers by percent change and attaches recent company news.

## Run

```bash
npm start
```

Then open `http://localhost:3000`.

## Behavior

- Market movers come from Nasdaq's public stock screener.
- News comes from Nasdaq's symbol-news feed, with Yahoo Finance search as a fallback.
- The server refreshes automatically after the regular US market close window, 4:00 PM ET on weekdays.
- A manual refresh button is available in the UI.
- The app uses a 15-minute cache to keep the public data sources from being hammered.

The scheduler is based on the regular close window and does not yet account for US market holidays or early-close sessions.
