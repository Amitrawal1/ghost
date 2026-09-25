#!/usr/bin/env node
// The `ghost` command.
//   ghost           start the overlay (runs setup first if there is no API key yet)
//   ghost setup     change the API key, profile or resume
//   ghost update    get the latest version
//   ghost help      show this list
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runSetup, loadSettings } = require('./setup');
const pkg = require('../package.json');

const APP_DIR = path.join(__dirname, '..');
const IS_MAC = process.platform === 'darwin';
const KEYS = IS_MAC ? '⌘⇧' : 'Ctrl+Shift+';

function electronBinary() {
  try {
    return require('electron'); // from plain Node, the electron package exports the binary's path
  } catch {
    return null;
  }
}

async function start() {
  if (!loadSettings().apiKey) {
    console.log("Ghost isn't set up yet. Let's do that first.");
    if (!(await runSetup())) return 1;
  }
  const electron = electronBinary();
  if (!electron || !fs.existsSync(electron)) {
    console.error(`Electron is missing. Run "npm install" in ${APP_DIR}, or run "ghost update".`);
    return 1;
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Detached, so closing this terminal doesn't close Ghost.
  spawn(electron, [APP_DIR], { detached: true, stdio: 'ignore', env }).unref();
  console.log(`👻 Ghost is running (hidden from screen shares).`);
  console.log(`   ${KEYS}Space show/hide · ${KEYS}L live listen · ${KEYS}Q quit`);
  if (IS_MAC) {
    console.log('   First time? Allow your terminal app in System Settings → Privacy & Security →');
    console.log('   "Screen & System Audio Recording", then quit the terminal, reopen it and run ghost again.');
  }
  return 0;
}

function sh(cmd, args) {
  // shell: true lets Windows find npm.cmd / git.exe the same way a terminal does.
  return spawnSync(cmd, args, { cwd: APP_DIR, stdio: 'inherit', shell: process.platform === 'win32' }).status;
}

function update() {
  if (fs.existsSync(path.join(APP_DIR, '.git'))) {
    // Installed with git clone: pull and refresh packages.
    if (sh('git', ['pull', '--ff-only']) !== 0) return 1;
    return sh('npm', ['install', '--no-audit', '--no-fund']);
  }
  // Installed with the one-line installer: run it again. It keeps settings and skips setup.
  const repo = String(pkg.repository?.url || '').match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
  if (!repo) {
    console.error('No GitHub repository in package.json, so there is nothing to update from.');
    return 1;
  }
  const raw = `https://raw.githubusercontent.com/${repo}/main`;
  if (process.platform === 'win32') {
    return spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${raw}/install.ps1 | iex`],
      { stdio: 'inherit' }
    ).status;
  }
  return spawnSync('bash', ['-c', `curl -fsSL ${raw}/install.sh | bash`], { stdio: 'inherit' }).status;
}

function help() {
  console.log(`Ghost Assistant ${pkg.version}

  ghost           start Ghost
  ghost setup     change your API key, profile or resume
  ghost update    get the latest version
  ghost help      show this list

Hotkeys: ${KEYS}Space show/hide · ${KEYS}L live listen · ${KEYS}R record
         ${KEYS}Enter read screen · ${KEYS}M answer mode · ${KEYS}Q quit`);
  return 0;
}

async function main() {
  const [cmd = 'start', ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'start':
      return start();
    case 'setup':
      return (await runSetup({ ifNeeded: rest.includes('--if-needed') })) ? 0 : 1;
    case 'update':
      return update();
    case 'version':
    case '--version':
    case '-v':
      console.log(pkg.version);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      console.error(`Unknown command "${cmd}".\n`);
      help();
      return 1;
  }
}

main().then((code) => process.exit(code ?? 0));
