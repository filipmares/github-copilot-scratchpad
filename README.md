# GitHub Copilot Scratchpad

A private, personal Markdown scratchpad for the GitHub Copilot app. It follows
you across projects and sessions while keeping its contents local.

## Features

- One persistent Markdown document
- Edit and preview modes
- Automatic saving
- System light and dark theme support
- Safe Markdown preview without remote dependencies
- Agent actions to read, replace, or append to the note
- Send a selection or the full note to the current chat

## Install

Ask GitHub Copilot to install this extension:

> Install the canvas extension from
> https://github.com/filipmares/github-copilot-scratchpad/tree/main

The app installs it as a user-scoped extension, making it available across all
projects. Reload extensions or restart the app if it does not appear
immediately, then ask Copilot to open your scratchpad.

For a manual installation:

```sh
git clone https://github.com/filipmares/github-copilot-scratchpad.git \
  ~/.copilot/extensions/scratchpad
```

The repository root is the extension folder. `extension.mjs` is the entry
point, and `copilot-extension.json` is the installation manifest. The GitHub
Copilot SDK is supplied by the app, so there are no packages to install or
build steps to run.

## Use

Type Markdown directly in the canvas and switch between **Edit** and
**Preview**. Changes save automatically.

You can also ask Copilot:

- "Open my scratchpad."
- "Append this to my scratchpad."
- "Read my scratchpad and use it as context."
- "Replace my scratchpad with this Markdown."

Inside the canvas:

- `Cmd/Ctrl+S` saves immediately.
- `Cmd/Ctrl+E` opens edit mode.
- `Cmd/Ctrl+P` opens preview mode.

## Privacy and storage

The note is stored locally at:

```text
~/.copilot/extensions/scratchpad/artifacts/scratchpad.md
```

The `artifacts/` directory is ignored by Git and is never part of the
extension package. The canvas binds its renderer to the loopback interface
only and loads no remote scripts, styles, fonts, or services.

## Files

```text
extension.mjs          Canvas registration and local HTTP renderer
storage.mjs            Durable, atomic Markdown storage
app.js                 Editor, preview, autosave, and Markdown rendering
app.css                Theme-aware canvas styling
copilot-extension.json Installation manifest
```

## License

[MIT](LICENSE)
