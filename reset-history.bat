@echo off
setlocal
cd /d "%~dp0"

set "REPO=https://github.com/oweebee/notask.git"
set "BRANCH=main"

echo ============================================================
echo  notask - REMISE A ZERO DE L'HISTORIQUE GIT
echo ============================================================
echo.
echo  Ce script va :
echo    1. supprimer le dossier .git local (tout l'historique)
echo    2. recreer un depot avec UN SEUL commit
echo    3. FORCE-PUSH sur %REPO% (%BRANCH%)
echo.
echo  Objectif : effacer de GitHub les anciens commits qui
echo  contenaient ton nom de domaine en dur.
echo.
echo  IRREVERSIBLE. Tes fichiers ne sont pas touches, seul
echo  l'historique des versions est perdu.
echo.
set /p "OK=Taper OUI en majuscules pour continuer : "
if not "%OK%"=="OUI" (
  echo.
  echo Annule. Rien n'a ete modifie.
  goto :fin
)

echo.
where git >nul 2>&1
if errorlevel 1 (
  echo [ERREUR] git introuvable dans le PATH.
  goto :fin
)

if exist ".git" (
  echo [1/4] Suppression de l'ancien historique...
  attrib -r -h -s ".git\*.*" /s /d >nul 2>&1
  rmdir /s /q ".git"
  if exist ".git" (
    echo [ERREUR] Impossible de supprimer .git — ferme VS Code / GitHub Desktop
    echo          ou tout programme qui utilise ce dossier, puis relance.
    goto :fin
  )
)

echo [2/4] Nouveau depot...
git init -b %BRANCH% || goto :erreur
git remote add origin %REPO% || goto :erreur

echo [3/4] Commit unique...
git add -A || goto :erreur
git commit -m "notask: app FastAPI taches/notes, Docker + deploiement Coolify/Traefik" || goto :erreur

echo [4/4] Force-push...
git push -f -u origin %BRANCH%
if errorlevel 1 goto :erreur

echo.
echo [OK] Historique remis a zero. GitHub ne contient plus qu'un commit.
echo.
echo      Verification : le domaine ne doit apparaitre nulle part.
git grep -n "obsidianspoon" & echo      (aucune ligne au-dessus = propre)
echo.
echo      Ensuite, dans Coolify : Environment Variables
echo        APP_DOMAIN=notask.tondomaine.tld
echo      puis Reload Compose File + Redeploy.
goto :fin

:erreur
echo.
echo [ECHEC] Une commande git a echoue. Voir les messages ci-dessus.

:fin
echo.
pause
endlocal
