# Permajournal for Android

A fast, offline-first daily journal. Entries live in a local database on the
phone and are backed up to a GitHub repository shaped like
[Journal](https://github.com/ClaysonIO/journal): one Markdown file per day at
`entries/YYYY-MM-DD.md` (the folder can be changed with `rootFolderName` in
`permajournal.config.json`).

Built with Capacitor 8, React and IndexedDB. No backend server is required.

## What it does

- **Opens on today.** Cold starts always land on the current day. Coming back
  after midnight or after 30 minutes away also lands on today.
- **Month bar.** A segment for each day of the month, filled for days you
  wrote, with the count ("17 / 27 days"). Tap a segment to open that day.
- **Offline first.** Every keystroke is saved to IndexedDB within 300 ms,
  whether or not you have a connection.
- **Backs up to GitHub as soon as it can.** It syncs 2.5 s after you stop
  typing, when the app resumes or goes to the background, when the network
  comes back, and every minute while the app is open. Failures retry with
  backoff.
- **Resolves conflicts automatically.** See [Sync](#sync).
- **Years.** One page with a GitHub-style grid for every year since your
  first entry (newest at the top), shaded by how much you wrote. Tap a day to preview it, then tap
  again (or press Open) to go to it.
- **Photos.** The photo button under each day's text opens that day's photos
  in a masonry grid. Tap one to see it full-screen: pinch or double-tap to
  zoom, drag to pan, swipe to move between photos. Photos are added from the
  device's picker.
- **History.** The History page lists every entry in the database, newest
  first and grouped by month, with totals, your streak, and full-text search.

## Sign-in

It uses GitHub's **OAuth device flow**, so it needs a client ID but no client
secret and no server:

1. Create an OAuth App at <https://github.com/settings/developers> (any
   homepage and callback URL will do) and tick **Enable Device Flow**.
2. Copy `.env.example` to `.env.local` and set `VITE_GITHUB_CLIENT_ID`.
   For CI builds, set the repository variable `PERMAJOURNAL_OAUTH_CLIENT_ID`.

In the app, tap **Sign in with GitHub**. The code is copied to your clipboard
and GitHub opens so you can approve it. You can also sign in with a personal
access token that has read/write access to repository contents.

Once you're signed in, pick a repository. Journal-shaped repos (ones with
`permajournal.config.json` or an `entries/` folder) are listed first. If you
pick any other repository, the app offers to set it up.

## Sync

Sync does not use a git client. It talks to the GitHub API directly:

1. **Pull.** A GraphQL query reads the branch head. If the head moved, one
   more query lists the entries folder with each file's blob sha. Only files
   whose sha changed are downloaded, 100 per request. The first sync of about
   1,700 entries takes a couple of seconds.
2. **Merge.** Each local entry keeps the remote version it was based on. When
   both sides changed, the app does a three-way merge:
   - line by line first;
   - then word by word for edits to the same paragraph;
   - and if the edits still overlap, it keeps both versions.

   Text is never dropped. A day started separately on two devices is merged
   around the lines both versions share.
3. **Push.** All pending entries go up as one commit through the Git Data API
   (tree, then commit, then a fast-forward ref update). If another device
   pushed in the meantime, the ref update is rejected and the app pulls,
   merges and tries again.

Clearing a day's text deletes its file on the next sync.

## Photos and Git LFS

Photos use the same layout as the web app,
`entries/assets/YYYY-MM-DD/<first 8 of sha256>.jpg`, stored with
**Git LFS**:

- **Adding a photo.** The image is rotated according to its EXIF
  orientation, scaled so its longest edge is at most 2560 px, and re-encoded
  as JPEG. It's then saved to IndexedDB, so it shows up straight away and
  works offline.
- **Syncing.** The bytes go to LFS through the
  [batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)
  (batch, then PUT, then verify). The ~130-byte pointer file goes into the
  same commit as that sync's text changes. If `.gitattributes` has no
  `*.jpg filter=lfs` rule, it's added in that commit too.
- **Viewing.** Photos added on another device appear as soon as their
  pointers sync. The image itself is downloaded from LFS the first time you
  open it, then cached on the device.
- **Why native HTTP.** `github.com/<repo>.git/info/lfs/...` and the LFS
  storage host don't send CORS headers, so a WebView can't call them.
  `src/lib/http.ts` sends those requests through Capacitor's native HTTP
  instead. No server is needed.

On GitHub, LFS is on by default for every repository. The `repo` OAuth scope,
or a fine-grained token with *Contents: read and write*, covers LFS too. LFS
storage and bandwidth count against the account's Git LFS quota. Deleting a
photo removes the pointer, but the LFS object stays in storage until it's
purged on GitHub. Git history keeps
the old version.

## Logo

The logo is a grid of days whose filled cells spell a "P". It's defined in
`resources/logo.mjs`. After changing it, run `node resources/render-icons.mjs`
(this needs Playwright) to regenerate the Android launcher icons, the splash
screens and `public/logo.svg`.

## Develop

```sh
npm install
npm test            # merge, sync, photo/LFS tests (in-memory GitHub + LFS, fake IndexedDB)
npm run dev         # browser preview; device-flow calls go through the Vite proxy
npm run android:sync
npm run android:open  # build/run from Android Studio
```

Every push runs the **Android APK** workflow, which uploads a debug APK you
can install directly.

## Layout

```
src/lib/db.ts       IndexedDB: entries, per-entry summaries, pending set, sync metadata
src/lib/sync.ts     Pull → merge → push loop, retries and status
src/lib/github.ts   GraphQL reads, Git Data API commits, repository discovery
src/lib/merge.ts    Three-way text merge that never loses text
src/lib/auth.ts     Device-flow sign-in, stored session and repository
src/lib/lfs.ts      Git LFS batch API client, pointer files, .gitattributes rule
src/lib/photos.ts   Adding photos, on-demand LFS download and caching
src/lib/http.ts     Native (CORS-free) HTTP for github.com and LFS storage
src/ui/             Journal (month bar + editor), Photos (masonry + zoom viewer), Years, History, Settings, sign-in, repo picker
```
