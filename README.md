# De'Longhi LAN Server

Piloter une machine à café **De'Longhi ECAM** (gamme *Coffee Link*) **100 % en local**, sans passer
par le cloud De'Longhi/Ayla : serveur Node.js + interface web, sur votre réseau, sans compte requis
en fonctionnement.

Le module Wi-Fi de ces machines est un **Ayla Networks AY008ESP1** (ESP32, firmware `DL-millcore`).
Il parle le protocole Ayla, qui sait fonctionner en **LAN mode** : la machine ouvre ses connexions
vers un serveur local et non vers Internet. Ce dépôt implémente ce serveur, et transporte les
**mêmes trames binaires ECAM** que l'application officielle.

> Projet personnel d'interopérabilité, **sans aucun lien avec De'Longhi**. « De'Longhi », « Coffee
> Link » et « Ayla » appartiennent à leurs détenteurs respectifs. Aucun binaire, aucune ressource
> décompilée de l'application n'est redistribué ici — seulement une description du protocole et une
> implémentation indépendante.

## Ce que ça fait

- **Allumer / éteindre** la machine, arrêter une préparation en cours.
- **Préparer une boisson** avec ses paramètres (longueur café, arôme, lait, température…), dans les
  bornes que le modèle déclare.
- **Lire et écrire les recettes** de chacun des 5 profils, directement sur la machine.
- **Profils** : noms, icônes, ordre des favoris, recettes personnalisées.
- **Bean Adapt** : lire et écrire les profils de grains (mouture, température, arôme). La règle
  d'ajustement du questionnaire est **réimplémentée localement**, là où l'application interroge un
  service De'Longhi.
- **Statistiques d'usage** de la machine (cafés, eau, détartrages, nettoyages du circuit lait…).
- **Monitor temps réel** : état, capteurs, alarmes.
- **Fiche technique** du module : firmware, plateforme, constats de sécurité.

Inversement, ce serveur **n'appelle jamais le cloud** en fonctionnement. Le seul chemin sortant est
optionnel et déclenché explicitement : récupérer la clé LAN depuis votre compte De'Longhi (voir
plus bas).

## Prérequis

| | |
|---|---|
| Node.js | **≥ 26** (le stockage utilise le module natif `node:sqlite`) |
| pnpm | 11 (fixé par `packageManager`) |
| Réseau | la machine doit pouvoir **joindre** le serveur — voir l'avertissement ci-dessous |
| Machine | ECAM avec module Wi-Fi Ayla. Développé et validé sur une **Primadonna Soul ECAM 610.75.MB** |

> ### ⚠️ Le point qui décide de tout
> En LAN mode, **les rôles sont inversés** : ce serveur ne se connecte pas à la machine, c'est la
> **machine qui vient le contacter**. Nous lui annonçons une adresse, et elle ouvre ensuite les
> connexions vers celle-ci. Deux conséquences :
>
> - `SERVER_IP` doit être une adresse **joignable depuis le réseau de la machine** ;
> - le flux `machine → serveur:3000` doit être autorisé par votre pare-feu.
>
> C'est de loin la première cause de « ça ne marche pas ».

## Démarrage

```bash
pnpm install
cp .env.local.example .env.local     # puis renseignez SERVER_IP
pnpm dev                             # http://localhost:3000
```

En production : `pnpm build && pnpm start`.

En conteneur, l'image est publiée par GitHub Actions — rien à compiler :

```bash
docker run -d --name delonghi-lan-server -p 3000:3000 -v lan-server-data:/data \
  -e SERVER_IP=<adresse de l hote> ghcr.io/jmorille/delonghi-coffeelink-local:edge
```

Exemple `compose.yaml` complet et toutes les options : **[DOCKER.md](DOCKER.md)**.

Deux réglages sont nécessaires avant de pouvoir piloter quoi que ce soit, et **tous deux se
saisissent dans l'interface**, page « Clé LAN » :

1. **l'adresse de la machine** — elle n'a *aucune* valeur par défaut ; l'interface l'enregistre,
   la teste, et en déduit le numéro de série (DSN) de la machine ;
2. **la clé LAN** — le secret qui chiffre la session. Soit vous la connaissez et la mettez dans
   `.env.local`, soit l'interface la récupère depuis votre compte De'Longhi (Gigya → Ayla), puis la
   mémorise. Ensuite, plus aucun appel au cloud.

Tant qu'un des deux manque, l'interface le dit, refuse les commandes au lieu d'annoncer un faux
succès, et masque les pages qui ne peuvent rien faire.

## Configuration

Toutes les variables sont documentées dans [`.env.local.example`](.env.local.example) et, avec les
spécificités du conteneur, dans [DOCKER.md](DOCKER.md). L'essentiel :

| Variable | Rôle |
|---|---|
| `SERVER_IP`, `SERVER_PORT` | l'adresse que nous **annonçons** à la machine |
| `MACHINE_IP` | adresse de la machine — optionnelle, saisissable dans l'interface |
| `LANIP_KEY`, `LANIP_KEY_ID` | la clé LAN — optionnelle, récupérable dans l'interface |
| `MACHINE_DSN` | forçage du numéro de série ; découvert automatiquement sinon |
| `DATA_DIR`, `DATABASE_FILE` | emplacement du stockage SQLite |

## Documentation du protocole

Le dossier [`doc/`](doc/) contient l'analyse qui a rendu ce serveur possible. C'est la partie
réutilisable du projet, indépendamment de ce code :

| Document | Contenu |
|---|---|
| [`analyse-connexion-wifi.md`](doc/analyse-connexion-wifi.md) | protocole LAN mode Ayla, échange de clés, cryptographie, cycle de vie d'une commande |
| [`commandes-cafe.md`](doc/commandes-cafe.md) | trames ECAM : préparation, profils, recettes, sommes de contrôle, statistiques |
| [`bean-adapt.md`](doc/bean-adapt.md) | Bean Adapt : lecture, écriture, et la règle d'ajustement rétro-conçue |
| [`materiel-et-firmware.md`](doc/materiel-et-firmware.md) | le module Wi-Fi, son firmware, la fiche appareil Ayla |
| [`securite.md`](doc/securite.md) | ce que l'analyse révèle, et comment cloisonner la machine |

Les valeurs propres à l'exemplaire analysé y sont remplacées par des marqueurs (`IP_MACHINE`,
`AC000W0XXXXXXXX`…). Les références à un `secrets.md` désignent un fichier volontairement absent du
dépôt.

## Architecture, en bref

- **`server.mjs` est le point d'entrée réel, dans tous les modes.** Il sert lui-même les endpoints
  que la machine appelle (`/local_lan/*`) et l'API de contrôle (`/api/*`) en HTTP brut, et ne
  délègue à Next.js que les pages. Le client HTTP de l'ESP32 est rudimentaire et rejette le
  *framing* des réponses de Next.
- **Interface** : Next.js 16 (App Router), React 19, TypeScript, `next-intl` (français).
- **Stockage** : un fichier SQLite via `node:sqlite`, en WAL et écritures synchrones. Il contient
  la clé LAN et des données de votre machine : **traitez `data/` comme un fichier de mots de
  passe**. Le répertoire est gitignoré.
- **Catalogue de boissons** : statique, par modèle, extrait des ressources de l'application. La
  machine ne dit jamais quelles boissons elle sait faire — elle ne fournit que des valeurs.

## Sécurité

- Le module Wi-Fi ne parle qu'en **HTTP en clair** : le chiffrement Ayla protège le contenu des
  *datapoints*, pas le transport. N'exposez pas ce serveur sur Internet.
- La machine répond à `GET /regtoken.json` **sans aucune authentification** et reste
  revendicable par un compte. Isolez-la sur un VLAN dédié — voir [`doc/securite.md`](doc/securite.md).
- Le mot de passe du compte De'Longhi, s'il est utilisé, n'est **ni journalisé, ni stocké, ni
  renvoyé**, et aucun endpoint ne retourne jamais la clé LAN.

## État

Validé sur une machine réelle : allumage/extinction, monitor décodé, import du catalogue de
boissons (28/28 propriétés), import des profils (noms, icônes, favoris, recettes personnalisées),
statistiques, Bean Adapt en lecture, récupération de la clé LAN.

Pas encore éprouvé en conditions réelles : la préparation effective d'une boisson via le serveur,
la commande d'arrêt, l'écriture d'une recette dans un profil, l'écriture Bean Adapt.

Il n'y a **pas de suite de tests** : un protocole binaire face à un appareil réel se valide contre
l'appareil. L'intégration continue vérifie ce qui peut l'être sans machine — types, syntaxe,
catalogue de traductions, build, initialisation du stockage, et démarrage de l'image Docker.

## Adapter à un autre modèle

Le catalogue vient de `src/lib/machine-model.json`, extrait pour le `product_code` d'une
ECAM 610.75.MB. Pour un autre modèle, il faut le remplacer par les caractéristiques correspondantes ;
les identifiants de boissons et les bornes de paramètres changent. Le protocole, lui, est commun.

## Licence

Aucune licence n'est encore déclarée : par défaut, tous droits réservés. Si vous souhaitez réutiliser
ce travail, ouvrez une discussion.
