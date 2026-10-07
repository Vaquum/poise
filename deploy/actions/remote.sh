# shellcheck shell=bash
# The server's side of .github/workflows/deploy.yml, which sends it over SSH
# to the deploy user's `bash -s`, after assignments of:
#
#   repo     the repository's clone URL
#   sha      the commit to deploy
#   path     the checkout on the server
#   token    the run's GitHub token, which expires with the run
#   settings deploy/.env's new content
#
# It clones the repository on the first run, brings the checkout to sha,
# writes deploy/.env and applies it: deploy/install.sh the first time,
# deploy/upgrade.sh --no-pull after that. Of what it is given, only deploy/.env
# stays on the server; git gets the token from its environment, never from
# its command line or its configuration.
set -euo pipefail
: "${repo:?}" "${sha:?}" "${path:?}" "${token:?}" "${settings:?}"

say() { printf 'deploy: %s\n' "$*"; }
die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null || die "git is not installed on $(hostname)."
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
export GIT_CONFIG_VALUE_0

if [ ! -e "$path/.git" ]; then
  if [ -e "$path" ] && [ -n "$(ls -A "$path")" ]; then
    die "$path holds files but no checkout. Empty it, or point POISE_DEPLOY_PATH at another directory."
  fi
  say "Cloning $repo into $path."
  git clone --quiet --no-checkout "$repo" "$path"
fi
cd "$path"
origin=$(git remote get-url origin)
[ "$origin" = "$repo" ] || die "$path is a checkout of $origin, not of $repo."
# A clone whose files were never checked out, this run's or one an earlier run
# left when it stopped, has no index yet, and nothing in it is anyone else's.
checked_out=false
if [ -e "$(git rev-parse --git-path index)" ]; then
  checked_out=true
  [ -z "$(git status --porcelain --untracked-files=no)" ] \
    || die "$path has changes that are not committed, which a deployment would build into the workspace image. See them with: git -C $path status"
fi

say "Bringing $path to $sha."
git fetch --quiet origin "$sha" "+refs/heads/main:refs/remotes/origin/main"
if [ "$checked_out" = true ]; then
  # Without --force, git refuses rather than overwrite a file it does not track.
  git checkout --quiet -B main "$sha" \
    || die "$path has files git does not track where $sha puts its own; git named them above. Move them away and deploy again."
else
  git checkout --quiet --force -B main "$sha"
fi
git branch --quiet --set-upstream-to=origin/main main

(
  umask 077
  printf '%s\n' "$settings" >deploy/.env.next
)
mv deploy/.env.next deploy/.env
say "deploy/.env sets $(sed -n 's/^\([A-Z0-9_]*\)=.*/\1/p' deploy/.env | paste -sd ' ' -)."

if docker container inspect poise-gateway >/dev/null 2>&1; then
  deploy/upgrade.sh --no-pull
else
  deploy/install.sh
fi
