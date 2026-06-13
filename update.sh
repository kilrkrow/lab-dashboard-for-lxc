#!/bin/bash
#
# Example update script for the LXC / web server.
# Run this after `publish.ps1` on your dev machine (or wire it into your CI).
#
# Usage (on LXC):
#   chmod +x update.sh
#   ./update.sh
#
set -euo pipefail

WEBROOT="/var/www/html"   # adjust if needed

cd "$WEBROOT"

echo "Updating dashboard from git..."
git fetch --all --prune
git reset --hard origin/main   # or origin/master if your default branch is master

# Optional: fix ownership for nginx
# chown -R www-data:www-data .

echo "Dashboard updated. Consider: systemctl reload nginx"

# If you prefer rsync from a build artifact instead of git, replace the above
# with an rsync command or a download of the dist/ tarball.