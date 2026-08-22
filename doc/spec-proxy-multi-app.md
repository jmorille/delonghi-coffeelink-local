# Spécification — lan-server joue le rôle de la machine, pour N applications

> **Statut : conception, rien n'est implémenté.** Ce document décrit une fonctionnalité qui n'existe
> pas. Il distingue partout ce qui est **mesuré sur l'appareil**, ce qui est **lu dans l'APK
> décompilé**, et ce qui est **inféré**. Aucune ligne de code ne doit être écrite avant que la
> section *Ce qu'il faut vérifier d'abord* soit close : la moitié du raisonnement repose sur du code
> décompilé, jamais observé en fonctionnement.

> **Note.** Ce document est versionné et publié. Les valeurs propres à un exemplaire sont écrites
> comme marqueurs : `IP_MACHINE`, `AC000W0XXXXXXXX` (numéro de série), `VLAN_IOT`.

---

## 1. Le problème

Le mode LAN d'Ayla **inverse les rôles** : ce n'est pas le client qui interroge la machine, c'est la
machine qui se connecte au client. Pour savoir à qui se connecter, elle retient l'adresse qu'on lui
a annoncée par `POST /local_reg.json`.

**Ce créneau est unique.** Trois indices concordants dans `AylaLanModule` :

- La ressource est au singulier, et le corps ne contient qu'un `ip`/`port`/`uri`.
- La première annonce est un **POST**, les suivantes des **PUT** — une mise à jour, pas un ajout :
  `new AylaJsonRequest<>(z9 ? 2 : 1, …)` où `z9 = _isActive` (Volley : 1 = POST, 2 = PUT).
- Il existe une `DeleteSessionCommand` — `DELETE local_reg.json`, données `delete_session` — qui
  supprime **la** session, pas une entrée d'une liste.

Conséquence : **deux clients locaux se chassent l'un l'autre.** Quand l'application officielle
s'annonce, lan-server cesse d'être servi, et réciproquement — sans erreur, sans log, sans rien. Le
dernier `local_reg` gagne.

C'est le verrou que cette fonctionnalité lève : **un seul créneau, multiplexé.**

## 2. L'objectif

Permettre à **plusieurs applications officielles** — plusieurs téléphones — d'être enregistrées et
actives **en même temps** sur la même machine, avec lan-server au milieu.

lan-server se fait passer pour la machine auprès des applications, et reste le client unique de la
vraie machine. Les applications croient parler à la cafetière ; elles parlent à nous.

```
  téléphone A ─┐
  téléphone B ─┼─► lan-server ──(le seul local_reg)──► machine réelle
  téléphone C ─┘      + interface web
```

## 3. Pourquoi c'est possible — l'enjeu tient en une phrase

**La clé LAN est celle de l'appareil, et nous l'avons.**

Ayla dépose `lanip_key` + `lanip_key_id` sous le DSN de l'appareil, et les remet à tout compte
autorisé. lan-server la détient déjà (découverte par `/api/lankey`, ou posée dans `.env.local`). Or
c'est **le seul secret** qui authentifie la machine dans un échange de clés LAN.

Nous sommes donc, au niveau cryptographique, **indistinguables de la machine**. Il n'y a pas à
casser quoi que ce soit : il faut jouer l'autre côté d'un protocole dont on possède déjà le secret,
et dont on a déjà écrit la moitié.

Le port est presque symétrique. `makeSession()` dérive deux jeux de clés par double HMAC-SHA256 :
les clés **« app »** chiffrent client → appareil, les clés **« dev »** chiffrent appareil → client.
Aujourd'hui lan-server est le client : il chiffre en « app » et déchiffre en « dev ». En jouant
l'appareil il fait l'inverse — **même formule, opérandes échangés**, et les deux sont déjà
implémentées.

## 4. Ce qui est établi, ce qui ne l'est pas

| Fait | Source | Statut |
|---|---|---|
| Rôles inversés, la machine est le client HTTP | mesuré, en production depuis des mois | **établi** |
| `lanip_key` utilisée comme octets ASCII de la chaîne base64 | mesuré | **établi** |
| Le flux AES-256-CBC est persistant par session | mesuré | **établi** |
| L'app annonce en POST puis PUT, et sait supprimer la session | APK décompilé | **lu**, et le POST + `?dsn=` sur port 80 est **observé** (2026-08-22) |
| Le créneau `local_reg` est **unique** | **mesuré le 2026-08-22** (voir §7.1) | **établi** |
| L'app interroge `<DSN>.local` en mDNS, ports 5353 **et 10276** | APK décompilé (`NetThread`) | **lu, non observé** |
| Ce chemin mDNS n'est emprunté qu'après un échec réseau/timeout | APK décompilé (`handleKeyExchangeError`) | **établi, et plus restrictif** : il faut EN PLUS que le téléphone soit coupé du cloud (§7quater) |
| L'app accepterait une réponse mDNS venue d'un autre hôte | — | **sans objet** : le mDNS ne part jamais en usage normal (2026-08-22) |
| Une app se contenterait d'un pair qui n'est pas la machine | **PROUVÉ le 2026-08-22** : l'app officielle a ouvert une session avec lan-server et journalisé `sameLan: true` (§7quinquies) | **établi** |

**Quatre lignes de ce tableau restent des inférences**, et elles portent le chemin mDNS et la
crédulité de l'app — plus la prémisse. D'où la section 9.

## 5. Décisions prises

### 5.1 Redirection par répondeur mDNS
> ### ⚠️ Mesuré le 2026-08-22 — cette décision est CADUQUE
>
> Le mDNS n'est armé que si `isCachedSession()` est vrai, c'est-à-dire **uniquement quand le
> téléphone n'a pas pu joindre le cloud Ayla** (l'unique appelant qui pose ce drapeau est la
> branche d'erreur du rafraîchissement de jeton dans `CachedAuthProvider`, qui journalise
> « Starting LAN login »). Vérifié en direct : cafetière retirée du réseau, application ouverte,
> `local_reg` en échec toutes les 10 s pendant plus de 100 s — **aucune requête mDNS**, jamais.
> L'application bascule silencieusement sur le cloud et continue d'afficher la machine « en ligne ».
>
> S'y ajoute un second obstacle, indépendant : la requête est du multicast lien-local, donc elle ne
> quitte pas le segment du téléphone. Notre serveur est ailleurs.
>
> Détail complet et extraits de code dans `doc/analyse-connexion-wifi.md` §7quater.
>
> **La voie qui reste** est de répondre à l'adresse que l'application interroge déjà — prendre la
> place de la machine au niveau réseau. Et pas par une règle de pare-feu : téléphone et cafetière
> partagent le même /24, le trafic est commuté et ne traverse jamais la passerelle. Concrètement :
> donner au serveur une patte sur ce segment et **lui attribuer l'adresse de la cafetière**, celle-ci
> étant déplacée ailleurs. C'est plus invasif que le mDNS, et c'est la seule chose qui marche.


lan-server répond lui-même à la question que l'app pose déjà.

- Question de **type A** pour `AC000W0XXXXXXXX.local` (le nom d'hôte **est** le DSN).
- Émise vers **224.0.0.251**, sur **5353** *et* **10276** (`MDNS_AYLA_PORT`) — le module Ayla écoute
  sur un port mDNS non standard, et une implémentation qui ne couvrirait que 5353 resterait muette.
- Réémise **toutes les secondes** tant que rien ne répond, `TTL = 2`.

**Retenu** parce que c'est le crochet que l'app prévoit : rien à configurer sur le routeur, rien de
spécifique au matériel de l'utilisateur.

**Sa limite est structurelle et doit être écrite dans l'interface** : l'app n'emprunte ce chemin
qu'après un **échec réseau ou timeout** à l'échange de clés, et seulement sur une session en cache.
Autrement dit, **elle ne nous cherchera que si la vraie machine lui est déjà injoignable**. Si le
téléphone atteint la machine directement, il ne posera jamais la question, et le proxy restera
invisible. La redirection réseau (bail statique, DNS local, règle de pare-feu) reste le repli à
documenter — hors produit.

> ⚠️ Deux fragilités de l'app à **ne pas reproduire** : elle apparie la réponse par une recherche de
> sous-chaîne sur le rendu texte du message entier, et extrait l'IP en découpant après le premier
> `/`. On décode l'enregistrement A. Nous n'avons aucune raison d'hériter de ça.

### 5.2 Relais complet, à travers la file de tâches

Les commandes des applications **atteignent réellement la machine**, et elles entrent dans
`src/lib/tasks.mjs` comme n'importe quelle autre.

C'est le choix qui donne son sens au reste : la file existe précisément parce que la machine ne sert
**qu'une commande par visite**, et qu'un travail écrasé disparaissait sans trace. Trois téléphones
qui commandent en même temps sont exactement le cas qu'elle sait traiter — un seul ordre en vol,
insertion par rang, préemption à la frontière d'un pas, et rien qui s'évapore.

Une commande venue d'une app entre au rang **`COMMANDE`**, comme celle de l'interface web : elles
ont la même nature — elles agissent sur l'appareil — et rien ne justifie qu'un téléphone passe
devant un navigateur ou l'inverse. Une lecture demandée par une app entre en `LECTURE`.

## 6. Architecture

### 6.1 Le proxy termine les deux côtés — il ne tunnelise rien

**Conséquence directe du chiffrement, et elle décide de tout le reste.** Chaque session LAN porte un
flux AES-CBC **persistant** : le chiffreur n'est jamais réinitialisé, chaque bloc dépend de tous les
précédents. Deux sessions ont donc deux flux indépendants et désynchronisés par construction.

**Il est donc impossible de faire suivre des octets.** Le proxy doit déchiffrer entièrement ce qui
vient d'un côté et **rechiffrer** vers l'autre, session par session.

Ce n'est pas une contrainte, c'est un cadeau : nous parlons déjà le niveau **propriété Ayla**, nous
décodons déjà les trames ECAM, et nous savons déjà quelle propriété porte quoi. Le relais se fait au
niveau sémantique, pas au niveau octet — donc il est inspectable, journalisable, et il peut refuser
ce qu'il ne comprend pas.

### 6.2 Les deux moitiés

```
                    ┌─────────────────── lan-server ───────────────────┐
                    │                                                  │
  app A ◄──────────►│  côté APPAREIL          │        côté CLIENT     │◄────────► machine
  app B ◄──────────►│  (nouveau)              │        (existe)        │
  app C ◄──────────►│                         │                        │
                    │  N sessions             │        1 session       │
                    └──────────────────────────────────────────────────┘
                                        file de tâches
```

**Côté client — existe déjà, ne bouge pas.** `local_reg` vers la machine, service de
`/local_lan/*`, sessions, file, décodage. Rien à refaire.

**Côté appareil — à écrire.** Le miroir exact :

| Ce que lan-server doit servir | Rôle |
|---|---|
| `POST /local_reg.json` | une app s'annonce → on ouvre une session pour elle |
| `PUT /local_reg.json` | elle rafraîchit → on note son `notify` |
| `DELETE /local_reg.json` | elle s'en va → on ferme sa session |
| `GET /regtoken.json` | on répond le **vrai DSN** dans `host_symname` |

| Ce que lan-server doit émettre, **vers chaque app** | Rôle |
|---|---|
| `POST <app>/local_lan/key_exchange.json` | on ouvre la session, avec le `key_id` de la machine |
| `GET <app>/local_lan/commands.json` | on va chercher ce que l'app veut faire |
| `POST <app>/local_lan/property/datapoint.json` | on lui pousse l'état |
| `POST <app>/local_lan/property/datapoint/ack.json` | on accuse réception |

> Deux pièges déjà payés du côté client, à ne pas repayer : la réponse `time_2` de l'échange de clés
> doit être un **nombre JSON** et non une chaîne, et le `time_1` reçu doit être lu sur le **corps
> brut** pour ne pas perdre de précision. Ils valent dans les deux sens.

### 6.3 Multiplexage — ce qui se duplique et ce qui ne se duplique pas

**Par application** : session (aléas, clés dérivées, flux AES), `cmdId`, file de commandes en
attente, drapeau `notify`, adresse annoncée, date du dernier contact.

**Unique, partagé** : la machine, sa session, la file de tâches, le cache de lecture, le journal.

**Diffusion de l'état.** Un datapoint reçu de la machine est **rechiffré et poussé à chaque app
connectée**, plus l'interface web par SSE. C'est le cœur du multiplexage : la machine ne parle
qu'une fois, tout le monde entend.

**Entonnoir des commandes.** Une commande reçue d'une app devient une **tâche**. Elle n'atteint la
machine que par la file, donc jamais deux à la fois. Le résultat suit le chemin inverse : diffusé à
tous, y compris aux apps qui n'ont rien demandé — ce qui est correct, l'état de la machine ne
leur appartient pas.

### 6.4 Cycle de vie d'une session app

1. L'app émet une requête mDNS pour `<DSN>.local` ; on répond notre IP.
2. Elle `POST /local_reg.json` avec `{ip, port, uri: "/local_lan", notify}`.
3. On enregistre l'app et on lui `POST /local_lan/key_exchange.json`.
4. La session est établie ; on peut lui pousser des datapoints et lire ses commandes.
5. `PUT` périodiques ; le `notify` à 1 signifie « j'ai des commandes en attente ».
6. Fin : `DELETE`, ou silence prolongé → on ferme et on libère.

**Une app muette doit être expirée**, sinon on rechiffre indéfiniment vers un téléphone parti. Même
principe que le coupe-circuit existant : pas de contact pendant un délai ⇒ session close, dit dans
le journal.

## 7. Ce qu'il faut vérifier d'abord

**7.1 est faite, et elle confirme la prémisse** (résultat ci-dessous). Les deux autres restent à
faire ; elles sont bon marché et sans risque pour l'appareil.

### 7.1 Le créneau est-il vraiment unique ? — 2 minutes

Lancer lan-server, vérifier que les `local_reg` sont honorés (202, la machine se connecte), puis
**ouvrir l'app officielle** sur le même réseau et regarder le journal.

- Si nos `local_reg` cessent d'être suivis d'une connexion entrante ⇒ **créneau unique confirmé**,
  la fonctionnalité a une raison d'être.
- Si les deux continuent d'être servis ⇒ **la prémisse tombe**, et la moitié de ce document avec
  elle. Il faudra alors se demander à quoi sert le proxy.

**Fait le 2026-08-22 — créneau unique CONFIRMÉ.** Avec l'app officielle ouverte, nos tâches
« Présence » échouent : `0 sur 2`, repliées `×4`, motif « sans réponse ». Nos `local_reg` partent
et sont acceptés, mais la machine ne se connecte plus **à nous** — elle est allée chez l'app. À la
fermeture de l'app, et après un délai, lan-server **reprend** le pilotage sans rien faire de
particulier.

Trois choses tombent de cette seule observation, et aucune n'était acquise :

1. **La prémisse tient.** Le créneau est unique, l'éviction est réelle, et la fonctionnalité a une
   raison d'être. Ce n'était plus une inférence à partir du singulier de la ressource.
2. **L'éviction est silencieuse *côté machine*, pas côté nous.** La machine ne nous dit rien ;
   c'est le coupe-circuit muet (`DELAIS.muet`) qui la déclare absente au bout de 25 s. Le symptôme
   d'un conflit d'application est donc *exactement* celui d'une machine éteinte ou injoignable —
   ce qui, avant cette mesure, se diagnostiquait mal.
3. **Le retour est automatique.** Notre `local_reg` toutes les 2,5 s reprend le créneau dès que
   l'app le libère : rien à redémarrer. Le `DELETE local_reg.json` de `DeleteSessionCommand`
   n'est probablement pas la seule voie — un simple abandon suffit.

⚠️ **Conséquence pour le journal, indépendante du proxy :** le motif « muette » devrait mentionner
cette cause. Aujourd'hui il oriente vers le chemin de retour réseau, ce qui est le coupable
habituel — mais « une application officielle a pris le créneau » produit le même symptôme et se
répare autrement (fermer l'app).

### 7.2 Le multicast franchit-il le VLAN ? — 5 minutes

La machine est sur `VLAN_IOT`, le serveur ailleurs. Le mDNS est du multicast lien-local
(`224.0.0.251`, `TTL = 2`) : il ne franchit pas un routeur sans relais.

Vérifier depuis l'hôte lan-server qu'une requête mDNS atteint **le segment où vivent les
téléphones** — c'est là que ça compte, pas vers la machine. Si les téléphones sont sur le réseau
domestique et lan-server aussi, c'est acquis ; sinon, la redirection réseau devient la seule voie.

### 7.3 L'app accepte-t-elle un pair qui n'est pas la machine ? — le vrai risque

Rien ne dit qu'elle ne vérifie pas autre chose. Test le moins cher : **répondre à la requête mDNS
avec notre IP et servir un `regtoken.json` portant le vrai DSN**, sans implémenter le reste, puis
regarder si elle nous envoie un `local_reg`. Un `POST /local_reg.json` reçu vaut preuve que la
supercherie tient jusque-là.

Il faudra pour cela **provoquer le chemin d'échec** (§5.1) : couper l'accès du téléphone à
`IP_MACHINE`, sans quoi l'app ne cherchera jamais.

## 8. Sécurité

**Cette fonctionnalité fabrique une usurpation d'identité sur le réseau local.** Elle est légitime —
c'est ta machine, ton compte, tes téléphones — mais elle mérite d'être posée franchement.

- **Le répondeur mDNS ment à tout le réseau local**, pas seulement à tes applications. N'importe
  quel appareil demandant `<DSN>.local` recevra notre adresse. Il ne doit **répondre que pour les
  DSN des machines enregistrées**, jamais servir de répondeur générique.
- **Il doit pouvoir être désactivé**, et l'être **par défaut**. Une fonctionnalité qui détourne du
  trafic ne s'active pas toute seule.
- **Nous acceptons des sessions chiffrées entrantes.** Aujourd'hui lan-server ne parle qu'à une
  machine dont il connaît l'adresse ; demain il accepte des pairs qui se présentent. L'échange de
  clés authentifie — quiconque n'a pas la clé LAN échoue — mais la surface s'élargit, et le
  `key_id` circule en clair.
- **Aucun secret nouveau n'est stocké.** Le proxy n'a besoin de rien de plus que ce que lan-server
  détient déjà. À écrire noir sur blanc dans le code : une session app ne doit **jamais** faire
  écrire la clé LAN ni un jeton ailleurs.
- **Le journal doit nommer les apps** (adresse, date de connexion). Savoir qui est branché sur sa
  cafetière n'est pas un luxe.

## 9. Risques et modes d'échec

| Risque | Conséquence | Traitement |
|---|---|---|
| Le créneau n'est pas unique (§7.1) | La fonctionnalité n'a pas d'objet | Mesurer **avant** d'écrire |
| L'app ne passe jamais par mDNS | Le proxy reste invisible | Le dire dans l'interface ; documenter la redirection réseau |
| L'app vérifie autre chose que la clé | L'usurpation échoue | Test §7.3 avant tout développement |
| Le téléphone dort | Sa session meurt | Expiration, reconnexion à la réouverture |
| Une app pousse une écriture persistante | Recette écrasée sur l'appareil | Journaliser ; envisager un accord explicite |
| Deux machines derrière la même adresse | Indistinguables | Limite existante, inchangée |
| Le proxy divergerait de la vraie machine | L'app croit un état faux | Ne jamais **fabriquer** un datapoint : relayer ou se taire |

**La dernière ligne est une règle, pas une précaution.** Le proxy ne doit jamais inventer une
réponse pour satisfaire une app. S'il ne sait pas, il ne répond pas — comme le reste de ce projet.

## 10. Non-objectifs

- **Affranchir les applications du cloud.** Elles continueront d'avoir besoin d'un compte, d'une
  session Ayla et du dossier appareil. Le mode LAN est un accélérateur, pas un remplacement.
- **Faire tourner ça hors du réseau local.** Le mDNS est lien-local ; le mode LAN aussi.
- **Prendre en charge un modèle Striker.** L'autre génération n'est pas portée ailleurs, elle ne le
  sera pas ici.
- **Servir des applications tierces.** L'objet est l'app De'Longhi officielle sur plusieurs
  téléphones.

## 11. Découpage proposé

| # | Étape | Sortie | Dépend de |
|---|---|---|---|
| 0 | **Les trois mesures du §7** | Un compte rendu, et un feu vert ou rouge | — |
| 1 | Répondeur mDNS pour les DSN connus | L'app nous trouve | 0 |
| 2 | `regtoken.json` + `local_reg.json` côté appareil | L'app s'annonce, on l'enregistre | 1 |
| 3 | Échange de clés en rôle appareil | Une session app établie | 2 |
| 4 | Diffusion des datapoints vers N apps | L'app voit l'état réel | 3 |
| 5 | Commandes des apps → file de tâches | L'app pilote réellement | 4 |
| 6 | Expiration, journal, page de supervision | On voit qui est branché | 5 |

**L'étape 0 peut tout annuler, et c'est sa fonction.** Les étapes 1 à 3 forment le premier palier
qui vaut la peine d'être atteint : si une app établit une session chiffrée avec nous en croyant
parler à la cafetière, le plus incertain est derrière.

## 12. Question ouverte

**Que doit voir l'utilisateur ?** Une page qui liste les applications connectées, avec leur adresse
et leur activité, semble nécessaire — mais elle n'a de sens qu'une fois l'étape 4 atteinte, et sa
forme dépend de ce que les mesures du §7 auront appris. À trancher plus tard, pas maintenant.

## 13. L'inférence est fermée — deux vraies applications, 2026-08-22 19:38

Le § 4 portait quatre inférences, dont celle-ci : **une vraie application De'Longhi
acceptera-t-elle de nous parler ?** `faux-app.mjs` ne pouvait pas y répondre — il vérifie ce que
nous avons compris du protocole, pas ce que l'application vérifie, elle.

Elle accepte. Et à deux.

```
19:32:32  IN  a1  IP_TEL_A s'annonce · Android 17, Pixel 7 Pro
19:32:32  OUT a1  session établie
19:38:21  IN  a2  IP_TEL_B s'annonce · Android 16, SM-X820
19:38:21  OUT a2  session établie
…
19:38:55  OUT a1  état rediffusé · sélection de profil (0xa9)
19:38:55  OUT a2  état rediffusé · sélection de profil (0xa9)
19:38:56  OUT a1  état rediffusé · réponse ECAM · sélection de profil (0xa9)
19:38:56  OUT a2  état rediffusé · réponse ECAM · sélection de profil (0xa9)
```

> ⚠️ **C'est l'affirmation centrale du multiplexeur, et elle tient : une lecture réelle sur la
> cafetière, N destinataires.** Deux applications officielles, deux versions d'Android
> différentes, sur un appareil dont le créneau local vaut exactement un (§ 7.1). Chaque état part
> deux fois, chacun dans son propre flux AES persistant — aucun bloc illisible, aucun ré-échange
> de clés.

### Ce qui reste ouvert, et ce n'est plus le protocole

**Le répondeur mDNS (étape 1) n'est toujours pas écrit.** Les deux applications ci-dessus ne nous
ont pas trouvés toutes seules : elles sont arrivées par un **binat** du pare-feu, qui réécrit
l'adresse de la cafetière en port 80 vers celle du serveur. Relevé côté pare-feu, même paquet,
deux lignes :

```
binat  in IF_LAN_TEL  IP_TEL_A:55120 -> IP_MACHINE:80
                IP_TEL_A:55120 -> IP_SERVEUR:80
```

C'est une réponse de déploiement, pas de protocole — elle marche, elle est transparente pour
l'application, et elle a l'avantage de ne rien annoncer sur le réseau. Elle a aussi un piège que
cette session a payé : **une règle de filtrage écrite pour le réseau des téléphones voit la
destination APRÈS traduction.** Une règle « bloquer ce pool vers le réseau de la cafetière » ne
verra jamais ce trafic — il ne porte plus cette adresse à ce moment-là — tandis qu'une règle trop
large coupe le trafic déjà redirigé vers le serveur, et le symptôme est un journal applicatif
vide : pas même un refus, puisque rien n'arrive.

### Les erreurs de démarrage du SDK, identifiées

Une application qui vient de s'annoncer répond quelques secondes en erreur avant d'être prête.
Aucune n'est un refus, toutes sont transitoires, et les tailles suffisent à les nommer :

| statut | taille | origine | sens |
|---|---|---|---|
| `404` | 15 o | `CommandHandler.get()`, texte brut | `No device found` — l'appareil ne lui est pas encore connu |
| `404` | 19 o | `CommandHandler.get()`, texte brut | `No LAN module found` — connu, module LAN pas encore attaché |
| `500` | 60 o | **routeur NanoHTTPD**, texte brut | `"Error: " + classe + " : " + message` — une exception dans un gestionnaire |

Le `500` mérite d'être distingué : ce n'est **pas** un corps d'erreur d'`AylaLanModule` (ils font
50, 34, 29 et 35 octets), c'est le routeur qui rattrape une exception. Autrement dit un plantage
chez l'application, pas un rejet de notre part.

Aucun de ces trois ne porte de charge chiffrée, donc `porteUneCharge()` laisse le flux AES
intact — ce qui est la règle juste (§ 7quinquies). Le prix à payer est que le corps, lisible tel
quel, est jeté avec : nommer l'exception demanderait de le journaliser sans le déchiffrer.

