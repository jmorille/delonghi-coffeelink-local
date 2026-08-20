# syntax=docker/dockerfile:1
#
# Image du serveur LAN De'Longhi. Voir DOCKER.md pour la configuration et, surtout, pour la
# contrainte réseau : en LAN mode Ayla c'est la **machine à café** qui vient frapper notre serveur,
# donc le port annoncé doit être joignable depuis son VLAN.
#
# Pas de `output: "standalone"` : le point d'entrée réel est notre `server.mjs`, pas le serveur
# généré par Next, et le traçage de dépendances de standalone part de ce dernier. On installe donc
# les dépendances de production dans l'image — plus gros, mais sans zone d'ombre.

# ------------------------------------------------------------------ dépendances (dev incluses)
# TypeScript et les types sont nécessaires au build : NODE_ENV reste vide ici, sinon pnpm sauterait
# les devDependencies.
FROM node:26-alpine AS deps
RUN apk add --no-cache libc6-compat
# Node ne livre plus corepack depuis la version 25 — `corepack: not found`, exit 127. On
# installe donc pnpm par npm, qui est present dans l'image officielle. Version figee, la
# meme que `packageManager` dans package.json.
RUN npm install -g pnpm@11.22.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ------------------------------------------------------------------ build Next
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY . .
RUN pnpm build

# ------------------------------------------------------------------ dépendances de production
FROM node:26-alpine AS prod-deps
RUN apk add --no-cache libc6-compat
# Node ne livre plus corepack depuis la version 25 — `corepack: not found`, exit 127. On
# installe donc pnpm par npm, qui est present dans l'image officielle. Version figee, la
# meme que `packageManager` dans package.json.
RUN npm install -g pnpm@11.22.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ------------------------------------------------------------------ image finale
FROM node:26-alpine AS runtime
RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    SERVER_PORT=3000 \
    DATA_DIR=/data

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json pnpm-workspace.yaml next.config.mjs server.mjs ./
COPY src ./src
COPY messages ./messages

# La base SQLite vit dans un volume : l'image, elle, ne contient aucune donnée machine ni secret.
# uid/gid 1000 = l'utilisateur `node` des images officielles — c'est ce chiffre qu'il faut donner
# au répertoire hôte si on monte un bind mount (voir DOCKER.md § Permissions).
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node

EXPOSE 3000

# `fetch` est global depuis Node 18 : pas besoin d'ajouter curl ou wget à l'image pour ça.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||3000)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
