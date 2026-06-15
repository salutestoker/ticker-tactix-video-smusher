const { loadLocalAssets } = require('../lib/local-assets');

async function main() {
  const assets = await loadLocalAssets();
  console.log(`Intro videos: ${assets.intro.length}`);
  for (const asset of assets.intro) {
    console.log(`- ${asset.name}`);
  }

  console.log(`Outro videos: ${assets.outro.length}`);
  for (const asset of assets.outro) {
    console.log(`- ${asset.name}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
