# Ticker Tactix Video Smusher

Browser-based video merger for Vercel. The app lets a user upload one source video, choose an intro and outro from project assets, then download the finished MP4.

## Architecture

- The Express app lives in `lib/app.js`.
- `server.js` is only the local `npm start` runner.
- Vercel invokes thin wrappers in `api/`, and each wrapper delegates to the shared Express app.
- Static browser files live in `public/`.
- Source uploads go directly from the browser to private Vercel Blob.
- Completed merged MP4 files are saved to private Vercel Blob.
- Intro and outro choices are read from local project folders:
  - `assets/intro/`
  - `assets/outro/`

Only files directly inside those two folders are selectable. Supported intro/outro extensions are `.mp4`, `.mov`, `.m4v`, `.avi`, `.mkv`, and `.webm`.

## Vercel Setup

1. Connect this repository to Vercel and select the repository.
2. Create or connect a Vercel Blob store for the project.
3. Set these environment variables in Vercel:

```text
BLOB_READ_WRITE_TOKEN=...
MAX_SOURCE_UPLOAD_MB=150
APP_ACCESS_TOKEN=
```

`BLOB_READ_WRITE_TOKEN` is required. `MAX_SOURCE_UPLOAD_MB` is optional and defaults to `150`. `APP_ACCESS_TOKEN` is optional; when set, the UI prompts users for that token before API calls.

`APP_ACCESS_TOKEN` does not come from Vercel. If you want to gate access to the tool, create your own long random value and set it as `APP_ACCESS_TOKEN`. If you do not need that extra gate, leave it unset.

After adding or changing Vercel environment variables, redeploy the project. Existing deployments keep the environment they were built with and will not see newly-added variables.

The included `vercel.json` sets the framework preset to Other, runs `npm run build`, enables Fluid compute, gives each `api/**/*.js` function up to 300 seconds, and includes `assets/**` in the function bundle.

## Asset Setup

Put one or more intro videos in:

```text
assets/intro/
```

Put one or more outro videos in:

```text
assets/outro/
```

These files are private server-side assets, not public browser files. Commit the videos you want available in production. Keep them moderate in size because Vercel bundles them with the Express function, and Vercel Functions have bundle size limits.

## Local Development

```bash
npm install
npm run build
npm start
```

The app starts at a local URL like:

```text
http://localhost:3217
```

To use the full upload and merge flow locally, provide `BLOB_READ_WRITE_TOKEN` in your environment or pull it from Vercel:

```bash
vercel env pull
```

## Checks

List detected intro/outro assets:

```bash
npm run verify:assets
```

Build the browser bundle and prune unused FFprobe binaries:

```bash
npm run build
```

Run a Vercel production build locally when the Vercel CLI is available:

```bash
vercel build
```

## Output Format

Each input is normalized before merging, then the final output is stabilized as a constant 30fps MP4:

- MP4
- H.264 video
- AAC audio
- 1920x1080
- 30fps
- `yuv420p`
- 48kHz stereo audio
- Aspect ratio preserved with padding

Videos without audio get silent audio so the final merge is more reliable.

## Runtime Notes

- Vercel `/tmp` is used for temporary processing files in production.
- Local `working/` and `logs/` folders are used when running with `npm start`.
- Temporary source uploads are deleted from Blob after a successful merge.
- Completed outputs remain in private Vercel Blob until manually deleted.
- `ffmpeg-static` bundles FFmpeg for convenience and uses a GPL license. Review licensing before redistributing commercially.
