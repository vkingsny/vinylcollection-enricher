#!/usr/bin/env bash
# tools/install-hooks.sh
# Purpose: enforce versioned workflow via pre-commit checks
set -euo pipefail
HOOK=.git/hooks/pre-commit
mkdir -p .git/hooks
cat > "$HOOK" <<'HOOK_EOF'
#!/usr/bin/env bash
set -euo pipefail
# 1) forbid direct edits to root index.js
if git diff --cached --name-only | grep -qx 'index.js'; then
  echo "Blocked: commit modifies index.js directly. Run: node tools/set-version.mjs <ver>"
  exit 1
fi
# 2) require JS edits to be under versions/
if git diff --cached --name-only | grep -E '\.js$' | grep -v '^versions/' >/dev/null; then
  echo "Blocked: top-level JS changes found. Place worker code in versions/."
  exit 1
fi
HOOK_EOF
chmod +x "$HOOK"
echo "Pre-commit hook installed."
