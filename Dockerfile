# check=skip=FromPlatformFlagConstDisallowed
#
# A Team server, with everything it downloads already inside it.
#
# The check above is skipped rather than satisfied: it wants the platform to
# come from a build argument, and this image is deliberately one platform. The
# reason is under the base image below.
#
# linux/amd64 only, and that is a decision rather than an omission. Team pins a
# loreserver build per platform, and the only 64-bit ARM Linux build Epic
# publishes targets Neoverse cores with 512-bit SVE - its own caveat says it is
# liable to die on an illegal instruction elsewhere. An arm64 image would run
# until it did not.
#
# The base is trixie and cannot be bookworm: lorelib needs GLIBC_2.39, which
# trixie has at 2.41 and bookworm does not at 2.36. Alpine is out entirely,
# being musl.

FROM --platform=linux/amd64 node:24-trixie-slim AS build
WORKDIR /src

# The manifest first, so a change to a source file does not re-resolve the whole
# dependency tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY protocol ./protocol
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# The binaries, fetched here rather than on first start: a container that
# downloaded them would want a hundred megabytes on every fresh volume, would
# not start at all without a route to GitHub, and would make the first thing an
# operator sees a progress bar. scripts/prefetch.ts calls what `up` calls, so
# the checksums it verifies against are the pinned ones and there is no second
# copy of a pin in this file.
ENV NLTEAM_CACHE_DIR=/opt/nlteam/cache
RUN npx esbuild scripts/prefetch.ts --bundle --platform=node --format=cjs \
      --external:koffi --define:__NLTEAM_VERSION__=\"0.0.0-prefetch\" \
      --outfile=/tmp/prefetch.cjs \
 && node /tmp/prefetch.cjs

# The production tree on its own. The four @lore-vcs platform packages are
# optional dependencies and exactly one of them installs here, which is the
# linux one - that is what makes this image able to read what is inside a
# project rather than only to hand out identity.
RUN npm ci --omit=dev


FROM --platform=linux/amd64 node:24-trixie-slim AS runtime

# `tar` is not optional: Team unpacks release archives with the operating
# system's own and carries no archive library. It is Essential in Debian and so
# is already here; naming it is a note for whoever changes the base.
#
# `nlteam` runs as `node`, the unprivileged account the base image already
# carries. Nothing here binds a port below 1024.
ENV NODE_ENV=production \
    NLTEAM_ROOT=/var/lib/nlteam \
    NLTEAM_CACHE_DIR=/opt/nlteam/cache

WORKDIR /opt/nlteam/app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/package.json ./package.json
# Readable by the account that will run it. The archive is unpacked as root in
# the stage above, and GNU tar run by root keeps the ownership and the mode the
# upstream tarball carries - loreserver's arrives as 0700 owned by whichever
# account built it, which is nobody here. An ordinary install never sees this,
# because an ordinary install is not run by root.
COPY --from=build --chown=node:node /opt/nlteam/cache /opt/nlteam/cache
RUN chmod -R a+rX /opt/nlteam/cache && chmod a+x /opt/nlteam/cache/bin/loreserver-*/loreserver

# On the PATH under its own name, so that `docker exec <container> nlteam init
# ada` is the command the documentation says it is. The bundle carries its own
# `#!/usr/bin/env node`.
RUN ln -s /opt/nlteam/app/dist/nlteam.js /usr/local/bin/nlteam \
 && install -d -o node -g node /var/lib/nlteam

# The source label is not decoration: the registry uses it to attach the
# package to this repository, which is what puts a readme and a licence on the
# package page rather than a bare image name.
LABEL org.opencontainers.image.source="https://github.com/NarraLeaf/NarraLeaf-Team"       org.opencontainers.image.description="Self-hosted project server for teams using NarraLeaf Studio"       org.opencontainers.image.licenses="MIT"

USER node
VOLUME ["/var/lib/nlteam"]

# Only the two that belong on a network a collaborator can reach. Team's own
# HTTP listener and loreserver's health check are bound to the loopback and stay
# inside. 41337 is one number carrying two listeners, gRPC over TCP and QUIC
# over UDP, and a deployment that publishes only the TCP half works until
# somebody has a connection where QUIC wins.
EXPOSE 41402/tcp 41337/tcp 41337/udp

# loreserver's own health check, not Team's. Team's `/health` answers `{"ok":
# true}` unconditionally - it says this process is running, which the container
# runtime already knows - while loreserver's is the signal `up` itself waits for
# before it says the server is up, and the one that goes quiet if loreserver
# dies and is being restarted underneath.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const p=process.env.NLTEAM_HEALTH_PORT||41339;fetch('http://127.0.0.1:'+p+'/health_check').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["nlteam"]
CMD ["up"]
