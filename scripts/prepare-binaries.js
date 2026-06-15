const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function main() {
  const platform = process.env.npm_config_platform || os.platform();
  const arch = process.env.npm_config_arch || os.arch();
  const candidates = [
    {
      name: 'ffmpeg',
      path: require('ffmpeg-static')
    },
    {
      name: 'ffprobe',
      path: path.join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', platform, arch, platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    }
  ];

  for (const candidate of candidates) {
    if (!candidate.path) {
      console.warn(`Skipping ${candidate.name}: no binary path resolved.`);
      continue;
    }

    try {
      await fs.access(candidate.path);
      if (platform !== 'win32') {
        await fs.chmod(candidate.path, 0o755);
      }
      console.log(`Prepared ${candidate.name} binary: ${path.relative(process.cwd(), candidate.path)}`);
    } catch (error) {
      console.warn(`Skipping ${candidate.name}: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
