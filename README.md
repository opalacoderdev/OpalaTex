# OpalaTex

OpalaTex is a free, open-source LaTeX editor with an integrated AI assistant. It combines a source editor, local PDF preview, project tools, Git integration, and optional local or cloud AI models.

LaTeX compilation is performed locally with Tectonic. Local editor features do not require an Opala Cloud account; cloud credits and user-provided API keys are optional.

## Features

- Split source editor and PDF preview with SyncTeX support
- Local LaTeX compilation with Tectonic
- AI assistance for writing, tables, equations, TikZ, and compilation errors
- Local models through Ollama and configurable external providers
- Project, terminal, Git, and document-export tools
- English and Brazilian Portuguese interface

## Minimum Software Requirements

- Linux: Ubuntu 24.04 or 26.04
- Windows: Windows 10 or 11

## Install a packaged release

The installer downloads the current OpalaTex Community release from GitHub Releases, extracts it into the user profile, creates shortcuts, and does not require administrator privileges.

### Linux / macOS (Terminal One-Liner via `curl`)

Run terminal and execute:

```bash
curl -fsSL https://raw.githubusercontent.com/opalacoderdev/OpalaTex/master/install.sh | bash
```

To inspect the script first:

```bash
curl -fsSL https://raw.githubusercontent.com/opalacoderdev/OpalaTex/master/install.sh -o install.sh
less install.sh
bash install.sh
```

The application is installed under `~/.local/share/OpalaTex`, with a command symlink in `~/.local/bin/opalatex` and a desktop launcher in `~/.local/share/applications/opalatex.desktop`.

### Windows (PowerShell One-Liner via `irm`)

Open PowerShell and execute:

```powershell
irm https://raw.githubusercontent.com/opalacoderdev/OpalaTex/master/install.ps1 | iex
```

Alternatively, download and inspect `install.ps1` before running:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/opalacoderdev/OpalaTex/master/install.ps1 -OutFile install.ps1
Get-Content .\install.ps1
.\install.ps1
```

The application is installed under `%LOCALAPPDATA%\OpalaTex`. The installer adds its executable directory to the user `PATH` and creates shortcuts on the Desktop and Start menu.

## Development setup

Requirements: Python 3.10 or newer, Node.js/npm, and Git.

### PowerShell

```powershell
git clone https://github.com/opalacoderdev/OpalaTex.git
cd OpalaTex
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm install --prefix .\gui_src
npm run build --prefix .\gui_src
python .\main.py
```

If script execution is disabled for the current PowerShell process, run `Set-ExecutionPolicy -Scope Process Bypass` before activating the virtual environment.

### Bash (Linux/macOS)

```bash
git clone https://github.com/opalacoderdev/OpalaTex.git
cd OpalaTex
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm install --prefix ./gui_src
npm run build --prefix ./gui_src
python main.py
```

## Build and test

Run the test suite from the repository root:

```bash
python -m pytest
```

Rebuild only the web interface with:

```bash
npm run build --prefix gui_src
```

Create a packaged desktop build with the platform-specific script:

```powershell
.\build_exe.ps1
```

```bash
bash ./build_exe.sh
```

These scripts install build dependencies, build the React/Vite interface, download pinned Tectonic and Pandoc releases, and package the application with PyInstaller. Outputs are written under `dist/`.

## Release publishing

The `binpacking.ps1` and `binpacking.sh` scripts are maintainer tools. They package an existing build and upload it over SSH. They intentionally contain no server address, username, credential, or private server path. Maintainers must provide:

- `OPALATEX_RELEASE_HOST`
- `OPALATEX_RELEASE_USER`
- `OPALATEX_RELEASE_DIR`

Authentication is handled by the local SSH client (preferably with an SSH key or agent); credentials must never be committed to the repository.

## Security and credentials

- API keys configured in the application are local user data and must not be committed.
- Environment files, private keys, credentials, databases, logs, build outputs, and local runtime data are excluded by `.gitignore`.
- Report a suspected leaked credential privately to the maintainers. Revoke and rotate any credential that may have entered Git history; deleting it only from the latest commit is not sufficient.

## Contributing

Although OpalaTex is open-source under the MIT License, the repository does **not** accept pull requests or code contributions from third parties.

If you would like to request a specific feature or report a bug, please **open an Issue** describing what you would like to see in OpalaTex. The maintainer will review and prioritize requests accordingly.

## License

OpalaTex is available under the [MIT License](LICENSE).
