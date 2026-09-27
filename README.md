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

Clearing a day's text deletes its file on the next sync. Git history keeps
the old version.

## Develop

```sh
npm install
npm test            # merge + sync engine tests (in-memory GitHub, fake IndexedDB)
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
src/ui/             Journal (month bar + editor), History, Settings, sign-in, repo picker
```
