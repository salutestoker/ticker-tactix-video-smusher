const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function main() {
  const packageRoot = path.join(process.cwd(), 'node_modules', 'ffprobe-static');
  const binRoot = path.join(packageRoot, 'bin');
  const platform = process.env.npm_config_platform || os.platform();
  const arch = process.env.npm_config_arch || os.arch();
  const keepDir = path.join(binRoot, platform, arch);

  try {
    await fs.access(keepDir);
  } catch (_error) {
    console.warn(`Skipping ffprobe pruning because ${path.relative(process.cwd(), keepDir)} was not found.`);
    return;
  }

  const platforms = await fs.readdir(binRoot, { withFileTypes: true });
  await Promise.all(platforms.map(async (platformEntry) => {
    if (!platformEntry.isDirectory()) return;
    const platformDir = path.join(binRoot, platformEntry.name);
    const arches = await fs.readdir(platformDir, { withFileTypes: true });

    await Promise.all(arches.map(async (archEntry) => {
      if (!archEntry.isDirectory()) return;
      const candidate = path.join(platformDir, archEntry.name);
      if (candidate === keepDir) return;
      await fs.rm(candidate, { recursive: true, force: true });
    }));

    const remaining = await fs.readdir(platformDir);
    if (remaining.length === 0) {
      await fs.rm(platformDir, { recursive: true, force: true });
    }
  }));

  console.log(`Kept ffprobe binary for ${platform}/${arch}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
