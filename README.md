# Jeopardy Board

A fully customizable, browser-based Jeopardy board. Build your own categories, clues, and media, run the game live, and keep score for multiple teams — all in a single static site with no backend required.

## Features

- **Editable board** — add/remove categories (columns) and value rows, edit category names and point values on the fly
- **Rich clues** — each clue supports a question, an answer, and optional image, video (including YouTube links), and audio, either via URL or direct file upload (files are embedded in the saved data, nothing is uploaded to a server)
- **Multiple sessions** — each session is a full, independent board (its own categories, clues, media, and scores); switch between them from the Sessions panel without losing progress on the others
- **Team scoreboard** — add/remove teams, adjust scores with +/− controls or type a value directly
- **Reset Round** — clear all scores and mark clues unused again while keeping all your categories/clues/media intact
- **Persistent storage** — progress saves automatically as you play, using `window.storage` when available (e.g. inside a Claude artifact) and falling back to the browser's `localStorage` otherwise

## Project structure

```
index.html    Page structure and all modals (clue, edit, sessions, dialogs)
style.css     All styling
app.js        App logic — rendering the board, teams, clue/edit modals, sessions
storage.js    Storage layer (Store) and session management (SessionStore)
```

## Running it

This is a static site — no build step or server needed.

1. Download all four files (`index.html`, `style.css`, `app.js`, `storage.js`) into the same folder.
2. Open `index.html` directly in a browser, or serve the folder with any static file server.

## Hosting it online (optional)

To make it accessible via a URL instead of just opening the file locally, you can use **GitHub Pages**:

1. Push this repo to GitHub.
2. Go to **Settings → Pages** on the repo.
3. Under "Build and deployment", set the source to your `main` branch (root folder).
4. GitHub will publish it at `https://<your-username>.github.io/<repo-name>/`.

## Usage

- Click **Edit Board** to enter edit mode — add/remove categories, rows, and teams, and click any clue cell to fill in its question, answer, and media.
- Click **Done Editing** to exit edit mode and start playing — click a clue's dollar value to open it, reveal the answer, and mark it complete.
- Use **Sessions** to create new boards or switch between saved ones.
- Use **Reset Round** to wipe scores/clue-used state for a rematch without re-entering all your content.

## Notes

- All data is stored locally in your browser (or in artifact storage, if running inside one) — nothing is sent to a server.
- Uploaded media files are embedded directly in the saved session data, so very large files may increase storage size.