# Runs inside a small docker-cli container (so a long first build never holds up the installer): builds ct-vision
# when its files changed, (re)starts it on the GPU next to degoog (CPU if Docker has no GPU), drops older builds.
set -e
cd /src
TAG="ct-vision:$(cat tag)"
docker image inspect "$TAG" >/dev/null 2>&1 || docker build -q -t "$TAG" . >/dev/null
cur=$(docker inspect -f '{{.Config.Image}}' ct-vision 2>/dev/null || true)
if [ "$cur" != "$TAG" ] || [ "$(docker inspect -f '{{.State.Running}}' ct-vision 2>/dev/null)" != "true" ]; then
  docker rm -f ct-vision >/dev/null 2>&1 || true
  # Caps so it can never crowd the PC: 6 GB RAM, 4 CPU cores; the GPU only works while you search
  if ! docker run -d --name ct-vision --network ct-net --restart unless-stopped --gpus all --memory 6g --cpus 4 -v ct-vision-cache:/cache "$TAG" >/dev/null; then
    docker rm -f ct-vision >/dev/null 2>&1 || true
    docker run -d --name ct-vision --network ct-net --restart unless-stopped --memory 6g --cpus 4 -v ct-vision-cache:/cache "$TAG" >/dev/null
  fi
fi
for i in $(docker images ct-vision --format '{{.Repository}}:{{.Tag}}'); do [ "$i" = "$TAG" ] || docker rmi "$i" >/dev/null 2>&1 || true; done
echo "ct-vision ready: $TAG"
