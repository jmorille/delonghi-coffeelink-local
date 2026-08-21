# Product

<!-- impeccable:product-schema 1 -->

Les titres de section sont en anglais parce que le schéma Impeccable les lit littéralement ;
le contenu est en français, comme le reste de la documentation de ce dépôt.

## Platform

web

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

**Fonctionnel confirmé** — 11 surfaces : accueil (catalogue de boissons, marche/arrêt, profils,
éditeur de recette), `/pilotage`, `/profils`, `/recipes`, `/beans`, `/statistiques`, `/machines`,
`/systeme`, plus trois redirections héritées. Multi-machine : N machines, chacune avec sa propre
adresse, clé LAN, DSN, modèle et catalogue ; toute requête client nomme explicitement sa machine.

**Contraintes fermes, confirmées par l'utilisateur :**

- **Français uniquement, tout via le catalogue.** `messages/fr.json` est la source unique ; aucune
  chaîne en dur dans les pages ; pas de chevrons dans un message (next-intl les lit comme des
  balises). Une seconde langue reste possible plus tard, par `src/i18n/request.ts`.
- **Le protocole reste dans le journal.** Aucune trame, aucun octet, aucun `0x..` dans une
  confirmation ou un libellé destiné à l'utilisateur. Le détail technique vit dans le journal et
  sur `/systeme`.
- **Pas de « mode banc ».** Un interrupteur avait été ajouté pour rallumer partout les identifiants,
  les propriétés Ayla et les trames, au motif que le produit sert deux lecteurs — l'auteur qui
  diagnostique et la personne qui veut son espresso. Il a été **retiré sur demande** : la règle
  ci-dessus se suffit à elle-même. Le protocole est dans le **journal** de `/pilotage` et sur
  `/systeme` ; c'est là qu'on va le chercher quand on diagnostique, et l'interface de préparation
  n'a pas à porter un second vocabulaire pour ça. Concrètement, l'interrupteur ouvrait 35 chaînes
  parallèles dans le catalogue et 37 branches conditionnelles dans les pages, soit un deuxième
  produit à tenir à jour pour une information déjà disponible ailleurs.
- **Thème sombre et thème clair**, les deux de premier ordre — aucun n'est un mode dégradé de
  l'autre.
- **Interface compacte et ergonomique**, utilisable sur **tablette 9" et 11"** puisque c'est
  l'appareil de pilotage des boissons.
- **Composition à base de cards**, avec la **possibilité d'ajouter des images** pour la dimension
  visuelle. (Enregistré tel que demandé ; quelles images, et d'où elles viennent, reste à décider.)
- **Boutons à icônes SVG plutôt que boutons à texte long.** L'action se lit à l'icône ; le texte
  n'est pas le canal principal de l'affordance. (Enregistré tel que demandé.) Conséquence
  d'accessibilité à tenir, pas une objection : un bouton sans texte visible garde un nom
  accessible (`aria-label` depuis le catalogue) et une étiquette atteignable au doigt — un `title`
  seul ne se voit pas sur téléphone ni sur tablette, qui sont deux des trois appareils prioritaires.

**Contraintes techniques du dépôt :** Next 16 App Router, React 19, **CSS vanilla** dans
`src/app/globals.css` (ni Tailwind ni librairie de composants), next-intl. `server.mjs` est le seul
runtime : les handlers sous `src/app/api/**` et `src/app/local_lan/**` sont masqués. **Aucune suite
de tests** — les changements de protocole se valident en direct contre la machine.

**Limites à énoncer, jamais à masquer :** 10 modèles pleinement adressables ; les 7 STRIKER_BEST
listent des boissons non adressables ; les 13 STRIKER_GOOD retombent sur un catalogue de
remplacement. Le profil actif est une *demande*, pas une observation — il n'est pas lisible sur la
machine.

**Explicitement non confirmé comme contraignant** (proposé en entretien, non retenu — à ne pas
promouvoir en règle sans l'utilisateur) :

- une **identité visuelle ostensiblement indépendante** de De'Longhi ;
- le **motif actuel de confirmation avant action physique**. L'intention de sécurité reste
  documentée dans `CLAUDE.md` ; c'est sa *forme* d'interface qui est réouvrable.

## Brand Commitments

- Nom actuel dans l'interface : **« ☕ De'Longhi LAN »** (`app.brand`), titre « De'Longhi LAN —
  pilotage local ». Aucune identité visuelle propre n'a été arrêtée : **décision ouverte**.
- Le README porte un **disclaimer de non-affiliation** avec De'Longhi / Ayla, et le dépôt ne
  redistribue aucun binaire ni ressource décompilée. C'est un fait du dépôt ; l'utilisateur ne
  l'a pas retenu comme contrainte d'identité visuelle.
- **Voix des documents existants** : français, direct, explique le *pourquoi* d'une décision et
  nomme le piège qu'elle évite. C'est le registre à tenir dans l'interface.

## Evidence on Hand

- **Réel, vérifié sur l'appareil** (ECAM 610.75.MB / Primadonna Soul) : marche/arrêt, monitor
  temps réel décodé, import du catalogue 28/28 propriétés, 5 noms de profils + icônes + ordres de
  favoris, 6 noms de recettes perso, activation de profil prouvée, identification du modèle
  (`D17055XX` → ECAM 610.75.MB). **Non exercé** : la distribution d'une boisson, la commande
  d'arrêt, une seconde machine d'un autre modèle.
- **Documentation protocole** : `doc/` (versionné, expurgé) et `../docs/` (privé, valeurs réelles).
  `ETAT.md` tient le journal de bord ; son titre daté est périmé, les dernières sections font foi.
- **Tables extraites de l'APK** : `src/lib/machine-catalogs.json` (30 modèles connectés),
  `machine-models.json` (30 modèles identifiables), `cloud-app.json`, `device-sheet.json`.
- **Absences à ne jamais combler par invention** : aucune photo ni illustration produit dans le
  dépôt à ce jour — la demande d'images implique de fournir ou de produire des assets, et **aucun
  visuel officiel De'Longhi ne peut être repris**. Aucun témoignage, aucun utilisateur tiers connu,
  aucun benchmark, aucun prix, aucune promesse de compatibilité au-delà des 10 modèles adressables.

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
5. **La mise en service est un parcours.** Adresse → clé → première lecture, dans cet ordre, avec
   la raison affichée à chaque étape bloquée — parce que l'installateur est souvent quelqu'un qui
   vient de lancer un conteneur.

## Accessibility & Inclusion

Aucune norme n'a été établie comme exigence. Contraintes de fait, issues de la scène d'usage :
cibles tactiles utilisables **debout devant la machine**, sur téléphone comme sur tablette 9-11" ;
et **parité de qualité entre thème clair et thème sombre**, y compris les contrastes, puisque les
deux sont demandés au même niveau.
