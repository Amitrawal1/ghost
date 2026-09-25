// Runs electron-builder with the given arguments (npm run pack / dist / dist:win).
//
// Electron is in "dependencies" so `npm install -g ghost-assistant` gets it, but electron-builder
// refuses to build unless it is in "devDependencies". So this moves it there for the build only,
// then always puts package.json back exactly as it was.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'package.json');
const original = fs.readFileSync(file, 'utf8');
const restore = () => fs.writeFileSync(file, original);

const pkg = JSON.parse(original);
if (pkg.dependencies?.electron) {
  pkg.devDependencies = { ...pkg.devDependencies, electron: pkg.dependencies.electron };
  delete pkg.dependencies.electron;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

let status = 1;
try {
  const cli = require.resolve('electron-builder/cli.js');
  status = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' }).status;
} finally {
  restore();
}
process.exit(status ?? 1);
