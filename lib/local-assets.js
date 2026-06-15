const fs = require('fs/promises');
const path = require('path');

const ASSET_ROOT = path.join(__dirname, '..', 'assets');
const ASSET_DIRS = {
  intro: path.join(ASSET_ROOT, 'intro'),
  outro: path.join(ASSET_ROOT, 'outro')
};
const ALLOWED_ASSET_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.avi',
  '.mkv',
  '.webm'
]);

async function loadLocalAssets() {
  const [intro, outro] = await Promise.all([
    listAssetFolder('intro'),
    listAssetFolder('outro')
  ]);

  return {
    intro,
    outro,
    folders: ASSET_DIRS,
    checkedAt: new Date().toISOString()
  };
}

async function listAssetFolder(kind) {
  const dir = ASSET_DIRS[kind];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  const assets = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .filter((entry) => ALLOWED_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath);
      return {
        id: entry.name,
        name: entry.name,
        filename: entry.name,
        path: filePath,
        size: stat.size,
        modifiedTime: stat.mtime.toISOString()
      };
    }));

  return assets.sort((a, b) => a.name.localeCompare(b.name));
}

function findAssetById(assets, kind, id) {
  const group = assets && Array.isArray(assets[kind]) ? assets[kind] : [];
  return group.find((asset) => asset.id === id) || null;
}

module.exports = {
  ASSET_DIRS,
  loadLocalAssets,
  findAssetById
};
