# Déploiement en conteneur

Le serveur LAN dans une image Docker : `Dockerfile`, `docker-compose.yml`, et toutes les options de
configuration ci-dessous.

Image publiée par le workflow de release : `ghcr.io/<owner>/<repo>`, étiquettes `latest`,
`<majeure>`, `<majeure>.<mineure>` et `<version>`, pour `linux/amd64` et `linux/arm64`.

```bash
docker run -d --name delonghi-lan-server \
  -p 3000:3000 \
  -v lan-server-data:/data \
  -e MACHINE_IP=[ip de la cafetiere] \
  -e SERVER_IP=[ip de l hote, joignable depuis le VLAN de la cafetiere] \
  -e LANIP_KEY='…' -e LANIP_KEY_ID=… \
  ghcr.io/<owner>/<repo>:latest
```

Interface sur `http://<hôte>:3000/`.

---

## 1. Le réseau, qui décide de tout

En LAN mode Ayla **les rôles sont inversés** : ce serveur ne se connecte pas à la cafetière, c'est
la **cafetière qui vient frapper à notre porte**. Nous lui annonçons une adresse
(`POST /local_reg.json` avec `{ip, port}`) et elle ouvre ensuite les connexions vers cette adresse.
Deux conséquences qu'aucun réglage Docker ne rattrape :

| Règle | Pourquoi |
|---|---|
| **`SERVER_IP` = adresse joignable depuis le VLAN de la cafetière** | C'est la valeur que nous annonçons. L'IP interne du conteneur (`172.17.x.x`) n'est pas routable depuis son VLAN : la machine n'arriverait jamais. Mettre l'IP de l'**hôte**. |
| **Même numéro de port des deux côtés** | Nous annonçons `SERVER_PORT`, qui est aussi le port d'écoute. Avec `-p 8080:3000`, la machine irait toquer sur 8080 alors que rien n'y répond côté hôte du point de vue de la machine — utiliser `-p 3000:3000`, ou changer `SERVER_PORT` **et** la publication ensemble. |
| **Le flux machine → serveur doit être autorisé** | La cafetière est sur un VLAN isolé (LAN3 ici). Il faut une règle qui laisse passer `machine → hôte:3000`. Voir `../docs/securite.md`. |

Deux modes de réseau fonctionnent :

- **Ports publiés** (par défaut, marche partout, y compris Docker Desktop) : `-p 3000:3000` et
  `SERVER_IP` = IP LAN de l'hôte. La machine atteint l'hôte, Docker redirige vers le conteneur.
- **Réseau de l'hôte** (Linux seulement) : `--network host`, pas de `-p`. Plus simple, aucun NAT.
  `SERVER_IP` reste à renseigner : c'est l'adresse annoncée, pas l'adresse d'écoute (le serveur
  écoute toujours sur `0.0.0.0`).

---

## 2. Emplacement de la base de données

Tout l'état persistant est **un fichier SQLite**. Deux variables le situent :

| Variable | Défaut dans l'image | Effet |
|---|---|---|
| `DATA_DIR` | `/data` | Répertoire de tout l'état persistant. C'est aussi là que sont cherchés les anciens fichiers JSON à migrer. |
| `DATABASE_FILE` | `<DATA_DIR>/lan-server.db` | Chemin **complet** du fichier de base, pour le sortir de `DATA_DIR`. Les répertoires manquants sont créés. |

Hors conteneur, `DATA_DIR` vaut `./data` (relatif au répertoire de travail). Un chemin relatif est
résolu depuis ce même répertoire.

```bash
# La base dans le volume, à l'emplacement par défaut
-v lan-server-data:/data

# Un répertoire de l'hôte plutôt qu'un volume nommé
-v /srv/delonghi/data:/data

# La base ailleurs que dans DATA_DIR (deux montages distincts)
-v lan-server-data:/data -v /mnt/ssd:/db -e DATABASE_FILE=/db/cafetiere.sqlite
```

### Les fichiers présents à côté

Le journal est en mode **WAL**, donc trois fichiers cohabitent en fonctionnement :

| Fichier | Rôle |
|---|---|
| `lan-server.db` | la base |
| `lan-server.db-wal` | écritures pas encore intégrées |
| `lan-server.db-shm` | mémoire partagée du WAL |

À l'arrêt propre du serveur, le WAL est intégré à la base et les deux fichiers annexes
disparaissent. **Ne jamais copier `lan-server.db` seul pendant que le serveur tourne** : la copie
serait antérieure au contenu du WAL. Voir § 5.

### Permissions

Le conteneur tourne sous l'utilisateur `node`, **uid/gid 1000**. Avec un volume nommé, Docker
s'occupe des droits. Avec un répertoire de l'hôte, il faut les donner :

```bash
sudo mkdir -p /srv/delonghi/data
sudo chown -R 1000:1000 /srv/delonghi/data
```

Sans ça, le serveur s'arrête au démarrage sur `ERR_SQLITE_ERROR: unable to open database file`
(code SQLite 14, `SQLITE_CANTOPEN`) : la base ne peut pas être créée.

### ⚠️ Ce répertoire est du matériel secret

La base contient la **clé LAN** (table `meta`, clé `lanKey`), le **numéro de série** de la machine
et les **noms de profils** saisis dessus. À traiter comme un fichier de mots de passe : pas de
sauvegarde vers un stockage public, et surtout pas de pièce jointe à un rapport de bug. L'image,
elle, n'en contient rien (`data/` et `.env.local` sont exclus par `.dockerignore`).

---

## 3. Variables d'environnement

Elles ont **priorité sur `.env.local`** : le serveur lit ce fichier s'il existe mais ne remplace
jamais une variable déjà définie. On peut donc au choix tout passer en `-e`, ou monter le fichier
(`-v ./.env.local:/app/.env.local:ro`).

### Machine

| Variable | Défaut | Description |
|---|---|---|
| `MACHINE_IP` | — | Adresse de la cafetière, IPv4 ou nom d'hôte. **Aucune valeur par défaut** : sans elle le serveur ne contacte rien. Elle peut aussi être saisie dans l'interface (page « Machine »), qui la mémorise dans la base — cette variable, si présente, reste prioritaire. |
| `MACHINE_GENERATION` | `classic` | `classic` (propriétés `data_request` / `d302_monitor`) ou `striker`. L'ECAM 610.75.MB est `classic`. |
| `MACHINE_DSN` | — | **Optionnel.** Le serveur découvre le DSN sur la machine (`GET /regtoken.json` → `host_symname`) et le mémorise. Ne le renseigner que pour forcer une valeur : elle devient prioritaire et toute divergence est signalée dans le journal. |

### Clé LAN

| Variable | Défaut | Description |
|---|---|---|
| `LANIP_KEY` | — | Chaîne base64 **telle quelle** — ne pas la décoder. Sans elle, aucun échange de clés n'est possible. |
| `LANIP_KEY_ID` | `0` | Identifiant de la clé. Circule en clair dans l'échange de clés, ce n'est pas un secret. |

Si ces variables sont absentes, le serveur démarre quand même et la page **Clé LAN**
(`/cle-lan`) permet de découvrir la clé avec les identifiants du compte De'Longhi ; elle est alors
mémorisée dans la base et le cloud n'est plus jamais appelé. Priorité : `LANIP_KEY` > base >
découverte.

### Notre serveur

| Variable | Défaut | Description |
|---|---|---|
| `SERVER_IP` | `127.0.0.1` | **À renseigner.** Adresse annoncée à la machine (§ 1). Le défaut ne marche qu'en test local. |
| `SERVER_PORT` | `3000` | Port d'écoute **et** port annoncé. |

### Stockage

| Variable | Défaut dans l'image | Description |
|---|---|---|
| `DATA_DIR` | `/data` | § 2. |
| `DATABASE_FILE` | `<DATA_DIR>/lan-server.db` | § 2. |

### Découverte de la clé par le compte De'Longhi (optionnel)

Trois valeurs statiques extraites de l'APK, identiques pour tout le monde mais qui restent des
secrets applicatifs. Sans elles, la découverte est simplement indisponible — **le pilotage local
n'en a aucun besoin**.

| Variable | Défaut | Description |
|---|---|---|
| `GIGYA_API_KEY` | — | Clé API Gigya De'Longhi. |
| `AYLA_APP_ID` | — | `app_id` du champ européen. |
| `AYLA_APP_SECRET` | — | `app_secret` du champ européen. |
| `GIGYA_DATACENTER` | `eu1` | Centre de données Gigya. `us1` répond « served by another data center ». |

### Divers

| Variable | Défaut | Description |
|---|---|---|
| `AYLA_TOKEN` | — | Uniquement pour la vérification OTA côté cloud de la page Système. Sans lui, cette vérification est annoncée comme désactivée — le reste ne dépend d'aucun jeton cloud. |
| `TZ` | UTC | Fuseau horaire, pour les horodatages du journal. |
| `NODE_ENV` | `production` | Fixé dans l'image, ne pas y toucher. |

---

## 4. Reprendre une installation existante

La base est créée au premier démarrage. Si les anciens fichiers JSON (`machine-beverages.json`,
`recipes.json`, `lan-key.json`) sont présents dans `DATA_DIR`, ils sont **repris automatiquement**
puis renommés en `*.json.migrated` — conservés, pas supprimés. Pour migrer une installation qui
tournait hors conteneur, il suffit donc de copier l'ancien `data/` dans le volume :

```bash
docker run --rm -v lan-server-data:/data -v "$PWD/data":/ancien:ro \
  alpine sh -c 'cp -a /ancien/. /data/ && chown -R 1000:1000 /data'
```

Au démarrage suivant, le journal indique ce qui a été repris :

```
SYS migration JSON → SQLite : 58 propriétés, 62 statistiques, 6 profils de grains, 0 recettes, clé LAN (key_id …)
```

La migration ne rejoue pas : elle est verrouillée par `PRAGMA user_version`.

---

## 5. Sauvegarde et restauration

**À chaud**, sans arrêter le serveur — `VACUUM INTO` produit une copie cohérente d'une base en
cours d'utilisation, WAL compris :

```bash
docker exec delonghi-lan-server node -e "
  const { DatabaseSync } = require('node:sqlite');
  const f = process.env.DATABASE_FILE || (process.env.DATA_DIR || '/data') + '/lan-server.db';
  const db = new DatabaseSync(f, { readOnly: true });
  db.exec(\"VACUUM INTO '/data/sauvegarde.db'\");
  db.close();
"
docker cp delonghi-lan-server:/data/sauvegarde.db ./sauvegarde-$(date +%F).db
docker exec delonghi-lan-server rm /data/sauvegarde.db
```

**À froid** : `docker stop` d'abord, puis copier `lan-server.db`. L'arrêt propre intègre le WAL, un
seul fichier suffit alors.

**Restauration** : conteneur arrêté, remplacer `lan-server.db` et supprimer les éventuels `-wal` et
`-shm` qui traînent, sinon SQLite rejouerait un journal qui ne correspond plus à la base.

Le fichier de sauvegarde contient la clé LAN : le chiffrer ou le ranger comme tel.

---

## 6. Santé et journaux

L'image déclare un `HEALTHCHECK` qui interroge `/api/status` toutes les 30 s (25 s de grâce au
démarrage, le temps que Next se lève).

```bash
docker inspect --format '{{.State.Health.Status}}' delonghi-lan-server
docker logs -f delonghi-lan-server
```

Le journal reprend celui de l'interface : `SYS` pour les événements du serveur, `OUT` pour ce qu'on
sert à la machine, `IN` pour ce qu'elle nous pousse. La page **Système** affiche en plus l'état du
stockage (moteur, version de schéma, mode de journal, nombre de lignes, taille du fichier).

---

## 7. Compose

L'image est **construite et publiée par GitHub Actions** : il n'y a rien à compiler pour l'utiliser.

| Étiquette | Contenu |
|---|---|
| `:edge` | suit la branche principale — republiée à chaque poussée dont la CI passe, test de démarrage du conteneur inclus |
| `:latest` | dernière version étiquetée `v*` |
| `:0.1.0`, `:0.1`, `:0` | une version précise — **à préférer en production** |
| architectures | `linux/amd64` et `linux/arm64` (les images de release ; `:edge` suit celle du runner) |

### Exemple complet

Deux fichiers à côté l'un de l'autre : `compose.yaml` et `.env.local`.

```yaml
# compose.yaml
services:
  lan-server:
    image: ghcr.io/jmorille/delonghi-coffeelink-local:edge
    container_name: delonghi-lan-server
    restart: unless-stopped

    # Les secrets restent dans .env.local, jamais dans ce fichier ni dans l'image.
    env_file:
      - .env.local
    environment:
      DATA_DIR: /data
      TZ: Europe/Paris

    # ⚠️ Le même numéro des deux côtés : nous annonçons SERVER_PORT à la machine (§ 1).
    ports:
      - "3000:3000"

    volumes:
      - lan-server-data:/data

    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:3000/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      start_period: 25s
      retries: 3

volumes:
  lan-server-data:
```

```bash
# .env.local — le strict minimum
SERVER_IP=192.168.x.x        # adresse de l'hôte, joignable depuis le réseau de la cafetière
SERVER_PORT=3000
MACHINE_GENERATION=classic
# MACHINE_IP et LANIP_KEY sont facultatifs : ils se saisissent dans l'interface,
# page « Clé LAN », et sont mémorisés dans le volume.
```

```bash
docker compose up -d                           # démarrer
docker compose logs -f                         # suivre le journal
docker compose pull && docker compose up -d    # mettre à jour
docker compose down                            # arrêter (le volume survit)
```

Puis ouvrir `http://<hôte>:3000/`, page « Clé LAN », et renseigner l'adresse de la machine puis la
clé. Rien d'autre n'est nécessaire.

### Variante réseau de l'hôte (Linux)

Évite tout NAT, mais incompatible avec `ports:` et indisponible sur Docker Desktop :

```yaml
services:
  lan-server:
    image: ghcr.io/jmorille/delonghi-coffeelink-local:edge
    network_mode: host
    env_file: [.env.local]
    volumes:
      - lan-server-data:/data
```

`SERVER_IP` reste à renseigner : c'est l'adresse que nous **annonçons**, pas celle d'écoute — le
serveur écoute toujours sur `0.0.0.0`.

### Construire localement plutôt que tirer l'image

```bash
docker compose build      # nécessite le dépôt cloné, et `build: .` décommenté dans le compose
```

Le `docker-compose.yml` du dépôt est déjà configuré ainsi, l'image GHCR par défaut et la ligne
`build: .` en commentaire.

---

## 8. Dépannage

| Symptôme | Cause probable |
|---|---|
| L'interface s'affiche, mais aucune propriété ne remonte et le monitor reste vide | La machine n'arrive pas à nous joindre : `SERVER_IP` faux, port non publié, port différent des deux côtés, ou filtrage entre les VLAN. C'est de loin la cause la plus fréquente (§ 1). |
| `unable to open database file` au démarrage | Droits du répertoire monté : `chown -R 1000:1000` (§ 2). |
| `clé LAN absente` dans le journal | `LANIP_KEY` / `LANIP_KEY_ID` non transmises. Le serveur fonctionne, mais aucune session chiffrée n'est possible ; la page **Clé LAN** (`/cle-lan`) peut la découvrir. |
| `DSN inconnu : la machine n'a pas répondu à /regtoken.json` | `MACHINE_IP` faux, machine éteinte, ou trafic conteneur → machine bloqué. |
| Les données ont disparu après une mise à jour | Le volume n'était pas monté : sans `-v … :/data`, l'état vit dans la couche du conteneur et part avec lui. |
| L'image `arm64` est lente à publier | Elle est construite sous émulation QEMU dans le workflow de release. Normal. |

---

## 9. Ce que l'image ne fait pas

- **Aucun appel au cloud** au démarrage ni en fonctionnement. La découverte de la clé LAN est le
  seul chemin qui sort, sur action explicite dans l'interface.
- **Aucun secret embarqué** : `data/` et `.env.local` sont exclus du contexte de build.
- **Pas de TLS.** Le serveur parle HTTP en clair, parce que c'est ce que le module Wi-Fi de la
  machine sait faire. Ne pas l'exposer sur Internet ; le placer derrière un reverse proxy si une
  interface distante est souhaitée — en gardant `/local_lan/*` joignable en direct par la machine,
  qui ne supportera pas les en-têtes ajoutés par un proxy.
