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

REM --- Verrou .git\index.lock : reste parfois derriere un git plante ou
REM     interrompu (antivirus, sync, fermeture brutale...) et bloque tout
REM     add/commit tant qu'il traine. Un git normal en cours sur CE dossier
REM     pendant qu'on double-clique le script est en pratique impossible
REM     (le script est la seule chose qui lance git ici) : le supprimer
REM     avant de continuer est donc sans risque dans ce contexte.
if exist ".git\index.lock" (
  echo [INFO] Verrou .git\index.lock detecte, suppression...
  del /f /q ".git\index.lock" >nul 2>&1
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo [INIT] Ajout du remote origin...
  git remote add origin %REPO% || goto :erreur
)

REM --- Message de commit : argument, sinon horodatage automatique (aucune
REM     saisie requise : le script doit pouvoir tourner sans intervention,
REM     du double-clic jusqu'a la fin) ---
set "MSG=%*"
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
endlocal
pause
