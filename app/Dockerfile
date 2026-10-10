# FDE Gym with the harness, as one image for both of its roles: the site (the default command) and
# a runner, the machine that runs cases (`npm run runner`). docker-compose.yml in the repository
# root starts both, with the PostgreSQL database and the object store the site needs.
# Built from the repository root:  docker build -f app/Dockerfile -t fdegym .
#
# Python 3.9 is the customer's machine in every case (standard library and SQLite only), so
# the image starts from it and takes Node from the official Node image.
FROM node:22-bookworm-slim AS node

FROM python:3.9-slim-bookworm AS base
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update && apt-get install -y --no-install-recommends sqlite3 \
 && rm -rf /var/lib/apt/lists/*

FROM base AS build
RUN npm install -g pnpm@10.2.1
WORKDIR /srv/fdegym/app
COPY app/package.json app/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY app .
RUN pnpm build

FROM base
WORKDIR /srv/fdegym
COPY harness harness
COPY --from=build /srv/fdegym/app app
# Learners' commands run as other users (FDEGYM_EXEC_UID_BASE): nothing here is theirs to read,
# except the installed packages, because the coding agent (pi, one of them) runs as the learner's user.
RUN chmod -R go-rwx /srv/fdegym /root \
 && chmod go+x /srv/fdegym /srv/fdegym/app \
 && chmod -R go+rX /srv/fdegym/app/node_modules

ENV FDEGYM_DATA=/data \
    FDEGYM_EXEC_UID_BASE=20000 \
    FDEGYM_ALLOW_REMOTE=1 \
    HOST=0.0.0.0 PORT=8787 NODE_ENV=production
VOLUME /data
EXPOSE 8787
WORKDIR /srv/fdegym/app
CMD ["npm", "start"]
