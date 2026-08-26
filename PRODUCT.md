# Product

<!-- impeccable:product-schema 1 -->

Les titres de section sont en anglais parce que le schéma Impeccable les lit littéralement ;
le contenu est en français, comme le reste de la documentation de ce dépôt.

## Platform

web

## Stack

**Next 16 (App Router), React 19, TypeScript 7, next-intl.** `server.mjs` est le seul runtime.

**Tailwind 4 + shadcn/ui sont la cible, et la migration est faite.** Cela **lève** la contrainte
précédemment enregistrée (« CSS vanilla, ni Tailwind ni librairie de composants ») : toute surface,
existante ou nouvelle, se bâtit sur shadcn. Décidé le 2026-08-25, exécuté le 2026-08-26 sur les
douze surfaces d'un coup — et pas « les nouvelles seulement », qui aurait fait cohabiter deux
grammaires de bouton dans le même produit.

**Ce qui a été tranché en même temps, et qui coûte de le savoir** : les trois éléments natifs que
ce dépôt avait choisis à l'écrit — `<select>`, `<dialog>`, `<input type="range">` — passent eux
aussi aux primitives Radix. Chacun rendait un service réel (le sélecteur du système sous le pouce,
le piège de focus et Échap sans une ligne, l'échelle imprimée par `--crans`) ; le composant doit
donc le rendre à son tour, et `scripts/verif-surfaces.mjs` le vérifie au navigateur à chaque
exécution. C'est le prix explicite de l'uniformité.

**La façade reste écrite à la main, et c'est le cœur du montage.** shadcn est écrit contre un
vocabulaire fixe (`bg-background`, `border-input`, `ring-ring`) ; `src/app/globals.css` le rebranche
sur les rôles du boîtier plutôt que de réécrire chaque composant. Deux remappages ne sont pas
mécaniques et sont des règles de produit : `--primary` est la touche NEUTRE et non l'ambre (la
couleur d'une commande dit sa fonction, pas son importance), et `--radius` vaut 2 px.

**Ce qui reste ouvert** : `src/app/surfaces.css` (~1 700 lignes) doit continuer de fondre. Ce qui a
vocation à y rester est ce qu'aucun utilitaire n'exprime — une graduation conditionnée par la
PRÉSENCE d'une variable, les planchers de disposition, le clavier de boissons.

## Users

**Primaire — le propriétaire d'une machine ECAM « Coffee Link » qui auto-héberge ce serveur sur
son LAN.** Deux portes d'entrée pour le même profil :

- **L'auteur**, sur son banc : connaît le protocole, lit le journal, diagnostique une trame.
- **Un tiers**, qui part d'une image GHCR ou d'un tarball et ne connaît ni DSN, ni clé LAN, ni
  « LAN mode ». Le projet est publié : cette personne fait partie du public, pas des cas limites.

**Le travail qu'ils font**, dans l'ordre de fréquence : allumer la machine et préparer une boisson
sans passer par le cloud ; ajuster recettes, profils et profils de grains ; comprendre *pourquoi*
rien ne se passe quand la machine ne répond pas.

**La mise en service d'un tiers est un parcours à part entière**, pas un écran de réglages :
adresse de la machine → clé LAN → première lecture. Chaque blocage doit dire sa raison.

## Product Purpose

Piloter une De'Longhi ECAM **100 % localement**, en réimplémentant le LAN mode Ayla et les trames
ECAM que l'application officielle transporte. Le serveur n'appelle jamais le cloud en
fonctionnement ; le seul chemin sortant est optionnel, explicite et ponctuel (récupérer la clé LAN
depuis le compte De'Longhi).

**Réussi** = une boisson préparée depuis l'interface, sans compte ni Internet, et une mise en
service qui se diagnostique elle-même quand elle échoue.

## Positioning

Le mécanisme qu'un projet voisin ne pourrait pas reprendre en l'état : **les rôles HTTP sont
inversés** — la machine est le client, ce serveur est l'hôte qu'elle vient contacter — et tout le
reste en découle (adresse annoncée, session chiffrée, état poussé). Deux conséquences propres :

- la **règle Bean Adapt est réimplémentée localement**, là où l'application officielle interroge un
  service De'Longhi ;
- le **modèle de la machine est identifié localement** (`d270_serialnumber`), donc le catalogue de
  boissons se choisit sans cloud, sans compte, sans jeton.

Contrepartie assumée : ce contrôleur est le **contrepoint local** de l'intégration Home Assistant
sœur, qui fait la même chose *par* le cloud.

## Operating Context

- **Rôles inversés** : la machine ouvre les connexions vers nous. Il faut une joignabilité
  bidirectionnelle ; la machine vit typiquement sur un VLAN IoT isolé, le poste sur un autre.
- **Appareils, tous de premier ordre** :
  - **tablette 9" et 11"** — la surface de **pilotage des boissons** ;
  - **téléphone**, debout devant la machine (allumer, préparer, arrêter) ;
  - **desktop**, pour `/statistiques`, `/recipes`, `/systeme`, `/machines`.
- **L'état est poussé, pas synchrone** : une lecture répond ~2 s plus tard, par SSE — et la machine
  peut ne jamais répondre. « En attente » est un état normal à afficher, pas une erreur.
- **Certaines actions sont physiques ou persistantes** : l'allumage déclenche un rinçage à l'eau
  chaude, l'écriture d'une recette dans un profil et l'écrasement d'un slot de grains sont
  définitifs sur l'appareil.
- **Déploiement** : Docker / `ghcr.io/<repo>:edge`, ou tarball sans Docker. Deux pièges de
  configuration sont structurels (`SERVER_IP` joignable, même numéro de port des deux côtés).

## Capabilities and Constraints

**Fonctionnel confirmé** — 9 surfaces : accueil `/` (catalogue de boissons, marche/arrêt, profils,
éditeur de recette), `/pilotage`, `/profils`, `/recipes`, `/beans`, `/reglages` (réglages machine
par adresse), `/statistiques`, `/machines`, `/systeme` ; plus 3 redirections héritées
(`/boissons` → `/`, `/bean-adapt` → `/beans`, `/cle-lan` → `/machines`). Multi-machine : N machines,
chacune avec sa propre adresse, clé LAN, DSN, modèle et catalogue ; toute requête client nomme
explicitement sa machine.

**Terminologie — « boisson » et « recette » ne sont pas le même objet**, même si les deux passent
par les mêmes composants :

- **Boisson** (`/`) — ce qui existe **sur la machine**. Bornée par le protocole : paramètres fixés
  par le modèle, bornes lues, trame `0x83`.
- **Recette** (`/recipes`) — une **composition libre**. Les *valeurs* restent dans les plages du
  modèle, mais la *composition* ne se juge jamais contre une boisson enregistrée. Ce que l'appareil
  accepte se juge **au transfert**, pas à la saisie.

**Direction confirmée le 2026-08-25** : les extensions qui feront grandir une recette au-delà du
protocole sont les **ingrédients hors machine** — sirop, glace, dosage manuel, alcool : ce que la
tasse contient au-delà de ce que l'appareil sait verser. À ne pas construire par anticipation, mais
aucune structure, aucun type, aucun libellé ne doit affirmer qu'une recette n'est *que* les
paramètres d'une boisson.

**Contraintes fermes, confirmées par l'utilisateur :**

- **Français uniquement, tout via le catalogue.** `messages/fr.json` est la source unique ; aucune
  chaîne en dur dans les pages ; pas de chevrons dans un message (next-intl les lit comme des
  balises). Une seconde langue reste possible plus tard, par `src/i18n/request.ts`.
- **Le protocole reste dans le journal.** Aucune trame, aucun octet, aucun `0x..` dans une
  confirmation ou un libellé destiné à l'utilisateur. Le détail technique vit dans le journal et
  sur `/systeme`.
- **Pas de « mode banc ».** Un interrupteur rallumant partout identifiants, propriétés Ayla et
  trames a été **retiré sur demande** : la règle ci-dessus se suffit. Le protocole est dans le
  journal de `/pilotage` et sur `/systeme` ; l'interface de préparation n'a pas à porter un second
  vocabulaire. Concrètement il ouvrait 35 chaînes parallèles dans le catalogue et 37 branches
  conditionnelles dans les pages, pour une information déjà disponible ailleurs.
- **Thème sombre et thème clair**, les deux de premier ordre — aucun n'est un mode dégradé de
  l'autre.
- **Interface compacte et ergonomique**, utilisable sur **tablette 9" et 11"** puisque c'est
  l'appareil de pilotage des boissons.
- **Composition à base de cards**, avec images.
- **Boutons à icônes SVG plutôt que boutons à texte long.** L'action se lit à l'icône ; le texte
  n'est pas le canal principal de l'affordance. Conséquence d'accessibilité à tenir, pas une
  objection : un bouton sans texte visible garde un nom accessible (`aria-label` depuis le
  catalogue) et une étiquette atteignable au doigt — un `title` seul ne se voit ni sur téléphone ni
  sur tablette, deux des trois appareils prioritaires.

**Images — le socle est « aucune image », confirmé le 2026-08-25.** L'interface doit être complète
et tenir debout **sans aucun visuel** ; les dessins sont un bonus pour qui lance l'extraction. Deux
sources coexistent, de disponibilité opposée :

- **Dessins de boissons** — extraits de l'APK, `public/boissons/` est gitignoré **et le Dockerfile
  ne copie pas `public/`** : l'image publiée n'en contient aucun, un clone frais non plus. Le repli
  `onError` de `BeverageImage` rend cette absence normale. Ce n'est pas un manque à combler : c'est
  l'état par défaut du produit, et le design ne doit jamais s'appuyer sur ces dessins.
- **Photos de configuration de grains** — **fournies par l'utilisateur**, cadrées dans le
  navigateur, normalisées en WebP 300 × 340 (le rapport des vignettes de boissons, pour ne pas
  introduire un second format) et stockées dans la base locale. Elles ne quittent jamais le LAN —
  l'application officielle, elle, met la sienne dans un datum Ayla, donc dans le cloud.

**Contraintes techniques du dépôt :** `server.mjs` est le seul runtime — les handlers sous
`src/app/api/**` et `src/app/local_lan/**` sont masqués et morts à l'exécution. **Aucune suite de
tests** : les changements de protocole se valident en direct contre la machine, et ce qui est
prouvable sans elle l'est par 7 scripts autonomes (`scripts/verif-*.mjs`) parce que les modules
qu'ils couvrent sont purs.

**Limites à énoncer, jamais à masquer :** sur les 30 modèles connectés de la table constructeur,
**10 sont pleinement adressables** ; 7 listent des boissons non adressables ; 13 retombent sur un
catalogue de remplacement. Le catalogue actif est celui d'un seul modèle, partagé par toutes les
machines : un écart est signalé, pas corrigé. Le profil actif est une *demande*, pas une
observation — il n'est pas lisible sur la machine.

**Explicitement non confirmé comme contraignant** (proposé en entretien, non retenu — à ne pas
promouvoir en règle sans l'utilisateur) :

- une **identité visuelle ostensiblement indépendante** de De'Longhi ;
- le **motif actuel de confirmation avant action physique**. L'intention de sécurité reste
  documentée dans `CLAUDE.md` ; c'est sa *forme* d'interface qui est réouvrable.

## Brand Commitments

- Nom actuel dans l'interface : **« ☕ De'Longhi LAN »** (`app.brand`), titre « De'Longhi LAN —
  pilotage local ». Aucune identité visuelle propre n'a été arrêtée : **décision ouverte**.
- Le README porte un **disclaimer de non-affiliation** avec De'Longhi / Ayla, et le dépôt ne
  redistribue aucun binaire ni ressource décompilée. C'est un fait du dépôt ; l'utilisateur ne l'a
  pas retenu comme contrainte d'identité visuelle.
- **Voix des documents existants** : français, direct, explique le *pourquoi* d'une décision et
  nomme le piège qu'elle évite. C'est le registre à tenir dans l'interface.

## Evidence on Hand

- **Réel, vérifié sur l'appareil** (ECAM 610.75.MB / Primadonna Soul) : marche/arrêt, monitor temps
  réel décodé, import du catalogue 28/28 propriétés, 5 noms de profils + icônes + ordres de
  favoris, 6 noms de recettes perso, activation de profil prouvée, identification du modèle
  (`D17055XX` → ECAM 610.75.MB), et — nouveau depuis le 2026-08-22 — **la distribution d'une
  boisson**, enregistrée sur trois préparations (espresso, espresso macchiato, lait chaud) que
  `scripts/verif-monitor.mjs` rejoue. C'est le seul comportement d'appareil figé et rejouable du
  dépôt ; il a livré un piège qu'aucune lecture du code décompilé n'aurait donné (un lait chaud
  s'arrête à 90 % et ne publie jamais 100).
- **Non exercé, à ne pas présenter autrement** : la commande d'arrêt en cours de préparation, et une
  seconde machine d'un autre modèle.
- **Tables extraites de l'APK** : `src/lib/machine-catalogs.json` (30 modèles), `machine-models.json`
  (30 modèles identifiables), `beverage-images.json` (la correspondance des 58 vignettes, sans les
  images), `cloud-app.json`, `device-sheet.json`.
- **Documentation protocole** : `doc/` (versionné, expurgé) et `ETAT.md` (journal de bord) ont été
  **supprimés au commit `c807a2c` du 2026-08-25** ; `README.md` et de nombreux commentaires les
  citent encore. Le contenu reste récupérable par `git show c807a2c^:doc/<fichier>`. `../docs/`
  (privé, valeurs réelles) est intact.
- **Absences à ne jamais combler par invention** : aucune photo ni illustration produit dans le
  dépôt, et **aucun visuel officiel De'Longhi ne peut être repris**. Aucun témoignage, aucun
  utilisateur tiers connu, aucun benchmark, aucun prix, aucune promesse de compatibilité au-delà
  des 10 modèles pleinement adressables.

## Product Principles

1. **Local d'abord ; le cloud n'est jamais un prérequis.** Un appel sortant est optionnel,
   explicite, et ne conditionne aucun contrôle.
2. **Dire l'état réel, y compris l'ignorance.** Machine muette, profil non confirmé, modèle non
   supporté, clé absente : chacun a son affichage. Un « envoyé » qui n'est pas parti est le pire
   défaut possible de ce produit.
3. **Une action physique se comprend avant de partir.** La forme est ouverte ; le fait que
   l'appareil chauffe, rince ou écrase un réglage doit rester lisible.
4. **Le protocole est consultable, jamais imposé.** L'interface parle boissons, profils et grains ;
   le journal et `/systeme` portent les octets pour qui les cherche.
5. **La mise en service est un parcours.** Adresse → clé → première lecture, dans cet ordre, avec la
   raison affichée à chaque étape bloquée — parce que l'installateur est souvent quelqu'un qui vient
   de lancer un conteneur.

## Accessibility & Inclusion

Aucune norme n'a été établie comme exigence. Contraintes de fait, issues de la scène d'usage :
cibles tactiles utilisables **debout devant la machine**, sur téléphone comme sur tablette 9-11" ;
et **parité de qualité entre thème clair et thème sombre**, y compris les contrastes, puisque les
deux sont demandés au même niveau. Un bouton à icône garde un nom accessible et une étiquette
atteignable au doigt (voir *Capabilities and Constraints*).
