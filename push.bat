@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "REPO=https://github.com/oweebee/notask.git"
set "BRANCH=main"

echo ===========================================
echo  notask - push vers GitHub
echo  %CD%
echo ===========================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo [ERREUR] git n'est pas installe ou pas dans le PATH.
  goto :fin
)

if not exist ".git" (
  echo [INIT] Depot git absent, initialisation...
  git init -b %BRANCH% || goto :erreur
  git remote add origin %REPO% || goto :erreur
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo [INIT] Ajout du remote origin...
  git remote add origin %REPO% || goto :erreur
)

REM --- Message de commit : argument, sinon saisie, sinon horodatage ---
set "MSG=%*"
if "%MSG%"=="" (
  set /p "MSG=Message de commit (Entree = auto): "
)
if "!MSG!"=="" (
  for /f "tokens=*" %%d in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy-MM-dd HH:mm\""') do set "MSG=maj %%d"
)

echo.
echo [STATUS]
git add -A || goto :erreur
git status --short

git diff --cached --quiet
if not errorlevel 1 (
  echo.
  echo [INFO] Aucune modification a commiter.
) else (
  echo.
  echo [COMMIT] !MSG!
  git commit -m "!MSG!" || goto :erreur
)

echo.
echo [PUSH] origin/%BRANCH%
git push -u origin %BRANCH%
if errorlevel 1 goto :erreur

echo.
echo [OK] Pousse sur %REPO% (%BRANCH%).
echo      Coolify peut maintenant redeployer.
goto :fin

:erreur
echo.
echo [ECHEC] Une commande git a echoue. Voir les messages ci-dessus.

:fin
echo.
pause
endlocal
