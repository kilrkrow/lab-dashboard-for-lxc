<#
.SYNOPSIS
Builds the dashboard and publishes the changes to the remote GitHub repository.

.DESCRIPTION
This script automates the local build process and deployment to the public GitHub repository. 
It runs the npm build process, stages all changes (including the new compiled dist/ folder), 
and pushes them to GitHub. From there, your LXC can pull the latest static files.
#>

Write-Host "Building Haven Dashboard..." -ForegroundColor Cyan
npm run build

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed! Aborting publish." -ForegroundColor Red
    exit 1
}

Write-Host "Build successful! Staging files for Git..." -ForegroundColor Cyan
git add .

Write-Host "Committing changes..." -ForegroundColor Cyan
git commit -m "Automated build and deploy via publish.ps1"

Write-Host "Pushing to remote repository..." -ForegroundColor Cyan
git push origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "Success! The dashboard has been published to GitHub." -ForegroundColor Green
    Write-Host "You can now run ./update.sh on your LXC to pull the latest changes." -ForegroundColor Yellow
} else {
    Write-Host "Push failed. Check your Git connection or remote status." -ForegroundColor Red
}
