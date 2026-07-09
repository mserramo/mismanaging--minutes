# Running the Card Stacking Game Locally

This note explains how to run the oTree Card Stacking Game from the GitHub
repository. You do not need Codex.

## 1. Get the Code

Use either option:

- Download the repository as a ZIP from GitHub and unzip it.
- Or clone it with Git:

```bash
git clone https://github.com/mserramo/mismanaging-minutes.git
cd mismanaging-minutes
```

## 2. Mac Setup

Install Python if needed. Python 3.11, 3.12, or 3.13 should work for this
project.

From Terminal, inside the repository folder:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/otree devserver 8000
```

Then open:

```text
http://localhost:8000/
```

## 3. Windows Setup

Install Python from <https://www.python.org/downloads/> if needed. During
installation, select the option to add Python to PATH.

From PowerShell or Command Prompt, inside the repository folder:

```powershell
py -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\otree devserver 8000
```

Then open:

```text
http://localhost:8000/
```

If PowerShell blocks virtual environment scripts, the commands above should
still work because they call the virtual environment's Python and oTree
executables directly.

## 4. Starting the Game

On the oTree demo page, choose:

```text
card_stacking
```

The first page is a development-only experimenter setup page. It lets you set
task duration, feedback displays, timing delays, and the main-card bonus
parameters. After that, the participant-facing task begins.

## 5. If Something Goes Wrong

If port 8000 is already in use, run the server on another port:

```bash
.venv/bin/otree devserver 8001
```

On Windows:

```powershell
.\.venv\Scripts\otree devserver 8001
```

Then open `http://localhost:8001/`.

If oTree gives a database/schema error after pulling code updates, reset the
local development database:

```bash
.venv/bin/otree resetdb
```

On Windows:

```powershell
.\.venv\Scripts\otree resetdb
```

This deletes local development data, so use it only for local testing.

## 6. Updating Later

If you cloned with Git, update with:

```bash
git pull
```

Then reinstall requirements only if `requirements.txt` changed:

```bash
.venv/bin/python -m pip install -r requirements.txt
```

On Windows:

```powershell
.\.venv\Scripts\python -m pip install -r requirements.txt
```

