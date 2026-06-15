import { upload } from '@vercel/blob/client';

const statusChecks = document.getElementById('statusChecks');
const refreshStatusButton = document.getElementById('refreshStatusButton');
const refreshAssetsButton = document.getElementById('refreshAssetsButton');
const mergeForm = document.getElementById('mergeForm');
const mergeButton = document.getElementById('mergeButton');
const sourceVideo = document.getElementById('sourceVideo');
const fileName = document.getElementById('fileName');
const progressMessage = document.getElementById('progressMessage');
const errorBox = document.getElementById('errorBox');
const successBox = document.getElementById('successBox');
const introSelect = document.getElementById('introSelect');
const outroSelect = document.getElementById('outroSelect');

const ACCESS_TOKEN_KEY = 'tickerTactixAccessToken';
const LARGE_UPLOAD_THRESHOLD = 100 * 1024 * 1024;

let latestStatus = null;
let latestAssets = { intro: [], outro: [] };
let selectedFile = null;
let isMerging = false;
let pollTimer = null;
let accessToken = window.localStorage.getItem(ACCESS_TOKEN_KEY) || '';

refreshStatusButton.addEventListener('click', refreshStatus);
refreshAssetsButton.addEventListener('click', () => refreshAssets(true));
introSelect.addEventListener('change', renderMergeButton);
outroSelect.addEventListener('change', renderMergeButton);

sourceVideo.addEventListener('change', () => {
  selectedFile = sourceVideo.files && sourceVideo.files[0] ? sourceVideo.files[0] : null;
  fileName.textContent = selectedFile ? selectedFile.name : 'No file selected';
  clearMessages();

  if (!selectedFile) {
    showError('No video was selected.');
  }

  renderMergeButton();
});

mergeForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!selectedFile) {
    showError('Choose a source video before merging.');
    return;
  }

  if (!introSelect.value || !outroSelect.value) {
    showError('Choose both an intro and an outro before merging.');
    return;
  }

  if (!canMerge()) {
    showError('One or more readiness checks are missing. Fix the missing items, then try again.');
    return;
  }

  clearMessages();
  isMerging = true;
  renderMergeButton();
  setProgress('Preparing upload...');
  startPolling();

  try {
    await ensureAccessTokenIfNeeded();

    const sourceBlob = await uploadSourceVideo(selectedFile);
    setProgress('Processing video...');

    const result = await fetchJson('/api/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceBlob,
        introFileId: introSelect.value,
        outroFileId: outroSelect.value
      })
    });

    setProgress('Done.');
    showSuccess(result);
    await refreshStatus();
  } catch (error) {
    showError(error.message || 'The merge failed.');
  } finally {
    isMerging = false;
    stopPolling();
    renderMergeButton();
  }
});

async function uploadSourceVideo(file) {
  const pathname = `sources/${Date.now()}-${sanitizePathSegment(file.name || 'source-video.mp4')}`;
  return upload(pathname, file, {
    access: 'private',
    handleUploadUrl: '/api/blob/upload',
    contentType: file.type || 'application/octet-stream',
    multipart: file.size > LARGE_UPLOAD_THRESHOLD,
    clientPayload: JSON.stringify({
      name: file.name,
      size: file.size,
      type: file.type
    }),
    headers: authHeaders(),
    onUploadProgress: (event) => {
      const percentage = Number.isFinite(event.percentage) ? Math.round(event.percentage) : 0;
      setProgress(`Uploading source video... ${percentage}%`);
    }
  });
}

async function refreshStatus() {
  try {
    latestStatus = await fetchJson('/api/status');
    renderStatus();
    renderMergeButton();

    if (latestStatus.activeJob) {
      setProgress(latestStatus.activeJob.message || 'Processing video...');
    } else if (!isMerging) {
      setProgress(defaultProgressMessage());
    }
  } catch (error) {
    statusChecks.innerHTML = '';
    showError(error.message || 'The app server is not responding. Restart the app and try again.');
  }
}

async function refreshAssets(force = false) {
  try {
    latestAssets = await fetchJson(force ? '/api/assets?refresh=1' : '/api/assets');
    renderAssetSelect(introSelect, latestAssets.intro, 'intro');
    renderAssetSelect(outroSelect, latestAssets.outro, 'outro');
    renderMergeButton();
  } catch (error) {
    renderAssetSelect(introSelect, [], 'intro');
    renderAssetSelect(outroSelect, [], 'outro');
    showError(error.message || 'The app could not load intro and outro videos.');
  }
}

function renderStatus() {
  const checks = [
    {
      label: 'Intro/outro assets',
      ok: latestStatus.assets && latestStatus.assets.available && latestStatus.assets.introCount > 0 && latestStatus.assets.outroCount > 0,
      detail: latestStatus.assets && latestStatus.assets.available
        ? `${latestStatus.assets.introCount} intro, ${latestStatus.assets.outroCount} outro`
        : latestStatus.assets && latestStatus.assets.message ? latestStatus.assets.message : 'Missing local assets'
    },
    {
      label: 'Blob storage',
      ok: latestStatus.blob && latestStatus.blob.configured,
      detail: latestStatus.blob && latestStatus.blob.configured ? 'Ready for source uploads and outputs' : 'Missing BLOB_READ_WRITE_TOKEN'
    },
    {
      label: 'FFmpeg',
      ok: latestStatus.ffmpeg.available,
      detail: latestStatus.ffmpeg.available ? `Available (${latestStatus.ffmpeg.source})` : 'Missing FFmpeg'
    },
    {
      label: 'FFprobe',
      ok: latestStatus.ffprobe.available,
      detail: latestStatus.ffprobe.available ? `Available (${latestStatus.ffprobe.source})` : 'Missing FFprobe'
    },
    {
      label: 'Temporary folders',
      ok: foldersWritable(latestStatus),
      detail: foldersWritable(latestStatus) ? 'Ready for temporary processing files' : 'One or more temp folders are not writable'
    },
    {
      label: 'Processing',
      ok: !latestStatus.activeJob,
      warn: Boolean(latestStatus.activeJob),
      detail: latestStatus.activeJob ? latestStatus.activeJob.message : 'Ready for a new merge'
    }
  ];

  statusChecks.innerHTML = checks.map(renderCheck).join('');
}

function renderAssetSelect(select, assets, kind) {
  const currentValue = select.value;
  if (!assets.length) {
    select.innerHTML = `<option value="">No ${kind} videos found</option>`;
    return;
  }

  select.innerHTML = [
    `<option value="">Choose ${kind} video</option>`,
    ...assets.map((asset) => (
      `<option value="${escapeAttribute(asset.id)}">${escapeHtml(asset.name)}${asset.size ? ` (${formatBytes(asset.size)})` : ''}</option>`
    ))
  ].join('');

  if (assets.some((asset) => asset.id === currentValue)) {
    select.value = currentValue;
  }
}

function renderCheck(check) {
  const statusClass = check.ok ? 'good' : check.warn ? 'warn' : 'bad';
  const mark = check.ok ? '✓' : check.warn ? '...' : '!';
  return `
    <div class="check ${statusClass}">
      <span class="check-mark" aria-hidden="true">${mark}</span>
      <span>
        <span class="check-title">${escapeHtml(check.label)}</span>
        <span class="check-detail">${escapeHtml(check.detail)}</span>
      </span>
    </div>
  `;
}

function foldersWritable(status) {
  return Boolean(
    status &&
    status.writable &&
    status.writable.working &&
    status.writable.logs
  );
}

function canMerge() {
  return Boolean(
    latestStatus &&
    latestStatus.assets &&
    latestStatus.assets.available &&
    latestStatus.assets.introCount > 0 &&
    latestStatus.assets.outroCount > 0 &&
    latestStatus.blob &&
    latestStatus.blob.configured &&
    latestStatus.ffmpeg.available &&
    latestStatus.ffprobe.available &&
    foldersWritable(latestStatus) &&
    !latestStatus.activeJob &&
    selectedFile &&
    introSelect.value &&
    outroSelect.value &&
    !isMerging
  );
}

function renderMergeButton() {
  mergeButton.disabled = !canMerge();
  mergeButton.textContent = isMerging ? 'Merging...' : 'Merge Video';
}

function setProgress(message) {
  progressMessage.textContent = message;
}

function defaultProgressMessage() {
  if (!latestStatus) {
    return 'Checking app status...';
  }
  if (!latestStatus.assets || !latestStatus.assets.available || latestStatus.assets.introCount === 0 || latestStatus.assets.outroCount === 0) {
    return 'Add intro and outro videos to assets/intro and assets/outro.';
  }
  if (!latestStatus.blob || !latestStatus.blob.configured) {
    return 'Configure BLOB_READ_WRITE_TOKEN before merging.';
  }
  if (!latestStatus.ffmpeg.available || !latestStatus.ffprobe.available) {
    return 'Install dependencies so FFmpeg and FFprobe are available.';
  }
  if (!foldersWritable(latestStatus)) {
    return 'Fix temporary folder permissions before merging.';
  }
  if (!introSelect.value || !outroSelect.value) {
    return 'Ready. Choose an intro and outro.';
  }
  if (!selectedFile) {
    return 'Ready. Choose a source video to begin.';
  }
  return 'Ready to merge.';
}

function clearMessages() {
  errorBox.classList.add('hidden');
  errorBox.textContent = '';
  successBox.classList.add('hidden');
  successBox.innerHTML = '';
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
  successBox.classList.add('hidden');
}

function showSuccess(data) {
  const filename = data.filename || 'completed video';
  successBox.innerHTML = `
    <strong>Merge complete</strong>
    <span>File: ${escapeHtml(filename)}</span>
    <div class="success-actions">
      <button class="primary" type="button" id="downloadOutputButton">Download Completed File</button>
    </div>
  `;
  successBox.classList.remove('hidden');
  errorBox.classList.add('hidden');

  document.getElementById('downloadOutputButton').addEventListener('click', async () => {
    await downloadOutput(data.downloadUrl, filename);
  });
}

async function downloadOutput(url, filename) {
  try {
    const response = await fetchWithAuth(url);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || 'The completed video could not be downloaded.');
    }

    const fileBlob = await response.blob();
    const objectUrl = URL.createObjectURL(fileBlob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename || 'merged-video.mp4';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    showError(error.message || 'The completed video could not be downloaded.');
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithAuth(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || 'The request failed.');
  }
  return data;
}

async function fetchWithAuth(url, options = {}, retry = true) {
  const headers = {
    ...(options.headers || {}),
    ...authHeaders()
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (response.status === 401 && retry) {
    const token = window.prompt('Enter the app access token.');
    if (token) {
      accessToken = token.trim();
      window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
      return fetchWithAuth(url, options, false);
    }
  }

  return response;
}

async function ensureAccessTokenIfNeeded() {
  if (!latestStatus || !latestStatus.authRequired || accessToken) {
    return;
  }

  const token = window.prompt('Enter the app access token.');
  if (!token) {
    throw new Error('Access token required.');
  }
  accessToken = token.trim();
  window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
}

function authHeaders() {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(refreshStatus, 1200);
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function sanitizePathSegment(value) {
  const parsedName = String(value || 'source-video.mp4').split(/[\\/]/).pop() || 'source-video.mp4';
  return parsedName
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 120) || 'source-video.mp4';
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  return `${amount.toFixed(amount >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

Promise.all([
  refreshStatus(),
  refreshAssets()
]).catch((error) => {
  showError(error.message || 'The app could not initialize.');
});
