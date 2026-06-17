const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const pathPosix = require('path/posix');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { del, get, list, put } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');
const {
  findAssetById,
  loadLocalAssets
} = require('./local-assets');

const PROJECT_ROOT = path.join(__dirname, '..');
loadLocalEnv(PROJECT_ROOT);

const app = express();
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const IS_VERCEL = process.env.VERCEL === '1';
const RUNTIME_ROOT = IS_VERCEL ? os.tmpdir() : PROJECT_ROOT;
const VERCEL_TMP_LIMIT_MB = 500;
const VERCEL_SAFE_SOURCE_UPLOAD_MB = 100;

const DIRS = {
  working: path.join(RUNTIME_ROOT, 'working'),
  logs: path.join(RUNTIME_ROOT, 'logs')
};

const requestedMaxSourceUploadMb = Number(
  process.env.MAX_SOURCE_UPLOAD_MB ||
  process.env.MAX_UPLOAD_MB ||
  (IS_VERCEL ? VERCEL_SAFE_SOURCE_UPLOAD_MB : 150)
);
const MAX_SOURCE_UPLOAD_MB = IS_VERCEL
  ? Math.min(requestedMaxSourceUploadMb, VERCEL_SAFE_SOURCE_UPLOAD_MB)
  : requestedMaxSourceUploadMb;
const MAX_SOURCE_UPLOAD_BYTES = MAX_SOURCE_UPLOAD_MB * 1024 * 1024;
const DEFAULT_PORT = Number(process.env.PORT || 3217);
const HOST = process.env.HOST || '127.0.0.1';
const TOOL_CACHE_MS = 30000;
const SOURCE_PREFIX = 'sources/';
const OUTPUT_PREFIX = 'outputs/';
const ALLOWED_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.avi',
  '.mkv',
  '.webm'
]);
const ALLOWED_UPLOAD_CONTENT_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
  'application/octet-stream'
];
const BLOB_STATUS_CACHE_MS = 60000;

let activeJob = null;
let blobStatusCache = null;
const toolCache = new Map();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/api', requireAppAccess);

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/api/status', async (_req, res) => {
  const [assets, writable] = await Promise.all([
    getAssetStatus(),
    getWritableStatus()
  ]);

  const ffmpeg = resolveTool('ffmpeg');
  const ffprobe = resolveTool('ffprobe');

  const blobStatus = await getBlobStatus();

  res.json({
    mode: IS_VERCEL ? 'vercel' : 'local',
    maxSourceUploadMb: MAX_SOURCE_UPLOAD_MB,
    requestedMaxSourceUploadMb,
    tempStorageLimitMb: IS_VERCEL ? VERCEL_TMP_LIMIT_MB : null,
    assets,
    blob: blobStatus,
    ffmpeg: {
      available: ffmpeg.available,
      path: ffmpeg.displayPath,
      source: ffmpeg.source,
      reason: ffmpeg.reason
    },
    ffprobe: {
      available: ffprobe.available,
      path: ffprobe.displayPath,
      source: ffprobe.source,
      reason: ffprobe.reason
    },
    writable,
    activeJob: activeJob ? publicJob(activeJob) : null,
    authRequired: Boolean(process.env.APP_ACCESS_TOKEN)
  });
});

app.get('/api/assets', async (req, res) => {
  try {
    const assets = await loadLocalAssets({ refresh: req.query.refresh === '1' });
    res.json({
      intro: assets.intro.map(publicAsset),
      outro: assets.outro.map(publicAsset),
      checkedAt: assets.checkedAt
    });
  } catch (error) {
    res.status(500).json({
      message: 'The app could not list local intro/outro videos.',
      detail: error.message
    });
  }
});

app.post('/api/blob/upload', async (req, res) => {
  try {
    const uploadSize = sizeFromUploadRequest(req.body);
    if (uploadSize && uploadSize > MAX_SOURCE_UPLOAD_BYTES) {
      throw publicError(fileTooLargeMessage(), 400);
    }

    const blobStatus = await getBlobStatus();
    if (!blobStatus.available) {
      throw publicError(blobStatus.message || 'Vercel Blob is not configured. Set BLOB_READ_WRITE_TOKEN in Vercel.', 500);
    }

    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const normalizedPathname = normalizeSourcePathname(pathname);
        const payload = parseClientPayload(clientPayload);
        if (payload.size && payload.size > MAX_SOURCE_UPLOAD_BYTES) {
          throw publicError(fileTooLargeMessage(), 400);
        }

        return {
          allowedContentTypes: ALLOWED_UPLOAD_CONTENT_TYPES,
          maximumSizeInBytes: MAX_SOURCE_UPLOAD_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            kind: 'source',
            pathname: normalizedPathname
          })
        };
      }
    });

    res.json(jsonResponse);
  } catch (error) {
    res.status(error.statusCode || 400).json({
      message: error.publicMessage || error.message || 'The upload could not be prepared.'
    });
  }
});

app.post('/api/merge', async (req, res) => {
  if (activeJob) {
    res.status(409).json({
      message: 'Another video is already being processed. Please wait for it to finish before starting a new merge.'
    });
    return;
  }

  const job = createJob(req.body || {});
  activeJob = job;

  try {
    const result = await processMerge(job, req.body || {});
    res.json(result);
  } catch (error) {
    await appendLog(job.logFile, `\nERROR: ${error.stack || error.message}\n`);
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.publicMessage || friendlyErrorForStage(job.stage),
      detail: process.env.NODE_ENV === 'development' ? error.message : undefined,
      stage: job.stage
    });
  } finally {
    job.message = 'Cleaning up temporary files...';
    await cleanupJob(job);
    activeJob = null;
  }
});

app.get('/api/output', async (req, res) => {
  try {
    const pathname = safeOutputPathname(req.query.pathname);
    const blob = await get(pathname, {
      access: 'private',
      useCache: false
    });

    if (!blob || blob.statusCode !== 200 || !blob.stream) {
      res.status(404).json({ message: 'The completed file could not be found.' });
      return;
    }

    const filename = pathPosix.basename(pathname);
    res.setHeader('Content-Type', blob.blob.contentType || 'video/mp4');
    res.setHeader('Content-Length', String(blob.blob.size));
    res.setHeader('Content-Disposition', `attachment; filename="${safeHeaderFilename(filename)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    await pipeline(Readable.fromWeb(blob.stream), res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(error.statusCode || 400).json({
        message: error.publicMessage || 'The completed video could not be downloaded.'
      });
    } else {
      res.destroy(error);
    }
  }
});

async function processMerge(job, body) {
  const sourcePathname = sourcePathnameFromBody(body.sourceBlob);
  await assertReady(job, body.introFileId, body.outroFileId, sourcePathname);

  const assets = await loadLocalAssets();
  const introAsset = findAssetById(assets, 'intro', body.introFileId);
  const outroAsset = findAssetById(assets, 'outro', body.outroFileId);

  if (!introAsset || !outroAsset) {
    throw publicError('The selected intro or outro is no longer available in the assets folder. Refresh the page and try again.', 400);
  }

  job.stage = 'download-source';
  job.message = 'Downloading selected source video...';
  await appendLog(job.logFile, `Video Smusher job ${job.id}\nStarted: ${new Date().toISOString()}\nProject: ${PROJECT_ROOT}\n`);
  await appendLog(job.logFile, `Intro: ${introAsset.path}\nOutro: ${outroAsset.path}\nSource Blob: ${sourcePathname}\n`);

  const sourcePath = path.join(job.workingDir, `source${path.extname(pathPosix.basename(sourcePathname)) || '.mp4'}`);
  const mergedPath = path.join(job.workingDir, 'merged-output.mp4');
  job.tempFiles.push(sourcePath, mergedPath);

  await downloadBlobToFile(sourcePathname, sourcePath, job);

  job.outputFilename = outputFilenameForSource(sourcePathname);
  job.outputPathname = `${OUTPUT_PREFIX}${job.outputFilename}`;

  const introNormalized = path.join(job.workingDir, 'intro-normalized.mp4');
  const sourceNormalized = path.join(job.workingDir, 'source-normalized.mp4');
  const outroNormalized = path.join(job.workingDir, 'outro-normalized.mp4');
  job.tempFiles.push(introNormalized, sourceNormalized, outroNormalized);

  await normalizeVideo(job, introAsset.path, introNormalized, 'intro video');
  await normalizeVideo(job, sourcePath, sourceNormalized, 'selected video');
  await normalizeVideo(job, outroAsset.path, outroNormalized, 'outro video');

  job.stage = 'merge';
  job.message = 'Combining normalized intro, selected video, and outro...';
  const concatList = path.join(job.workingDir, 'concat-list.txt');
  await fsp.writeFile(concatList, [
    'ffconcat version 1.0',
    "file 'intro-normalized.mp4'",
    "file 'source-normalized.mp4'",
    "file 'outro-normalized.mp4'",
    ''
  ].join(os.EOL), 'utf8');
  job.tempFiles.push(concatList);

  const ffmpeg = requireToolPath('ffmpeg');
  await runTool(ffmpeg, [
    '-y',
    '-hide_banner',
    '-fflags', '+genpts',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    '-movflags', '+faststart',
    mergedPath
  ], job, 'The videos were normalized, but the final merge failed.');

  job.stage = 'upload-output';
  job.message = 'Saving merged video...';
  const outputBlob = await put(job.outputPathname, fs.createReadStream(mergedPath), {
    access: 'private',
    contentType: 'video/mp4',
    addRandomSuffix: false,
    cacheControlMaxAge: 60
  });

  await del(sourcePathname).catch((error) => {
    console.warn(`Could not delete temporary source blob ${sourcePathname}: ${error.message}`);
  });

  job.stage = 'done';
  job.message = 'Done.';
  await appendLog(job.logFile, `\nCompleted: ${new Date().toISOString()}\nOutput Blob: ${outputBlob.pathname}\n`);

  return {
    ok: true,
    filename: job.outputFilename,
    outputPathname: outputBlob.pathname,
    downloadUrl: `/api/output?pathname=${encodeURIComponent(outputBlob.pathname)}`
  };
}

async function assertReady(job, introFileId, outroFileId, sourcePathname) {
  job.stage = 'checking';
  job.message = 'Checking assets, Blob, FFmpeg, and temporary folders...';

  if (!sourcePathname) {
    throw publicError('No source upload was provided. Choose a source video and try again.', 400);
  }
  if (!introFileId) {
    throw publicError('Choose an intro video before merging.', 400);
  }
  if (!outroFileId) {
    throw publicError('Choose an outro video before merging.', 400);
  }
  const blobStatus = await getBlobStatus();
  if (!blobStatus.available) {
    throw publicError(blobStatus.message || 'Vercel Blob is not configured. Set BLOB_READ_WRITE_TOKEN in Vercel.', 500);
  }

  if (!resolveTool('ffmpeg').available) {
    throw publicError('FFmpeg is missing. Install dependencies again or install FFmpeg on this computer.', 500);
  }
  if (!resolveTool('ffprobe').available) {
    throw publicError('FFprobe is missing. Install dependencies again or install FFmpeg tools on this computer.', 500);
  }

  const writableChecks = await Promise.all([
    isWritable(DIRS.working),
    isWritable(DIRS.logs)
  ]);

  if (writableChecks.some((ok) => !ok)) {
    throw publicError('The app cannot write to temporary processing folders. Check runtime permissions and try again.', 500);
  }

  const assets = await loadLocalAssets();
  if (assets.intro.length === 0) {
    throw publicError('No intro videos were found in assets/intro.', 400);
  }
  if (assets.outro.length === 0) {
    throw publicError('No outro videos were found in assets/outro.', 400);
  }
  if (!findAssetById(assets, 'intro', introFileId) || !findAssetById(assets, 'outro', outroFileId)) {
    throw publicError('The selected intro or outro is not available in the assets folder. Refresh the page and try again.', 400);
  }
}

async function downloadBlobToFile(pathname, outputPath, job) {
  job.stage = 'download-source';
  job.message = 'Downloading selected source video...';
  await appendLog(job.logFile, `Downloading source from Blob: ${pathname}\n`);

  const blob = await get(pathname, {
    access: 'private',
    useCache: false
  });

  if (!blob || blob.statusCode !== 200 || !blob.stream) {
    throw publicError('The uploaded source video could not be found. Upload it again and retry.', 400);
  }

  if (blob.blob.size > MAX_SOURCE_UPLOAD_BYTES) {
    throw publicError(fileTooLargeMessage(), 400);
  }

  await pipeline(Readable.fromWeb(blob.stream), fs.createWriteStream(outputPath));
}

async function normalizeVideo(job, inputPath, outputPath, label) {
  job.stage = `normalize-${label}`;
  job.message = `Normalizing ${label}...`;

  const probe = await probeMedia(inputPath, job);
  if (!probe.hasVideo) {
    throw publicError(`The ${label} does not contain a usable video track.`, 400);
  }

  const ffmpeg = requireToolPath('ffmpeg');
  const videoFilter = [
    'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2',
    'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black',
    'setsar=1',
    'fps=30',
    'format=yuv420p'
  ].join(',');

  const args = ['-y', '-hide_banner', '-i', inputPath];
  if (!probe.hasAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }

  args.push(
    '-map', '0:v:0',
    '-map', probe.hasAudio ? '0:a:0' : '1:a:0',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-vf', videoFilter,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-bf', '0',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-shortest',
    '-video_track_timescale', '30000',
    '-movflags', '+faststart',
    outputPath
  );

  const failureMessage = probe.hasAudio
    ? `Failed while normalizing the ${label}. The file may be invalid or use an unsupported codec.`
    : `Failed while normalizing the ${label}. The app tried to add silent audio, but FFmpeg could not process the file.`;

  await runTool(ffmpeg, args, job, failureMessage);
}

async function probeMedia(filePath, job) {
  const ffprobe = requireToolPath('ffprobe');
  const output = await runTool(ffprobe, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type',
    '-of', 'json',
    filePath
  ], job, `The app could not read video details from ${path.basename(filePath)}.`);

  let parsed;
  try {
    parsed = JSON.parse(output.stdout || '{}');
  } catch (_error) {
    throw publicError(`The app could not understand video details from ${path.basename(filePath)}.`, 400);
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  return {
    hasVideo: streams.some((stream) => stream.codec_type === 'video'),
    hasAudio: streams.some((stream) => stream.codec_type === 'audio')
  };
}

function runTool(command, args, job, publicMessage) {
  return new Promise((resolve, reject) => {
    const started = new Date().toISOString();
    const commandLine = `${command} ${args.map(quoteArg).join(' ')}`;
    appendLog(job.logFile, `\n[${started}] ${commandLine}\n`).catch(() => {});

    const child = spawn(command, args, {
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      appendLog(job.logFile, text).catch(() => {});
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      appendLog(job.logFile, text).catch(() => {});
    });

    child.on('error', (error) => {
      const wrapped = publicError(publicMessage, 500);
      wrapped.message = error.message;
      reject(wrapped);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = publicError(publicMessage, 500);
      error.message = `${path.basename(command)} exited with code ${code}. ${stderr.slice(-1200)}`;
      reject(error);
    });
  });
}

async function getAssetStatus() {
  try {
    const assets = await loadLocalAssets();
    return {
      available: true,
      introCount: assets.intro.length,
      outroCount: assets.outro.length,
      checkedAt: assets.checkedAt,
      message: 'Ready'
    };
  } catch (error) {
    return {
      available: false,
      introCount: 0,
      outroCount: 0,
      message: error.message
    };
  }
}

async function getBlobStatus() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return {
      configured: false,
      available: false,
      message: 'Missing BLOB_READ_WRITE_TOKEN'
    };
  }

  const cacheKey = `${crypto.createHash('sha256').update(token).digest('hex')}:${process.env.VERCEL_BLOB_API_URL || ''}`;
  const now = Date.now();
  if (
    blobStatusCache &&
    blobStatusCache.key === cacheKey &&
    now - blobStatusCache.checkedAt < BLOB_STATUS_CACHE_MS
  ) {
    return blobStatusCache.value;
  }

  try {
    await list({
      limit: 1,
      prefix: '__video-smusher-healthcheck__/',
      abortSignal: createTimeoutSignal(5000)
    });

    const status = {
      configured: true,
      available: true,
      message: 'Ready for source uploads and outputs'
    };
    blobStatusCache = { key: cacheKey, checkedAt: now, value: status };
    return status;
  } catch (error) {
    const detail = error && error.message ? error.message : 'Unknown Blob token validation error';
    const status = {
      configured: true,
      available: false,
      message: friendlyBlobError(detail),
      detail: process.env.NODE_ENV === 'development' ? detail : undefined
    };
    blobStatusCache = { key: cacheKey, checkedAt: now, value: status };
    return status;
  }
}

async function getWritableStatus() {
  const [working, logs] = await Promise.all([
    isWritable(DIRS.working),
    isWritable(DIRS.logs)
  ]);

  return {
    working,
    logs
  };
}

function createTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

function createJob(body) {
  const id = `${timestampForFile()}-${randomSuffix()}`;
  const workingDir = path.join(DIRS.working, id);
  fs.mkdirSync(workingDir, { recursive: true });

  return {
    id,
    stage: 'queued',
    message: 'Starting merge...',
    startedAt: new Date().toISOString(),
    sourcePathname: body && sourcePathnameFromBody(body.sourceBlob, false),
    introFileId: body && body.introFileId,
    outroFileId: body && body.outroFileId,
    workingDir,
    logFile: path.join(DIRS.logs, `${id}.log`),
    tempFiles: [],
    outputFilename: null,
    outputPathname: null
  };
}

async function cleanupJob(job) {
  await fsp.rm(job.workingDir, { recursive: true, force: true }).catch(() => {});
}

function publicJob(job) {
  return {
    id: job.id,
    stage: job.stage,
    message: job.message,
    startedAt: job.startedAt,
    outputFilename: job.outputFilename
  };
}

function publicAsset(asset) {
  return {
    id: asset.id,
    name: asset.name,
    filename: asset.filename,
    size: asset.size,
    modifiedTime: asset.modifiedTime
  };
}

function resolveTool(toolName) {
  const cached = toolCache.get(toolName);
  if (cached && Date.now() - cached.checkedAt < TOOL_CACHE_MS) {
    return cached.value;
  }

  const attempts = [];
  const staticPath = staticToolPath(toolName);

  if (staticPath.path) {
    attempts.push({
      path: staticPath.path,
      displayPath: staticPath.path,
      source: 'bundled',
      requireError: staticPath.error
    });
  } else if (staticPath.error) {
    attempts.push({
      path: null,
      displayPath: 'bundled package',
      source: 'bundled',
      requireError: staticPath.error
    });
  }

  attempts.push({
    path: toolName,
    displayPath: `${toolName} on PATH`,
    source: 'system'
  });

  for (const attempt of attempts) {
    if (!attempt.path) {
      attempt.reason = attempt.requireError || 'No binary path resolved.';
      continue;
    }

    if (attempt.source === 'bundled' && !fs.existsSync(attempt.path)) {
      attempt.reason = 'Binary path was resolved, but the file was not bundled.';
      continue;
    }

    const run = canRun(attempt.path);
    if (run.ok) {
      return cacheTool(toolName, {
        available: true,
        path: attempt.path,
        displayPath: attempt.displayPath,
        source: attempt.source,
        reason: null
      });
    }

    attempt.reason = run.reason;
  }

  const reason = attempts
    .map((attempt) => `${attempt.source}: ${attempt.reason || 'not available'}`)
    .join('; ');

  return cacheTool(toolName, {
    available: false,
    path: null,
    displayPath: 'missing',
    source: 'missing',
    reason
  });
}

function cacheTool(toolName, value) {
  toolCache.set(toolName, {
    checkedAt: Date.now(),
    value
  });
  return value;
}

function requireToolPath(toolName) {
  const tool = resolveTool(toolName);
  if (!tool.available) {
    throw publicError(`${toolName} is missing. Install dependencies again or install ${toolName} on this computer.`, 500);
  }
  return tool.path;
}

function staticToolPath(toolName) {
  const platform = process.env.npm_config_platform || os.platform();
  const arch = process.env.npm_config_arch || os.arch();

  if (toolName === 'ffmpeg') {
    return {
      path: path.join(PROJECT_ROOT, 'node_modules', 'ffmpeg-static', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
      error: null
    };
  }

  return {
    path: path.join(PROJECT_ROOT, 'node_modules', 'ffprobe-static', 'bin', platform, arch, platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
    error: null
  };
}

function canRun(command) {
  try {
    const result = spawnSync(command, ['-version'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    });
    if (result.error) {
      return {
        ok: false,
        reason: result.error.message
      };
    }
    if (result.status === 0) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `${path.basename(command)} exited with code ${result.status}. ${(result.stderr || result.stdout || '').slice(0, 240).trim()}`
    };
  } catch (error) {
    return {
      ok: false,
      reason: error.message
    };
  }
}

function friendlyBlobError(message) {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('invalid `blob_read_write_token`') || lower.includes('invalid `token` parameter')) {
    return 'BLOB_READ_WRITE_TOKEN is invalid. Reconnect the Blob store or pull a fresh token from Vercel.';
  }
  if (lower.includes('access denied') || lower.includes('valid token')) {
    return 'BLOB_READ_WRITE_TOKEN was rejected by Vercel Blob. Reconnect the Blob store or pull a fresh token from Vercel.';
  }
  if (lower.includes('no blob credentials') || (lower.includes('missing') && lower.includes('token'))) {
    return 'Missing BLOB_READ_WRITE_TOKEN';
  }
  if (lower.includes('store') && (lower.includes('not found') || lower.includes('suspended'))) {
    return 'The configured Vercel Blob store is unavailable. Check the store connection in Vercel.';
  }
  if (lower.includes('aborted') || lower.includes('timeout')) {
    return 'Vercel Blob validation timed out. Check network access and try again.';
  }
  return `Vercel Blob is not ready: ${message}`;
}

function fileTooLargeMessage() {
  if (IS_VERCEL) {
    return `The selected file is too large for hosted processing. Vercel Functions have ${VERCEL_TMP_LIMIT_MB} MB of temporary storage, and this app needs room for the source, normalized clips, and final MP4. Use a file under ${MAX_SOURCE_UPLOAD_MB} MB or run the merge locally.`;
  }
  return `The selected file is too large. The current upload limit is ${MAX_SOURCE_UPLOAD_MB} MB.`;
}

function loadLocalEnv(projectRoot) {
  if (process.env.VERCEL === '1') {
    return;
  }

  const mode = process.env.NODE_ENV || 'development';
  const candidates = [
    `.env.${mode}.local`,
    '.env.local',
    `.env.${mode}`,
    '.env'
  ];
  const seen = new Set();

  for (const filename of candidates) {
    if (seen.has(filename)) continue;
    seen.add(filename);
    loadEnvFileIfPresent(path.join(projectRoot, filename));
  }
}

function loadEnvFileIfPresent(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(filePath);
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  let value = trimmed.slice(equalsIndex + 1).trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, '');
  }

  return [key, value];
}

function requireAppAccess(req, res, next) {
  const expected = process.env.APP_ACCESS_TOKEN;
  if (!expected) {
    next();
    return;
  }

  const authorization = req.get('authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const headerToken = req.get('x-app-token') || '';

  if (safeTokenEqual(bearer, expected) || safeTokenEqual(headerToken, expected)) {
    next();
    return;
  }

  res.status(401).json({
    message: 'Access token required.'
  });
}

function safeTokenEqual(candidate, expected) {
  if (!candidate || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function parseClientPayload(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch (_error) {
    return {};
  }
}

function sizeFromUploadRequest(body) {
  if (!body || body.type !== 'blob.generate-client-token' || !body.payload) {
    return 0;
  }
  const payload = parseClientPayload(body.payload.clientPayload);
  return Number(payload.size || 0);
}

function sourcePathnameFromBody(sourceBlob, shouldThrow = true) {
  const raw = typeof sourceBlob === 'string'
    ? sourceBlob
    : sourceBlob && (sourceBlob.pathname || sourceBlob.url);

  try {
    return normalizeSourcePathname(raw);
  } catch (error) {
    if (shouldThrow) throw error;
    return null;
  }
}

function normalizeSourcePathname(value) {
  if (!value) {
    throw publicError('No source upload was provided.', 400);
  }

  let pathname = String(value);
  if (pathname.startsWith('https://')) {
    const parsed = new URL(pathname);
    pathname = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  }

  if (!pathname.startsWith(SOURCE_PREFIX) || pathPosix.normalize(pathname) !== pathname || pathname.includes('..')) {
    throw publicError('Invalid source upload path.', 400);
  }

  const ext = normalizeExtension(pathPosix.extname(pathname));
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw publicError(`Unsupported file type. Please choose one of: ${Array.from(ALLOWED_EXTENSIONS).join(', ')}`, 400);
  }

  return pathname;
}

function safeOutputPathname(value) {
  if (!value) {
    throw publicError('Missing output pathname.', 400);
  }

  const pathname = String(value);
  if (
    !pathname.startsWith(OUTPUT_PREFIX) ||
    pathPosix.normalize(pathname) !== pathname ||
    pathPosix.dirname(pathname) !== OUTPUT_PREFIX.replace(/\/$/, '') ||
    !pathPosix.basename(pathname).endsWith('.mp4')
  ) {
    throw publicError('Invalid output pathname.', 400);
  }

  return pathname;
}

function outputFilenameForSource(sourcePathname) {
  const parsed = pathPosix.parse(sourcePathname || 'video');
  const base = sanitizeBaseName(parsed.name || 'video');
  return `${base}-merged-${timestampForFile()}-${randomSuffix()}.mp4`;
}

function sanitizeBaseName(value) {
  const sanitized = String(value || 'video')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
  return sanitized || 'video';
}

function normalizeExtension(ext) {
  return String(ext || '').toLowerCase();
}

function safeHeaderFilename(filename) {
  return String(filename || 'video.mp4').replace(/["\\\r\n]/g, '_');
}

function timestampForFile() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join('') + '-' + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

async function isWritable(dirPath) {
  const testFile = path.join(dirPath, `.write-test-${Date.now()}-${randomSuffix()}`);
  try {
    await fsp.mkdir(dirPath, { recursive: true });
    await fsp.writeFile(testFile, 'ok');
    await fsp.unlink(testFile);
    return true;
  } catch (_error) {
    return false;
  }
}

async function appendLog(logFile, text) {
  await fsp.mkdir(path.dirname(logFile), { recursive: true });
  await fsp.appendFile(logFile, text);
}

function publicError(message, statusCode) {
  const error = new Error(message);
  error.publicMessage = message;
  error.statusCode = statusCode;
  return error;
}

function friendlyErrorForStage(stage) {
  if (stage === 'checking') {
    return 'The app could not start because a required service, tool, or temporary folder is missing.';
  }
  if (stage && stage.startsWith('download')) {
    return 'The app could not download one of the selected videos.';
  }
  if (stage && stage.startsWith('normalize')) {
    return 'The app could not normalize one of the videos. Try a different source file or check the logs for details.';
  }
  if (stage === 'merge') {
    return 'The app could not merge the normalized videos.';
  }
  if (stage === 'upload-output') {
    return 'The app merged the videos, but could not save the completed file.';
  }
  return 'The app could not complete the merge.';
}

function quoteArg(arg) {
  const value = String(arg);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

async function ensureFolders() {
  await Promise.all(Object.values(DIRS).map((dir) => fsp.mkdir(dir, { recursive: true })));
}

function listenWithFallback(startPort, attemptsLeft = 20) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, remaining) => {
      const server = app.listen(port, HOST);

      server.once('listening', () => resolve(server));
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && remaining > 0) {
          tryPort(port + 1, remaining - 1);
          return;
        }
        reject(error);
      });
    };

    tryPort(startPort, attemptsLeft);
  });
}

async function start() {
  await ensureFolders();
  const server = await listenWithFallback(DEFAULT_PORT);
  const address = server.address();
  const url = `http://localhost:${address.port}`;

  console.log(`Video Smusher is running at ${url}`);
  console.log(`Project folder: ${PROJECT_ROOT}`);
  console.log('Close this terminal window or press Ctrl+C to stop the app.');

  if (process.env.AUTO_OPEN !== 'false') {
    openPath(url);
  }
}

function openPath(target) {
  if (process.platform === 'darwin') {
    spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }

  spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = {
  app,
  start
};
