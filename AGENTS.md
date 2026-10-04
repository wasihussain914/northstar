# Repository Guidelines

## Project Structure & Module Organization
North Star is a math tutoring whiteboard with a React/TypeScript frontend and a Python FastAPI backend.
- `frontend/src/`: UI components and hooks; `board/` handles drawing and stroke geometry, and `glyphs/` renders handwriting.
- `frontend/public/`: icons and web manifest; production output goes to `frontend/dist/`.
- `backend/main.py`: API routes and orchestration; `tutor.py`: model integrations; `verify.py`: SymPy verification; `tts.py`: speech.
- `backend/tests/`: pytest suite; `backend/data/`: sample data.
- `README.md` and `IPAD.md`: setup and device guidance.

## Build, Test, and Development Commands
Use Python 3.11+, uv, and Node.js 20+.
- In `backend/`, run `uv sync` to install dependencies, then `uv run uvicorn main:app --host 0.0.0.0 --port 8000 --reload` to start the API.
- In `frontend/`, run `npm ci` to install dependencies and `npm run dev` to start Vite on port 5173.
- In `frontend/`, run `npm run build` for TypeScript checks and a production bundle; `npm run preview` serves that bundle locally.
- In `backend/`, run `uv run pytest` for all tests or `uv run pytest tests/test_verify.py` for verifier tests.
- From the repository root, `./dev.sh` starts both servers in Bash. PowerShell users should start them in separate terminals.

## Coding Style & Naming Conventions
Follow surrounding code: Python uses four-space indentation, snake_case functions, and type hints. TypeScript uses two spaces, double quotes, and semicolons. Use PascalCase component filenames (`RoutePanel.tsx`) and `use`-prefixed hooks (`useTutor.ts`). TypeScript enables strict and unused-symbol checks. No formatter or linter is configured.

## Testing Guidelines
Name Python tests `tests/test_*.py` with `test_*` functions. Add regression cases for changed verification, provider, or API behavior; use parametrization for related math examples and monkeypatch external services. No coverage threshold or frontend test runner is configured. For UI changes, run the frontend build and manually exercise affected drawing, typing, scanning, or voice flows.

## Commit & Pull Request Guidelines
History uses short, descriptive subjects, sometimes prefixed by a feature area; no strict commit format is established. Keep commits focused. PRs should explain behavior changes, list validation, link relevant issues, and include screenshots for visual changes.

## Security & Configuration
Copy each application's `.env.example` to `.env`. Keep API keys in the backend and never commit secrets. Leave LAN IP settings unset for localhost; consult `IPAD.md` for device setup.
