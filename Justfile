set shell := ["bash", "-uc"]

# Run backend and frontend together.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    (cd backend && cargo run --release) &
    (cd frontend && npm start) &
    wait

# Backend only, with the default 20M rows.
backend *ARGS:
    cd backend && cargo run --release -- {{ARGS}}

frontend:
    cd frontend && npm start

test:
    cd backend && cargo test --release
    cd frontend && npm test

# Build the frontend and serve everything from the single Rust binary.
bundle:
    cd frontend && npm run build
    cd backend && cargo run --release -- --static-dir ../frontend/dist/frontend/browser

fmt:
    cd backend && cargo fmt
