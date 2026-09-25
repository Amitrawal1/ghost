# 👻 Ghost Assistant

A free, open-source AI helper for interviews and meetings. It floats on top of your screen,
listens to the other people on the call, and shows a short answer you can say out loud.
It is left out of screen shares and screenshots, so only you see it.

- **Free.** Uses your own free [Groq](https://console.groq.com/keys) API key. No account with us, no subscription.
- **Private.** Your key, profile and resume stay on your computer. Nothing goes anywhere except the AI provider you choose.
- **macOS and Windows.**
- **Hands-free.** It starts listening by itself and answers questions automatically.
- Reads your screen for coding questions, and knows your resume so it answers *as you*.

## Install (one command)

**macOS** — open Terminal and paste:
```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/ghost-assistant/main/install.sh | bash
```

**Windows 10/11** — open PowerShell and paste:
```powershell
irm https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/ghost-assistant/main/install.ps1 | iex
```

The installer:
1. installs everything Ghost needs (Node.js and Electron) into a `.ghost` folder in your home folder, with no admin password,
2. adds the `ghost` command,
3. asks for your **Groq API key** (it checks that the key works),
4. asks a few questions about you: name, the job role, experience, top skills,
5. asks for your **resume**. Drag the PDF or Word file into the terminal window and press Enter.

It takes about two minutes.

## Use it

```
ghost           start Ghost
ghost setup     change your API key, profile or resume
ghost update    get the latest version
ghost help      list the commands
```

After `ghost`, the overlay appears in the top-right corner and starts listening after a second.
When someone asks a question, the answer shows up by itself.

### Hotkeys
On macOS the keys are ⌘⇧ (Command+Shift). On Windows they are Ctrl+Shift.

| Keys | Action |
|---|---|
| ⌘⇧Space | Show / hide |
| ⌘⇧L | Live listen on/off (answers questions automatically) |
| ⌘⇧R | Answer what was just said, right now |
| ⌘⇧Enter | Read the screen and answer (coding problems, questions) |
| ⌘⇧I | Type a question |
| ⌘⇧M | Answer mode: Interview / Coding / General |
| ⌘⇧K | Clear |
| ⌘⇧T | Click-through (clicks pass through the window) |
| ⌘⇧O / ⌘⇧P | Less / more opacity |
| ⌘⇧Arrows | Move the window |
| ⌘⇧Q | Quit |

## First run on macOS: permissions
macOS gives screen and audio permission to the app that **starts** Ghost. If you start it from Terminal, that app is Terminal.

1. Run `ghost`. macOS asks to allow **Screen & System Audio Recording** for Terminal. Allow it.
   If nothing asks, open System Settings → Privacy & Security → Screen & System Audio Recording and turn on Terminal.
2. **Quit Terminal completely** (⌘Q), open it again and run `ghost`.

If Ghost shows "Listening" but never answers, this permission is almost always the reason.
If you use VS Code's terminal, VS Code needs the permission, and VS Code must be in /Applications. If it runs from Downloads, macOS forgets the permission every time.

On Windows no permission is needed. Hiding from screen shares needs Windows 10 version 2004 or newer.

## Good to know
- Ghost hears **all** sound your computer plays (the call, and also videos), but not your microphone, so it never answers your own voice.
- Always test in the app you share from (Zoom, Meet, Teams) before a real call. Whether a window stays hidden depends on how that app captures the screen.
- Groq's free tier allows about 7,000 input tokens per minute. Screen questions use the most. If you hit the limit, Ghost waits and retries by itself.
- Your settings file: `~/Library/Application Support/ghost-assistant/settings.json` (macOS) or `%APPDATA%\ghost-assistant\settings.json` (Windows). The log file `ghost.log` is in the same folder.
- Audio clips, screenshots and your resume text are sent to the AI provider (Groq by default) to make answers. Read their privacy policy if that matters to you.

### Fully offline (optional)
Install [Ollama](https://ollama.com), then in Ghost's ⚙ Settings set the base URL to `http://localhost:11434/v1`, the key to `ollama`, and pick local models. Speech-to-text still needs a cloud key.

## Install by hand (for developers)
You need [Node.js 20+](https://nodejs.org) and git.
```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/ghost-assistant.git
cd ghost-assistant
npm install
npm start          # or: npm link, then type ghost anywhere
```
Without the wizard, click ⚙ in the overlay, paste your key, click **📄 Load resume**, and click Save.
You can also run the wizard with `npm run setup`.

### Build a desktop app
```bash
npm run dist       # macOS: dist/*.dmg (Apple Silicon)
npm run dist:win   # Windows: dist/*.exe installer
```
These builds are not code-signed. macOS may say the app is "damaged": run `xattr -cr "/Applications/Ghost Assistant.app"`.
Windows SmartScreen shows "Windows protected your PC": click More info → Run anyway.

## Uninstall
- **macOS:** `rm -rf ~/.ghost ~/Library/Application\ Support/ghost-assistant`, then delete the `# Ghost Assistant` lines from `~/.zshrc`.
- **Windows:** delete `%USERPROFILE%\.ghost` and `%APPDATA%\ghost-assistant`, and remove `.ghost\bin` from your user PATH (Settings → System → About → Advanced system settings → Environment Variables).

## Project layout
| File | What it does |
|---|---|
| `src/main.js` | Window, hotkeys, settings, AI calls |
| `src/audio-main.js`, `src/audio-renderer.js` | System-audio capture, voice detection, live mode |
| `src/renderer.js`, `src/index.html`, `src/styles.css` | The overlay UI |
| `src/prompts.js` | How answers are worded for each mode |
| `src/stealth.js` | Click-through, opacity, capture self-test |
| `src/resume.js` | Reads PDF / Word resumes |
| `bin/ghost.js`, `bin/setup.js` | The `ghost` command and the setup wizard |
| `install.sh`, `install.ps1` | One-line installers |

Plain JavaScript and Electron, no framework, no bundler. Pull requests are welcome.

## License
[MIT](LICENSE)
