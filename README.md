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
saisissent dans l'interface**, page « Machines » :

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
| `SERVER_IP`, `SERVER_PORT` | l'adresse que nous **annonçons** à la machine (globales) |
| `MACHINE_IP` | adresse de la machine — optionnelle, saisissable dans l'interface |
| `LANIP_KEY`, `LANIP_KEY_ID` | la clé LAN — optionnelle, récupérable dans l'interface |
| `MACHINE_DSN` | forçage du numéro de série ; découvert automatiquement sinon |
| `MACHINE_MODEL_KEY` | forçage du modèle ; lu sur la machine sinon |
| `DATA_DIR`, `DATABASE_FILE` | emplacement du stockage SQLite |

Les valeurs statiques de l'APK nécessaires à la récupération de la clé LAN ne sont **pas** à
saisir : elles sont livrées dans [`src/lib/cloud-app.json`](src/lib/cloud-app.json). Elles ne sont
pas secrètes — identiques pour tout le monde, extraites d'un binaire public, et sans les
identifiants d'un compte De'Longhi elles n'ouvrent rien.

### Plusieurs machines

Le serveur pilote plusieurs cafetières. Chacune a son adresse, sa clé LAN, son DSN, son modèle et
son cache de lectures : rien n'est partagé. La page **Machines** en ajoute, les nomme, choisit celle
qui répond par défaut, et en supprime — une suppression emporte toutes les données de la machine.

Deux limites, énoncées sur la page elle-même :

- **les variables `MACHINE_*` et `LANIP_*` ne décrivent que la première machine**, puisqu'une
  variable ne peut pas désigner deux appareils. Les suivantes se configurent dans l'interface, et
  leurs réglages sont mémorisés dans la base — donc dans le volume, en conteneur ;
- **le catalogue de boissons reste celui d'un seul modèle**, partagé par toutes les machines. Le
  modèle réel de chacune est lu et comparé : un écart est signalé, pas corrigé (voir ci-dessous).

Les machines nous appellent toutes sur la même adresse : c'est leur **adresse source** qui les
distingue, et le `key_id` de leur clé LAN au moment de l'échange de clés. Deux machines derrière une
même adresse source ne seraient donc pas distinguables.

### Modèle de machine

Le serveur **lit le modèle sur la machine**, sans le cloud : la propriété Ayla
`d270_serialnumber` porte le numéro de série, et ses caractères 1 à 5 sont exactement la clé qui
indexe la table constructeur (`0132217055` → `17055` → ECAM 610.75.MB). C'est la méthode de l'app
officielle elle-même. La page Système l'affiche et **signale un écart** avec le catalogue actif.

Ce catalogue reste celui d'une seule machine (ECAM 610.75.MB) : la détection prévient qu'il ne
correspond pas, elle ne le remplace pas. Voir [Adapter à un autre modèle](#adapter-à-un-autre-modèle).

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
- **Habillage** : Tailwind 4 et shadcn/ui, sur une façade écrite à la main — le thème sombre est
  le défaut, le clair est une finition. Les composants de `src/ui` reprennent le vocabulaire de
  shadcn et le rebranchent sur celui d'un boîtier d'appareil : une commande y a le relief d'une
  touche, et sa couleur dit sa fonction (elle démarre, elle arrête, elle est choisie) et non son
  importance.
- **Stockage** : un fichier SQLite via `node:sqlite`, en WAL et écritures synchrones. Chaque table
  porte la machine à laquelle sa ligne appartient. Il contient les clés LAN et des données de vos
  machines : **traitez `data/` comme un fichier de mots de passe**. Le répertoire est gitignoré.
- **Catalogue de boissons** : statique, par modèle, extrait des ressources de l'application. La
  machine ne dit jamais quelles boissons elle sait faire — elle ne fournit que des valeurs.

## Sécurité

### Ce que cette machine est, du point de vue du réseau

Un objet connecté dont le firmware **n'a jamais été mis à jour** : agent Ayla 1.5.3, SDK
**ESP-IDF 3.3.1** — branche sans correctif de sécurité depuis 2022 —, binaire compilé en avril 2020.
Il écoute sur **TCP/80 en clair**, répond à `GET /regtoken.json` **sans aucune authentification**
(ce qui livre son numéro de série à quiconque est déjà sur le même réseau), et reste
**revendicable** par un compte (`registrable: true`).

La surface d'attaque locale est petite — deux handlers HTTP, aucun service web réel — mais le
firmware, lui, est indéfendable dans le temps. La bonne réponse n'est pas de le corriger, c'est de
**réduire ce qu'il peut atteindre**. Analyse complète dans [`doc/securite.md`](doc/securite.md).

### Configuration du routeur / pare-feu

Le pilotage local n'a **aucun besoin d'Internet**. C'est précisément ce qui permet de couper
l'accès sortant de la machine sans rien perdre.

Sur un réseau segmenté — la machine sur un VLAN IoT, le serveur sur un VLAN d'administration :

| # | Règle | Pourquoi |
|---|---|---|
| 1 | **Bloquer** `machine → WAN` (tout) | Le levier décisif : plus de mise à jour distante, plus de MITM depuis Internet, plus de revendication par un tiers |
| 2 | **Bloquer** `machine → autres VLAN` (RFC1918) | Si elle est compromise, elle ne sert pas de point d'appui vers le reste du réseau |
| 3 | **Autoriser** `serveur → machine:80` | Le seul flux entrant utile : `local_reg.json` et `regtoken.json` |
| 4 | **Autoriser** `machine → serveur:3000` | **Indispensable.** En LAN mode c'est la machine qui appelle : sans cette règle, rien ne fonctionne |
| 5 | **Bloquer** `reste du VLAN IoT → machine` | L'isole des autres objets connectés, souvent les plus faibles |

La règle 4 est celle qu'on oublie, et c'est la première cause de panne. Les règles 1 et 2 sont
celles qui apportent réellement quelque chose.

Si votre réseau n'est pas segmenté, le minimum utile : réserver un bail DHCP à la machine, la
placer sur le SSID invité s'il est isolé, et bloquer son accès sortant sur le routeur — beaucoup de
routeurs grand public savent le faire par adresse MAC ou par client.

### Le serveur lui-même

- **Ne l'exposez pas sur Internet** : aucune redirection de port, aucune DMZ, aucun DNS dynamique
  vers lui. Il parle HTTP en clair et n'a **aucune authentification** — quiconque l'atteint pilote
  votre machine.
- Pour y accéder à distance, passez par un **VPN** (WireGuard, Tailscale…), pas par une exposition
  directe.
- Un reverse proxy pour l'interface est possible, mais **`/local_lan/*` doit rester joignable en
  direct par la machine** : son client HTTP est rudimentaire et ne supporte pas les en-têtes
  ajoutés par un proxy.
- Désactivez **UPnP** sur le routeur : c'est ce qui pourrait ouvrir un port sans que vous le
  demandiez.

### Les secrets

- `data/lan-server.db` contient la **clé LAN**, le numéro de série et les noms saisis sur la
  machine. Traitez-le comme un fichier de mots de passe : pas de sauvegarde en clair vers un
  stockage partagé, et jamais en pièce jointe d'un rapport de bug. Le répertoire est gitignoré.
- `.env.local` n'est pas versionné et ne doit pas l'être.
- Le mot de passe du compte De'Longhi, s'il est utilisé pour récupérer la clé, n'est **ni
  journalisé, ni stocké, ni renvoyé** : il n'existe que le temps de la requête. Aucun endpoint ne
  retourne jamais la clé LAN — seulement son identifiant, qui circule de toute façon en clair dans
  l'échange de clés.
- Le chiffrement Ayla protège le **contenu** des *datapoints*, pas le transport.

## État

Validé sur une machine réelle : allumage/extinction, monitor décodé, import du catalogue de
boissons (28/28 propriétés), import des profils (noms, icônes, favoris, recettes personnalisées),
statistiques, Bean Adapt en lecture, récupération de la clé LAN.

Le multi-machines est validé avec **une** cafetière réelle et une seconde machine déclarée mais non
raccordée : migration du schéma sur la vraie base, isolation des données, aiguillage de la session
LAN vers la bonne machine, refus des écritures sur celle qui n'est pas configurée. Le cas de deux
cafetières réellement branchées reste à éprouver.

Pas encore éprouvé en conditions réelles : la préparation effective d'une boisson via le serveur,
la commande d'arrêt, l'écriture d'une recette dans un profil, l'écriture Bean Adapt.

Il n'y a **pas de suite de tests** : un protocole binaire face à un appareil réel se valide contre
l'appareil. L'intégration continue vérifie ce qui peut l'être sans machine — types, syntaxe,
catalogue de traductions, build, initialisation du stockage, et démarrage de l'image Docker.

## Adapter à un autre modèle

Le catalogue vient de `src/lib/machine-catalogs.json`, extrait pour les **30 modèles connectés** de
la table constructeur, et le serveur choisit celui du modèle qu'il a lu sur la machine. Rien à
remplacer à la main.

Ce qui rend cette bascule sûre : **la numérotation des propriétés Ayla ne dépend pas du modèle**.
C'est un espace de noms De'Longhi figé, par nom de boisson. Un modèle a simplement un sous-ensemble
de ces boissons.

Deux familles restent hors de portée, et le serveur le dit au lieu de deviner :

- les **13 modèles STRIKER_GOOD** n'ont aucune recette dans la table constructeur — l'app obtient
  la leur ailleurs. Le catalogue par défaut sert, signalé comme un pis-aller ;
- les **7 STRIKER_BEST** ajoutent les familles « iced » et « mug » (22 boissons), qui passent par une
  autre nomenclature de propriétés. Elles sont listées et marquées comme non adressables : ni
  lisibles, ni réglables.

Restent **10 modèles pleinement servis** : 5 PD_SOUL (28 boissons, 5 profils) et 5 PD_SOUL_BETTER
(22 boissons, 3 profils, 3 recettes perso).

## Licence

Aucune licence n'est encore déclarée : par défaut, tous droits réservés. Si vous souhaitez réutiliser
ce travail, ouvrez une discussion.
