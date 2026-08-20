# État du serveur LAN mode — 2026-08-19

## 🎉 SUCCÈS COMPLET end-to-end via `server.mjs` (2026-08-19 ~21:29)

Le pilotage local fonctionne **via l'architecture finale** (`node server.mjs`, port 3000) :
bouton « Allumer » de l'UI → la machine s'allume, confirmé visuellement ET par le monitor
qu'elle pousse en LAN (**état 0x04 veille → 0x00 ALLUMÉE**, progress lu en direct) et ses
`data_response` (`0xD0…`). Le programme se déroule (≈30 cycles sur 75 s) puis s'arrête proprement.

### Le dernier fix décisif
Retirer **`Connection: close`** de nos réponses HTTP. L'ESP32 enchaîne key_exchange →
commands.json sur la **même connexion keep-alive** ; `Connection: close` la coupait et il ne
passait jamais à commands.json (symptôme : `session active` mais `counter=0`). Garder uniquement
`Content-Type` + **`Content-Length` explicite**.

### Robustesse à connaître
La machine a des **transitoires** : juste après un réveil/extinction elle peut répondre
`socket hang up` ou `404` à `local_reg` pendant ~20-40 s. Si ça tombe pendant la fenêtre du
programme, la commande n'est pas livrée → réessayer quand elle s'est stabilisée. (À fiabiliser :
retries + fenêtre de programme plus longue.)

## La recette qui marche (validée en conditions réelles)

Reproduire exactement la séquence de l'app officielle :

1. **HTTP brut, pas Next.js**, pour les endpoints device-facing. Le client HTTP de l'ESP32
   (ADA 1.5.3) rejette le framing de Next (`fetch`/undici → 400 ; header `vary: rsc,…` de l'App
   Router). Il faut des réponses `node:http` avec **`Content-Length` explicite** + `Connection: close`.
2. **`device_connected` (unix-sec frais) servi EN PREMIER** (présence de l'app), puis la trame
   ECAM voulue, puis **présence soutenue** (SEND_PROFILE + refresh device_connected) pendant tout
   le boot (~60–75 s).
3. **Keep-alive rapide (2,5 s)** : re-`local_reg` en continu ; la machine fait un cycle complet
   (key_exchange → GET commands.json → applique) à chaque `local_reg`.
4. **Crypto** : dérivation **double HMAC-SHA256**, AES-256-CBC flux persistant, `lanip_key` en
   octets ASCII. Fonctionne **dans les deux sens** (on déchiffre les datapoints de la machine).
5. **Trame de réveil = turn-on** : `0D 07 84 0F 02 01 55 12` (+ ts). Identique à ce que l'app
   envoie (vérifié en logcat). ⚠️ ON = `…02 01`, OFF = `…01 01` (ne pas inverser).

Propriétés observées côté machine : `d302_monitor` (état), `data_response` (accusés/réponses ECAM
en `0xD0…`), `device_connected`, `data_request`.

## Architecture finale

- **`server.mjs`** (serveur Node personnalisé) : gère `/local_lan/*` et `/api/*` en HTTP brut
  (recette validée), et **délègue les pages UI à Next.js** (même process → état partagé).
  Lancer : `npm run build && npm start` (= `node server.mjs`).
- Les route handlers Next sous `src/app/local_lan/*` et `src/app/api/*` restent pour référence
  mais **ne sont pas utilisés en prod** (server.mjs intercepte ces chemins avant Next). Le problème
  du header `vary` de Next est ainsi contourné.
- UI : `/` (pilotage : allumer/éteindre/boissons + état live) et `/recipes` (config recettes).

## Séquence de réveil de l'app (référence terrain, logcat 20:56–20:57)

Voir `../docs/capture-reveil-app.txt`. Points clés :
- connexion → `device_connected = <unix sec>`
- tap réveil → `turnMachineOn` → `AylaDatapoint sent to SDK: 0d 07 84 0f 02 01 55 12`
- puis spam `0d 06 a9 f0 01` (SEND_PROFILE) pendant le boot

## Reste à finaliser

- **Démo end-to-end du `server.mjs`** : la logique est prouvée (via le script `debug-capture.mjs`
  qui a réveillé la machine), mais le round-trip via `server.mjs` n'a pas été bouclé car la
  machine était en état instable après un test intensif (`local_reg` → `socket hang up` puis
  `404`, regtoken qui change). **Laisser la machine se stabiliser** (quelques minutes au repos)
  puis retester `npm start` + bouton Allumer.
- **Fiabiliser** : espacer les commandes, gérer les `socket hang up`/`404` transitoires avec
  retries, allonger la fenêtre du programme si la machine tarde à répondre.
- **États du monitor** : 0x04 = veille, 0x00 = allumée ; cartographier les autres (préparation,
  alarmes) en capturant pendant une boisson.
- `debug-capture.mjs` (script de test/diagnostic) peut être retiré une fois `server.mjs` validé.

---

## Import du catalogue de boissons (2026-08-19, après le succès allumage/extinction)

Page dédiée **`/boissons`** + API `GET /api/beverages` / `POST /api/beverages/import`.

### Ce qui est acquis

- **Catalogue statique, 28 boissons**, exact pour cette machine : `src/lib/machine-model.json`
  (extrait de `assets/MachinesModels.json` de l'APK, entrée `product_code` 0132217055) et
  libellés/mapping dans `src/lib/beverages.mjs`. L'app officielle ne demande **jamais** la liste
  à la machine — elle la connaît par cette table.
- **Ids corrigés** : pas d'id 14 ni 17–21 ; thé = 22, verseuse = 23, cortado = 24,
  long black = 25, travel mug = 26, brew over ice = 27. L'ancienne table de
  `docs/commandes-cafe.md` était fausse (elle déduisait les ids de l'ordre des propriétés).
- **Deux formats de lecture élucidés et documentés** (`docs/commandes-cafe.md` §6) :
  `0xB0` = quadruplets `id, min, défaut, max` (parser `X()`), `0xA6` = paires `id, valeur`
  par profil (parser `u0()`). Décodeurs portés dans `beverages.mjs`.
- **Décodeur validé** sur la trame réelle `d001_rec_espresso` : parcours tombant pile sur le
  CRC, café 20/40/180 ml, arôme 0/4/5 — et les 7 paramètres trouvés sont exactement les 7
  `ingredients` déclarés par la table constructeur. Deux sources indépendantes concordantes.
- **Lecture 100 % locale** : `readPropertyCmd()` sert une commande Ayla
  `GET property.json?name=<prop>` dans `commands.json` (port de
  `AylaLanCommand.newGetPropertyCommand`) ; la machine POSTe la valeur sur
  `/local_lan/property/datapoint.json`, qu'on déchiffre déjà. Aucun cloud, aucun token.
- **`pnpm dev` passe désormais par `server.mjs --dev`** (Next en HMR, endpoints device-facing
  en HTTP brut). `next dev` seul contournait `server.mjs` et cassait le pilotage : conservé
  sous `pnpm dev:next-only` pour du travail purement UI.

### Pas encore fait

- **L'import n'a pas encore été exécuté contre la machine réelle** : le catalogue et les
  décodeurs sont en place et vérifiés hors ligne, mais le round-trip
  `POST /api/beverages/import` → 21 propriétés remontées reste à valider (bouton « Importer »
  de `/boissons`, machine réveillée). Vérifier aussi si elle répond aux lectures en veille.
- Propriétés par profil 2..5 : formule déduite du code, observée seulement pour le profil 1.
- Noms des recettes perso / profils (`0xAA` / `0xA4`, UTF-16BE, stride 22) non implémentés.
- Aucune boisson n'a encore été coulée via le serveur (bouton « Préparer » câblé, non testé).

## Import des profils (2026-08-19) — validé sur la machine

Page **`/profils`** + API `GET /api/profiles` / `POST /api/profiles/import`.
Import réel réussi : les 5 profils, leurs icônes, leurs ordres de favoris et les 6 noms de
recettes perso remontent correctement.

```
Profil 1  Profil A   icône 12   23 boissons (Bean Adapt, Espresso macchiato, Latte macchiato, …)
Profil 2  Profil B  icône  8   23 boissons (ordre différent)
Profil 3  Profil C     icône 17   23 boissons
Profil 4  Profil 4 icône  5   Perso 1 = « Recette A », Perso 2..6 = noms par défaut
Profil 5  Profil 5 icône 14
```

### Deux erreurs corrigées en cours de route

1. **Mauvais parser.** Un premier repérage concluait au parser `K0()` (stride 22, avec octet
   « mug »). C'est le chemin **Striker** ; le logcat de cette machine dit `isStriker = false`,
   donc c'est `J0()` / **stride 21** et les propriétés `d034`/`d035`/`d036`/`d037`. Les variantes
   Striker sont quand même interrogées : elles répondent vide et sont marquées « absente ».
2. **Décodeur trop strict.** Ma 1re version déduisait l'offset en exigeant que les entrées
   remplissent exactement le bloc → `d034` était rejeté (« 0 entrées, désaligné ») car il laisse
   **un octet résiduel**. La vraie règle, lue sur les trames : entrées à l'**offset 6**, nombre
   d'entrées donné par les **octets 4 et 5** (premier/dernier index), reste ignoré — comme la
   division entière de `J0()`. Détail dans `docs/commandes-cafe.md` §8.

Également : `POST /api/command {"action":"selectProfile","profileId":n}` (trame `0xA9`), et un
bouton « Activer » par profil. Non testé contre la machine.

## Divers (2026-08-19)

- Page `/` : bouton **« Arrêter la préparation »** global (0x83 mode STOPV2, ciblant la dernière
  boisson lancée). Les boutons d'arrêt par boisson ont été retirés — un seul suffit.
- Les deux recettes d'usine (Espresso, Cappuccino) ont été supprimées de `data/recipes.json` et
  le `SEED` du serveur est vide : le catalogue réel des 28 boissons est sur `/`.

### Sélecteur de profil sur `/` (2026-08-19)

Le choix du profil a quitté la carte d'import pour la carte « Machine », en haut, et affiche les
**noms réels** (« 1 — Profil A », « 2 — Profil B »…) avec un bouton « Activer sur la machine »
(trame `0xA9`). La page `/` ne fait que **lire** le cache de noms via `GET /api/profiles` ;
l'import des profils reste sur `/profils`. Un seul sélecteur pilote désormais à la fois les
réglages affichés et la cible de l'import.

### Page `/` épurée (2026-08-19)

- Le bloc « Importer les réglages depuis la machine » a été **retiré** de `/`. La lecture reste
  possible boisson par boisson (bouton « Lire » sur chaque carte, qui lit bornes + valeurs du
  profil courant) et l'endpoint `POST /api/beverages/import` accepte toujours un import complet.
  ⚠️ Il n'y a donc plus de bouton pour relire les 28 boissons d'un coup depuis l'UI.
- Le sélecteur de profil n'est plus une liste déroulante mais une **rangée de boutons nommés**
  (Profil A, Profil B, Profil C, …). Un clic bascule l'affichage **et** active le profil sur la machine
  (trame `0xA9`), sans confirmation : la trame est inoffensive et le clic est explicite. C'était
  la raison de ne pas activer sur une liste déroulante — la parcourir aurait envoyé une commande
  par valeur traversée.
- La progression de lecture et les messages sont remontés dans la carte « Machine ».

### Filtrage des profils non renommés (2026-08-19)

`GET /api/profiles` expose désormais un booléen `renamed` par profil : faux si le nom est celui
d'usine (motif `Profil <n>`, testé par `/^profil(e)?\s*\d+$/i`) ou pas encore lu. La page `/`
n'affiche que les profils renommés — ici **Profil A, Profil B, Profil C** ; « Profil 4 » et « Profil 5 »
sont masqués. La page `/profils` continue d'afficher les cinq, c'est elle qui sert au diagnostic.

Deux replis pour que le contrôle ne disparaisse jamais : noms pas encore lus → on affiche les
numéros avec un renvoi vers la page Profils ; machine sans aucun nom personnalisé → on affiche
tout en l'indiquant. Et si le profil sélectionné sort de la liste affichée, la sélection bascule
sur le premier affiché (simple changement d'affichage, rien n'est envoyé à la machine).

### Bug corrigé : la présence écrasait le profil choisi (2026-08-19)

**Symptôme** : cliquer « Profil C » laissait la machine sur « Profil A ».

**Cause** : la trame de « présence soutenue » du programme était `frameSendProfile(1)` — profil 1
**en dur**. Or `0xA9` n'est pas une trame neutre : c'est **la commande de sélection de profil**.
La séquence servie était donc `device_connected` → `0xA9 profil 3` → `0xA9 profil 1` ×N pendant
les 20 s du programme. La machine finissait sur le profil 1.

Cette trame avait été choisie pendant la mise au point du réveil, où elle jouait le rôle de
signal de présence de l'app — inoffensive tant qu'on ne visait que le profil 1.

**Correctif** : `S.activeProfile` (défaut 1) est positionné par `selectProfile` **et** par
`dispense` (qui cible aussi un profil), et la présence envoie `frameSendProfile(S.activeProfile)`.
Le libellé de log devient `sustain(profil n)` pour que la dérive soit visible.

**Vérifié** sur les trames servies : `0d 06 a9 f0 03` puis `sustain(profil 3)` répété.
Le même bug basculait la machine sur le profil 1 en pleine préparation lancée sur un autre profil.

`GET /api/status` expose désormais `activeProfile`, et la page `/` s'y aligne au chargement pour
ne pas afficher un profil actif faux après un rechargement.

### Ordre d'affichage par profil (2026-08-19)

Question posée : « activer un profil déclenche-t-il un import du profil pour garantir l'ordre
d'affichage ? » Réponse d'alors : **non**, et trois écarts sont apparus à la vérification :

1. `selectProfile` n'envoyait que la trame `0xA9`, sans rien relire.
2. **La page `/` n'utilisait pas du tout l'ordre de la machine** : elle groupait par catégories
   inventées par nous, identiques pour les 5 profils. Les ordres des 5 profils étaient pourtant
   en cache depuis l'import de `/profils` — personne ne s'en servait.
3. Seules les valeurs du profil 1 étaient en cache (les profils 2-5 n'avaient que leur ordre).

**Corrigé** :
- `GET /api/beverages?profile=n` renvoie `order` (ids dans l'ordre de la machine) + `orderProp`.
- `/` affiche « Dans l'ordre de la machine », suivi d'une section « Non listées par ce profil »
  pour les boissons absentes de l'ordre. Le regroupement par catégories reste le repli quand
  l'ordre n'a pas été lu, et l'UI dit laquelle des deux règles s'applique.
- Activer un profil **enchaîne** une relecture de sa propriété d'ordre : fenêtre de programme
  raccourcie à 10 s, puis la file de lecture s'écoule (une seule propriété).

**Vérifié de bout en bout** : `0xA9 profil 3` → `sustain(profil 3)` → `lecture d263_3_rec_priority`
→ ordre reçu, et la page affiche « Profil C » actif avec l'ordre du profil 3 (Bean Adapt › Espresso ›
Latte macchiato › Lait chaud …), différent de celui du profil 1.

Les **valeurs** par profil ne sont toujours pas relues à l'activation (21 propriétés, ~60 s) :
seul l'ordre l'est. Le bouton « Lire » de chaque carte reste le moyen d'obtenir les valeurs du
profil courant pour une boisson donnée.

### Sommes de contrôle 0xA3 — validation de cache (2026-08-19)

Question posée : « utilises-tu la somme de contrôle des quantités par profil pour optimiser les
échanges ? » Réponse d'alors : **non, pas du tout**. Implémenté depuis.

Trame réelle obtenue de la machine (20 octets), décodée du premier coup :

```
d0 13 a3 f0 | 7a 3f | 7a 3f | c0 57 | 7a 3f | 7a 3f | b4 31 | bc f4 | 08 1a
              prof1   prof2   prof3   prof4   prof5   perso    noms    crc
```

`size` déduit = 5 (formule `(len − 9) / 2`, il n'est pas dans la trame). **Le profil 3 se
distingue** (`0xc057` vs `0x7a3f` pour les quatre autres) : ses quantités diffèrent réellement,
les autres sont aux valeurs d'usine. La somme est donc bien discriminante.

- `POST /api/checksums` demande la trame ; `GET /api/checksums` renvoie sommes, précédentes,
  familles changées, et ce qui est périmé par rapport au dernier import.
- `POST /api/profiles/import` **saute la lecture des noms** si leur somme n'a pas bougé
  (`force:true` pour outrepasser). Les sommes ne couvrent pas l'ordre des favoris : lui est
  toujours relu.
- Format et sémantique documentés dans `docs/commandes-cafe.md` §9.

### Bug corrigé : la présence imposait un profil (2026-08-19)

En testant les sommes de contrôle, le log a montré `sustain(profil 1)` : **ma propre requête a
ramené la machine du profil 3 au profil 1**. Cause de fond : `0xA9` servait de battement de cœur
alors que c'est **la commande de sélection de profil**. Le correctif précédent (« envoyer
`S.activeProfile` au lieu de 1 en dur ») ne suffisait pas, puisque `activeProfile` retombe à 1 —
non confirmé — après un redémarrage du serveur.

**Correctif** : `startProgram(..., sustain)` prend par défaut une **demande de monitor**
`0D 05 75 0F`, qui est une lecture pure. `sustain: "profile"` ne subsiste que pour le réveil (où
le spam `0xA9` est la recette validée) et pour la sélection de profil (réaffirmer la même valeur
est idempotent). Voir `docs/commandes-cafe.md` §10.

### Page Recettes reconstruite sur les bornes du modèle (2026-08-19)

Les bornes `0xB0` sont des caractéristiques du **modèle**, communes aux 5 profils : un profil ne
peut que choisir une valeur à l'intérieur. La page les affiche et les impose.

- Elle avait sa **propre table de boissons, avec les anciens ids faux** (thé=16, cortado=18,
  brew over ice=21) et n'en listait que 18 : elle lit désormais `/api/beverages` (28 boissons,
  ids réels).
- Colonnes Min / Max / Défaut machine par paramètre, curseur + champ numérique bornés, bouton
  « défaut » pour revenir à la valeur d'usine. Saisie plafonnée (999 → 180 sur l'espresso, testé)
  et enregistrement bloqué si une valeur sort des bornes.
- Ne propose que les paramètres que la boisson déclare (`ingredients`) **et** dont la borne est
  exploitable — les emplacements non configurés (défaut 0 ou 255) sont écartés.
- Changer de boisson réinitialise aux défauts machine : garder les paramètres de la précédente
  produirait des valeurs hors bornes.
- Si les bornes d'une boisson n'ont pas été lues, la page le dit et renvoie vers le bouton
  « Lire » plutôt que d'inventer un intervalle.

### Page Système (2026-08-19)

Nouvelle page `/systeme`, alimentée par `GET /api/system`, qui mélange trois sources **étiquetées
comme telles** — c'est le point important : ne pas faire passer un relevé figé pour du temps réel.

1. **Lu en direct** : `GET http://<machine>/regtoken.json`. J'ai sondé 8 endpoints du module ;
   **seul celui-là répond** (HTTP 200) : `status.json`, `wifi_status.json`, `time.json`,
   `module_info.json`, `ota.json`, `lan_ota.json`, `wifi_scan.json` renvoient tous 404 — les
   endpoints de setup n'existent qu'en mode point d'accès. Réponse réelle :
   `{"regtoken":"09de31","registered":1,"registration_type":"AP-Mode","host_symname":"<DSN>"}`.
2. **Relevé cloud figé** : `src/lib/device-sheet.json`, extrait de `docs/materiel-et-firmware.md`.
   Champs non personnels uniquement — SSID, IP publique, géolocalisation, identifiants de compte et
   `setup_token` restent dans `docs/secrets.md`.
3. **Notre état protocole** : session, clé LAN, keepalive, profil actif, monitor, sommes de contrôle.

**OTA** — traité par la voie locale, qui est celle qui compte ici : en LAN mode c'est **la machine
qui vient chercher l'image chez nous** (`LanOTAHandler` sert `/ota_status.json` et le chemin de
l'image). Le serveur enregistre donc toute requête OTA reçue de la machine dans `S.otaRequests` et
répond 404 : zéro requête = aucun OTA en cours de distribution par nous. La vérification cloud
(`apiv1/dsns/<DSN>/ota.json`) est **optionnelle**, conditionnée à `AYLA_TOKEN` dans `.env.local`
(documenté dans `.env.local.example`) ; sans token la page affiche « désactivée » plutôt que de
prétendre qu'il n'y a pas de mise à jour. Le pilotage local ne doit jamais dépendre d'un token.

Firmware affiché avec son âge calculé (**6,4 ans** au moment de l'écriture) et les 6 constats de
sécurité du relevé, dont 4 en avertissement : firmware jamais mis à jour, SDK ESP-IDF 3.3.1 en fin
de vie, aucun TLS local (`enable_ssl: null`), `regtoken` lisible sans authentification avec
`registrable: true`.

### Personnalisation des recettes par profil (2026-08-19)

Question : « peut-on personnaliser les recettes par profil ? » **Oui, nativement** — et c'était
déjà à moitié en place sans l'être vraiment.

- **La machine le fait** : chaque profil a ses propres valeurs (`d039_1_rec_espresso`,
  `d060_2_rec_espresso`, …). Les sommes de contrôle `0xA3` l'ont prouvé : le profil 3 diffère
  (`0xc057`) des quatre autres (`0x7a3f`, valeurs d'usine).
- **Lecture** : `GET /api/beverages?profile=n` renvoie déjà `values` par boisson. La page Recettes
  recharge le catalogue quand le profil du brouillon change, affiche une colonne « Profil n » à
  côté de min/max/défaut, et a un bouton « Reprendre du profil ».
- **Écriture** — c'était le maillon manquant : `POST /api/command {"action":"saveToProfile", …}`
  envoie `0x83` en mode **DONTCARE (0)** avec l'action **SAVE_BEVERAGE (1)**, le profil visé étant
  encodé dans `(profileId << 2) | action`. Trame vérifiée hors ligne : espresso 40 ml / arôme 4
  vers le profil 3 → `0d 0d 83 f0 01 00 01 00 28 02 04 0d 15 86` (dernier octet `0x0D` = (3<<2)|1).
  Bouton « Écrire dans le profil n » avec confirmation détaillée : c'est une **écriture persistante**
  qui remplace la recette du profil sur la machine.
  La réponse renvoie la somme de contrôle du profil **avant** écriture, pour pouvoir vérifier
  qu'elle a bougé au lieu de supposer que l'envoi a suffi.

**Défaut corrigé au passage** : la préparation utilisait toujours `PREPARE_BEVERAGE (2)`, alors que
l'app choisit `PREPARE_BEVERAGE_INVERSION (6)` quand le paramètre `INVERSION (12)` vaut 1
(`RecipeData.T()`). Sur ce modèle c'est le cas du **flat white, cappuccino inversé, cortado et
long black** (bornes lues 1/1/1) : ces quatre boissons étaient donc lancées avec la mauvaise action.

**Non testé contre la machine** : l'écriture dans un profil n'a pas été déclenchée (elle modifie
durablement l'appareil), ni la préparation avec inversion.

### Détails de boisson éditables sur `/` (2026-08-19)

Le panneau « Détails » de chaque boisson n'est plus en lecture seule : il contient un éditeur de la
recette **du profil actif**, sous les bornes du modèle.

- Composant `RecipeEditor`, monté seulement à l'ouverture du panneau : son état repart donc des
  valeurs de la machine à chaque fois, sans logique de réinitialisation à écrire.
- Les valeurs partent de la recette enregistrée du profil si elle a été lue, sinon des défauts du
  modèle. Curseur + champ numérique bornés par min/max, bouton ↺ quand c'est modifié.
- Deux actions : « Préparer avec ces valeurs » (0x83 START) et « Écrire dans le profil n »
  (0x83 DONTCARE/SAVE_BEVERAGE, écriture persistante, avec confirmation détaillée).
- Le tableau complet des paramètres reste dessous, en référence.

**Piège traité** : un paramètre dont `min == max` n'est pas réglable — l'ordre lait/café d'un flat
white vaut toujours 1 — mais il **doit rester dans la trame**, puisque c'est lui qui fait choisir
l'action `PREPARE_BEVERAGE_INVERSION`. Il s'affiche donc en lecture seule (« 1 (imposé) ») et reste
dans le payload. La page Recettes, elle, l'excluait carrément via `isUsable` : son écriture aurait
produit une recette sans le drapeau d'inversion. Corrigé par un `payload()` qui rajoute les
paramètres imposés.

Vérifié dans le navigateur sur le flat white : 3 curseurs (café 20-180, arôme 0-5, lait 50-1080) et
« Ordre lait/café : 1 (imposé) ».

### Options masquées et infos techniques (2026-08-19)

Deux défauts signalés, tous deux réels.

**1. Des options réglables étaient masquées.** L'éditeur filtrait sur `kind === "user"` — une
classification que **j'avais inventée**, absente du protocole — et sur `isSet` (défaut dans les
bornes). Conséquences constatées :

| Boisson | Ce qui était caché |
|---|---|
| Espresso, tous | « 2 tasses » (0/0/1), « Index de longueur » (0/1/4) |
| Cappuccino | « Accessoire » |
| **Mug de voyage** | **Café (40/0/240), Lait (60/0/460), Eau chaude (50/0/260)** |

Le cas du mug est le pire : ces paramètres ont une vraie plage, mais leur **défaut vaut 0** (jamais
configuré), donc `isSet` les écartait — impossible d'y ajouter du lait. Même chose pour les 6
recettes perso vierges.

**Corrigé** : un paramètre est réglable si `max > min`, indépendamment du défaut. Valeur de départ =
valeur du profil si dans les bornes, sinon défaut s'il l'est, sinon **minimum**. `kind` ne sert plus
qu'à *grouper* : les réglages « avancés » (Programmable, Visible, Index de longueur, Mélange) sont
derrière un bouton, avec un avertissement — « Visible » retire la boisson de l'écran de la machine.
Un paramètre à valeur unique reste affiché « (imposé) » et dans la trame.

Les `kind` ont été revus dans `beverages.mjs` : « 2 tasses » et « Accessoire » passent de `meta` à
`user`, `meta` devient `advanced`, et le commentaire dit explicitement de **ne plus filtrer** sur ce
champ.

**2. Les infos techniques étaient noyées.** Elles sont désormais derrière un bouton **« ⓘ Infos
techniques »** dans le panneau de détails : tableau complet des paramètres (y compris ceux non
réglables), propriété de bornes, propriété du profil, et trame brute lue.

Vérifié dans le navigateur — cappuccino : 3 curseurs (café 20-180=65, arôme 0-5=3, lait 50-1080=170,
valeurs du profil 1), 2 paramètres imposés, 3 réglages avancés, panneau technique fonctionnel.
Mug de voyage : 5 curseurs dont le lait 60-460, là où il n'y en avait aucun.

### Nom des recettes perso non repris sur `/` (2026-08-19)

**Symptôme** : la recette perso 1 du profil Profil A s'appelle « Recette A » sur la machine, mais la
page Boissons affichait « Recette perso 1 ».

**Cause** : le nom était bien lu (`d036_recipe_custom_name_1_3` → « Recette A », visible sur
`/profils`), mais `/api/beverages` ignorait ce qui avait été lu et gardait le libellé statique du
catalogue. Deux endpoints lisaient les noms différemment — `/api/profiles` les aplatissait dans une
fonction locale, `/api/beverages` ne les regardait pas du tout.

**Correctif** : extraction d'un helper partagé `readNames(store, kind)` + `machineBeverageNames()`,
utilisé par **les deux** endpoints. `/api/beverages` remplace désormais le libellé par le nom lu sur
la machine et expose `catalogLabel`, `machineName`, `machineNameProp` et `icon` pour garder la
traçabilité de l'origine du nom.

Vérifié : « Recette A » s'affiche en 5ᵉ position de l'ordre du profil 1 (id 230, conforme à
`200,11,8,1,230,…`), et les emplacements non renommés portent leurs noms d'usine machine
(« Perso 2 »… au lieu de « Recette perso 2 »…).

**Pas couvert** : le nom du Bean System (id 200) reste le libellé du catalogue. Il ne vient pas des
propriétés de noms de recettes mais des données Bean System (`0xBA`, nom UTF-16 de 40 octets, ou
`d251_beansystem_1`), qui ne sont pas encore lues.

### Internationalisation (2026-08-19)

**next-intl 4.13** installé, français seul pour l'instant. 122 chaînes extraites des 5 pages vers
`messages/fr.json` ; typecheck et build de production verts, aucune clé manquante sur les 5 pages
(vérifié en cherchant `MISSING_MESSAGE` dans le HTML rendu).

Choix structurants :

- **Pas de segment de locale dans l'URL.** `server.mjs` intercepte `/api/*` et `/local_lan/*` avant
  Next ; un segment `[locale]` déplacerait toutes les pages (`/fr/profils`…) sans rien apporter tant
  qu'il n'y a qu'une langue. Le point d'extension est `src/i18n/request.ts` (cookie ou
  `Accept-Language`), qui ne touche pas aux pages.
- **Rien de traduisible ne traverse l'API.** Le serveur envoie des identifiants de protocole —
  `slug` pour une boisson, `name` (énum ECAM) pour un paramètre — et le client traduit via
  `src/i18n/labels.ts`, avec repli sur le libellé serveur si la clé manque. Un **nom saisi sur la
  machine** (« Recette A », « Grain A ») n'est jamais traduit : c'est une donnée utilisateur.
- Les libellés français restés dans `beverages.mjs` / `profiles.mjs` servent au **log terminal**.

Deux incidents de parcours :

1. `pnpm dev` a cessé de démarrer : pnpm 11 exige une décision explicite pour les paquets à script
   d'installation, et le contrôle de dépendances sortait en erreur. Réglé dans `pnpm-workspace.yaml`
   (`allowBuilds` à `false` pour `@parcel/watcher` et `@swc/core` — ils embarquent des binaires
   précompilés et le projet fonctionnait déjà sans).
2. Le refactor de `handleProperty` avait **supprimé quatre fonctions** qui vivaient entre les deux
   marqueurs du remplacement (`probeRegtoken`, `probeCloudOta`, `diffChecksums`,
   `staleFromChecksums`) — `/api/system` renvoyait `probeRegtoken is not defined`. Restaurées.
   Leçon : remplacer une plage entre deux marqueurs sans vérifier ce qu'elle contient.

Reste non traduit (assumé) : les messages de log du serveur, et les `label` renvoyés par
`/api/command` que quelques messages d'état réaffichent tels quels.

### Propagation de l'état à l'ouverture d'une page (2026-08-20)

Demande : à l'ouverture de la page Boissons, déclencher `local_reg` pour propager l'état
marche/veille **et** le profil actif de la machine.

**État marche/veille : fait.** `POST /api/presence` s'annonce puis sert une demande de monitor
(`0D 05 75 0F`, lecture pure) ; la machine se connecte et pousse son état. La page l'appelle au
montage **et au retour sur l'onglet** (`visibilitychange`). L'endpoint est **étranglé côté serveur** —
monitor de moins de 30 s, programme déjà en cours, ou appel de moins de 15 s — donc plusieurs onglets
ne provoquent pas plusieurs sessions ni de martèlement de la machine.

**Profil actif : la machine ne l'expose pas.** Vérifié, pas supposé :
- `d286_mach_sett_profile` → **aucune réponse** de la machine (la propriété n'existe pas ici).
  `d281_mach_sett_temperature` non plus. En revanche `d270_serialnumber` répond (trame `0xA1`
  contenant le numéro en ASCII), donc le mécanisme de lecture est bon — c'est bien la propriété
  qui est absente.
- L'app officielle **ne le lit pas davantage** : `EcamMachine.B()` renvoie un champ local initialisé
  à 1, et aucun appelant hors de la classe ne l'écrit depuis une trame machine. Elle impose sa propre
  notion, exactement comme notre serveur.

Faute de pouvoir l'observer, le profil actif est désormais **persisté** dans
`data/machine-beverages.json` et restauré au démarrage (avec son drapeau `confirmed`) : un
redémarrage du serveur ne prétend plus « profil 1 ». Vérifié : profil 3 imposé → redémarrage →
`profil actif restauré : 3`, `confirmed: true`, et la page surligne « Profil C ».

Nouvel outil au passage : `POST /api/read {"props":[…]}` lit des propriétés Ayla arbitraires — c'est
ce qui a permis de trancher la question ci-dessus.

**Nouvel état monitor non cartographié : `0x02`** (progress 256), observé de façon stable. Connus :
`0x00` = allumée, `0x04` = veille. La page affiche donc « État inconnu — monitor 0x02 » plutôt que de
deviner. À confirmer en regardant l'écran de la machine pendant que le monitor vaut 0x02.

### Monitor élucidé : capteurs et états (2026-08-20)

L'écran de la machine (« liste des boissons, prête, carafe connectée ») a permis de trancher.

**Mon champ « progress » était une erreur.** Les octets 5-6 du monitor sont un **champ de bits de
capteurs** (`MonitorDataV2.g()` / énum `p127m6/p` : octet = 5 + groupe, bit = position). La valeur
256 relevée signifiait « groupe 1, bit 0 » = **carafe à lait connectée**. Le serveur décode
désormais les 13 capteurs, plus le champ d'**alarmes** 32 bits (octets 7, 8, 12, 13) qui existait
sans être lu. Log réel : `monitor: état=0x02 · carafe à lait · alarmes 0x8`.

**États (octet 4)** : `0x04` veille (confirmé), `0x02` prête (confirmé par l'écran), `0x00` en
chauffe (déduit, relevé juste après un réveil). La logique passe de « allumée si 0x00 » à
**« éveillée sauf 0x04 »** : l'ancienne liste blanche affichait « état inconnu » alors que la
machine était prête. La page affiche maintenant « Prête », toggle allumé, et deux pastilles
« carafe à lait » et « alarmes 0x8 ».

**Alarme 0x8 (bit 3) non cartographiée** — signalée telle quelle plutôt que masquée.

**Présence intermittente** : la machine ne pousse pas toujours son monitor à la première session.
Une relance unique 10 s après (bornée, pas de boucle) suffit en pratique ; l'étranglement serveur
est passé à 8 s pour la laisser passer. La relance consulte l'état via une `ref`, sinon la fermeture
capturait un `status` nul au montage et relançait systématiquement.

### Alarmes nommées, sur /pilotage (2026-08-20)

Libellés trouvés dans l'APK : énum `p127m6/l`, et surtout sa méthode `a(int)` qui mappe l'index de
bit vers l'alarme — **elle fait autorité sur les couples (groupe, bit) déclarés dans l'énum**, car
plusieurs index y sont explicitement `IGNORE_ALARM` sur cette génération (7, 10, 13, 16, 20, 21, 23,
24, 26-31). S'être fié aux tuples aurait donné de faux noms.

18 alarmes nommées, traduites dans `messages/fr.json` (`alarm.*`), documentées dans
`docs/commandes-cafe.md` §11.3. Les bits non répertoriés sont remontés marqués « non répertoriée »
au lieu d'être cachés ou mal nommés.

**Ta machine signale `0x00000008` → bit 3 → `REPLACE_WATER_FILTER`** — « Remplacer le filtre à eau ».

La page `/pilotage` gagne deux sections : **Alarmes** (libellé, bit, champ brut) et **Capteurs**
(pastilles). Au passage, elle affichait encore `progress` — le champ qui n'existe pas — et une liste
blanche d'états qui disait « 0x2 » au lieu de « Prête ». Corrigé : elle affiche « 🟢 Prête ».

### Page Bean Adapt (2026-08-20)

Nouvelle page `/bean-adapt`. Elle fait les trois choses de la fonction officielle, **sans le cloud**.

**1. Lecture des profils** (`0xBA`) : ta machine a deux entrees —
`index 0 « Bean Adapt (ON/OFF) »` (l'interrupteur, pas un profil de cafe, marque comme tel) et
`index 1 « Grain A »` (mouture 3, temperature 3, arome 4), liee a la boisson 200.

**2. L'assistant — la vraie fonction Bean Adapt.** L'app officielle envoie le questionnaire au
backend De'Longhi qui renvoie les reglages ; `docs/bean-adapt.md` §4 avait derive la regle par
balayage de cette API. Elle est maintenant **rejouee localement** dans `src/lib/bean-adapt.mjs`, et
verifiee contre la matrice de reference du doc : **9/9 conformes**.

Trois questions (temps d'ecoulement, aspect de la crema, gout) -> ajustements, avec explication de
chaque decision. Le raisonnement est celui d'un barista : l'ecoulement est le symptome, la mouture le
correctif, et le gout n'est pris en compte que dans la fenetre 10-19 s.

Deux ecarts assumes avec le backend, tous deux en notre faveur, et signales dans l'UI :
- il **echoue** sur « ecoulement correct + gout neutre » (cas pourtant nominal) ; nous renvoyons les
  valeurs inchangees ;
- il ne borne pas la temperature vers le haut ; on plafonne a 5 **par prudence**, en gardant 0 comme
  plancher pour rester conforme a la matrice. Une premiere version avait mis le plancher a 1 : elle
  divergeait du doc (t0 attendu, t1 obtenu). Corrige — ne pas « ranger » ce 0.

**3. Ecriture** (`0xBB`, 52 octets) : nom (20 caracteres, UTF-16BE sur 40 octets), mouture,
temperature, arome, visible. Trame verifiee hors ligne contre le format du doc, offsets exacts. La
**suppression est la meme trame avec `visible = 0`** — exposee par un bouton distinct.
Plus l'activation d'un Bean System (`0xB9`).

Bornes : mouture 1-7 et arome 1-5 sont verifiees cote backend ; la temperature n'a **aucune** borne
connue, l'UI l'affiche « bornes non verifiees » plutot que de faire passer notre prudence pour une
verite protocole.

**Non teste contre la machine** : l'ecriture `0xBB` et l'activation `0xB9` — les deux modifient
l'appareil. La lecture, la simulation et le rendu le sont.

### Liste des grains et grain actif (2026-08-20)

Tu as signale une liste de grains dont un seul actif (« Bonifleur »). Je n'avais lu que les index 0
et 1 : il y en a **six**.

| Index | Nom | Mouture | Temp. | Arome | |
|---:|---|---:|---:|---:|---|
| 0 | Bean Adapt (ON/OFF) | 4 | 1 | 0 | interrupteur |
| 1 | Grain A | 3 | 3 | 4 | |
| 2 | Grain B | 4 | 3 | 4 | |
| 3 | Grain C | 3 | 3 | 4 | |
| 4 | **Grain D** | 4 | 2 | 5 | **actif** |
| 5 | Grain E | 4 | 1 | 3 | |

(La machine ecrit « Grain D », sans « l ».)

**Deux decouvertes de protocole, ancrees sur ton observation.**

1. **L'octet 50 de la trame `0xBA` est le grain actif.** Il ne vaut 1 que pour l'index 4, et c'est
   celui que tu decris comme actif. Cela explique aussi l'ecart de taille entre la lecture
   (53 octets) et l'ecriture (52) : l'octet supplementaire est ce drapeau, donc **`0xBB` ne peut pas
   designer le grain actif** - c'est le role de `0xB9`. L'octet 49, lui, est « non supprime ».

2. **La propriete `d(250+n)_beansystem_n` n'a de valeur qu'apres la commande `0xBA`.** Lire la
   propriete seule ne renvoie rien : mon premier essai sur `d252`..`d256` est revenu vide, ce qui
   m'a fait croire que les profils n'existaient pas. Envoyer `0xBA` index 2 a fait apparaitre
   `d252_beansystem_2`. Il faut donc une commande par grain.

D'ou un nouvel endpoint `POST /api/beanadapt/scan` qui enchaine les six commandes (~65 s) et un
bouton « Lire toute la liste » sur la page, avec suivi pendant le remplissage. La page marque le
grain actif d'une pastille et desactive son bouton (« Deja actif »).

### Confusion corrigee : nom de grain vs nom de boisson (2026-08-20)

**Ma faute.** En branchant la lecture `0xBA`, j'avais ajoute dans `machineBeverageNames()` une
correspondance « bean system n -> boisson 199 + n », puis utilise le nom lu comme **libelle de la
boisson**. Or ce sont deux natures differentes :

| Objet | Ce que c'est | Nom |
|---|---|---|
| Bean System 1 | une **configuration de grains** (mouture 3, temp 3, arome 4) | « Grain A » — la marque du cafe |
| Boisson 200 | l'**espresso prepare** avec la configuration active | pas « Grain A » |

Comme l'ordre du profil Jerome commence par l'id 200, la premiere carte de la page s'appelait
« Grain A ». Le nom du grain avait ecrase celui de la tasse.

**Corrige** : `machineBeverageNames()` ne traite plus que les recettes personnalisees (230-235), qui
sont bien des noms de boisson. La configuration de grains devient un **attribut** :
`activeBeanSystem()` expose le grain **actif** (octet 50), attache a la boisson 200 sous
`beanSystem`, affiche en pastille « Bean Adapt : Grain D » avec mouture/temp/arome en infobulle.

Noter que l'attribut expose le grain **actif** (Grain D), pas le bean system 1 (Grain A) : c'est
la configuration selectionnee qui determine la tasse.

J'ai aussi retire de `/api/beanadapt` le champ `beverageId: 199 + index` — ce lien etait specule. La
table constructeur ne declare qu'**une** boisson Bean System (id 200, nom d'usine « Espresso BS 1 »),
alors que l'enum `p127m6/a` prevoit `BEAN_01(200)..BEAN_06(205)`. Rien ne permet d'affirmer que
chaque configuration a sa propre boisson sur ce modele.

**Reste incertain : le nom d'affichage de la boisson 200.** Je l'ai laisse a « Espresso Bean Adapt ».
Dans un message precedent j'ai affirme qu'elle s'appelait « Espresso Soul » sur la machine, en me
fondant sur la methode `loadEspressoSoul` du logcat — c'est en realite un **chargeur de modele**
(la gamme Primadonna Soul), pas un nom de boisson. Affirmation non fondee, a confirmer sur l'ecran.

### Retour aux valeurs par defaut dans l'editeur de recette (2026-08-20)

Demande : pouvoir remettre les valeurs par defaut sur chaque boisson, depuis la page Boissons.

L'editeur avait deja un « reinitialiser », mais il revenait au **point de depart** : la valeur
enregistree du profil. Ce n'est pas la meme chose qu'un defaut d'usine. Les deux coexistent
maintenant, avec des libelles distincts :

| Bouton | Ramene a |
|---|---|
| `↺ reinitialiser` (si modifie) | la valeur enregistree du profil sur la machine |
| `⟲ valeurs par defaut` | le defaut du **modele** (table constructeur `machine-model.json`) |
| `defaut N` (par ligne) | le defaut du modele, pour ce seul parametre |

**Le cas des parametres sans defaut utilisable.** La table constructeur donne `def = 0` pour des
parametres jamais configures - cafe, lait et eau chaude du mug de voyage - alors que leurs bornes
sont 40-240, 60-460 et 50-260. Il n'y a donc aucune valeur d'usine a proposer. Plutot que de les
forcer au minimum (ce qui inventerait une valeur), la ligne affiche « pas de defaut » et le bouton
global les laisse telles quelles ; son infobulle annonce combien de parametres sont dans ce cas.

Verifie dans le navigateur : Espresso (arome 5 -> 4, cafe deja a 40, retour arriere par
« reinitialiser » -> 5), et Mug de voyage (arome et ordre lait/cafe avec defaut, les trois
quantites marquees « pas de defaut »).

Aucune ecriture machine : ces boutons ne touchent que l'etat local du formulaire, comme les
curseurs. Il faut toujours « Preparer avec ces valeurs » ou « Ecrire dans <profil> ».

### Audit du code et corrections (2026-08-20)

Relecture complete de `server.mjs`, de `src/lib/` et des pages, a la recherche de bugs et
d'optimisations. Chaque defaut ci-dessous a ete **reproduit** avant correction, et les decodeurs ont
ete rejoues sur les 21 trames reelles du cache (`data/machine-beverages.json`) pour verifier
qu'aucun decodage ne change : noms de profils, noms de recettes perso, 5 ordres de favoris,
6 Bean Systems — resultat identique avant/apres.

**Bugs corriges (code vivant)**

1. `/systeme` affichait « progress undefined ». La page lisait `lastMonitor.progress`, champ que le
   serveur ne produit plus depuis que les octets 5-6 ont ete identifies comme le champ de bits des
   CAPTEURS. `/pilotage` avait ete corrige, `/systeme` etait reste en arriere. Elle affiche
   maintenant etat + capteurs + nombre d'alarmes. Verifie dans le navigateur :
   `etat 0x04 · capteurs 0x240 · alarmes 2`.

2. `decodeUtf16be` (profiles.mjs) retirait les zeros de remplissage **octet par octet**. Un nom
   finissant par un caractere U+xx00 laissait un tampon de longueur impaire et `swap16()` levait
   `ERR_INVALID_BUFFER_SIZE` : le bloc de noms ENTIER etait perdu, pas seulement ce nom. Le
   garde-fou existant (« ecrire 0 sur le dernier octet ») ne changeait pas la longueur, il ne
   pouvait rien empecher. Depouillement par paires ; « AĀ » se decode au lieu de lever.

3. `decodeBeanSystem` exigeait 48 octets mais lisait les octets 49 et 50. Sur une trame tronquee
   ils valaient `undefined`, donc `visible: false` et surtout **`active: true`** — un grain fantome
   annonce comme actif, alors que l'octet 50 est precisement ce qui designe le grain selectionne.
   Minimum porte a 51 (les trames reelles font 53).

4. Un `d302_monitor` vide faisait lever `stateByte.toString(16)` dans le journal. L'exception
   remontait au `catch` du datapoint : les AUTRES proprietes du meme datapoint etaient perdues et le
   journal accusait a tort le dechiffrement. Controle de taille + branche monitor isolee.

5. Champ d'alarmes signe : `0x80 << 24` vaut -2147483648 en JS, donc l'API publiait un bitfield
   negatif (la boucle sur les bits, elle, utilisait deja `>>>`). L'octet 13 est desormais multiplie
   par `0x1000000`.

6. `checksumsAtImport` etait ecrit des l'ENVOI de l'import, et avec toutes les familles. Deux
   consequences : un import echoue (machine injoignable) marquait quand meme les noms « frais », et
   un import `what:"order"` — qui ne lit aucun nom — les marquait aussi. Dans les deux cas la
   relecture des noms etait ensuite sautee (« somme inchangee »), et seul `force:true` s'en sortait.
   La marque est maintenant posee a la FIN de l'import, uniquement sur les familles reellement lues,
   et seulement si tout a repondu.

**Optimisations**

7. `/api/system` enchainait les deux sondes en serie (regtoken 4 s + OTA cloud 8 s de delai
   d'attente cumules) : elles sont independantes, donc en `Promise.all`.

8. Ecriture atomique (`writeJsonAtomic` : fichier temporaire + `rename`) du cache machine et des
   recettes. Le cache est reecrit EN ENTIER a chaque propriete recue, une cinquantaine de fois par
   import ; une coupure au milieu du `writeFileSync` laissait un JSON tronque, que `readMachine`
   avale silencieusement en repartant d'un cache VIDE.

9. `/bean-adapt` : l'effet du balayage dependait de `data.scan`, un objet recree a chaque reponse
   JSON — l'intervalle se demontait et se remontait a chaque rafraichissement. Dependance sur un
   booleen.

**Copies TypeScript shadowees**

`server.mjs` sert lui-meme `/local_lan/*` et `/api/*` : les routes Next et les `src/lib/*.ts`
qu'elles importent ne tournent jamais. Ces copies avaient derive et contenaient exactement les
regressions que CLAUDE.md interdit :

- `program.ts` utilisait `frameSendProfile(1)` comme presence soutenue — le battement de cœur `0xA9`
  qui imposait silencieusement le profil 1 ;
- `ecam.ts` portait les identifiants de boisson 14 et 17..21, faux pour ce modele (envoyer 21 pour
  un « brew over ice » viserait une autre boisson) ;
- `ecam.ts` nommait encore les octets 5-6 « progress » ;
- `session.ts.dequeue` filtrait `c.id !== id && c !== queue[0]`, donc retirait AUSSI la tete de
  file : un accuse pour une commande non-tete faisait disparaitre une commande jamais envoyee.

Les quatre sont corrigees et les fichiers touches portent un bandeau « ce fichier ne tourne pas ».
Elles restent une implementation en double : les supprimer est une option ouverte.

**Signale, non corrige** — le DSN reste en dur comme valeur de repli dans `src/lib/config.ts` et
`server.mjs` ; `PROFILE_BASE_CUSTOM` (beverages.mjs) ne decale pas le numero de propriete par
profil, contrairement aux boissons standard : pour les recettes perso des profils 2..5 la propriete
lue est `d200_2_cstm_recipe_01` et non un numero decale — deduit du code, jamais verifie sur la
machine.

`tsc --noEmit` propre, `node --check` propre. **`server.mjs` etant le point d'entree, il faut
redemarrer le serveur de dev pour que les corrections 4 a 8 prennent effet** (la correction 1 est
passee par HMR, elle est deja verifiee).

### DSN dynamique (2026-08-20)

Le numero de serie etait ecrit en dur comme valeur de repli (`process.env.MACHINE_DSN ??
"AC000W0..."`) dans `server.mjs` et `src/lib/config.ts`. C'est une donnee d'appareil, elle n'a rien a
faire dans le code — et elle n'a pas besoin d'y etre : **la machine la donne**.

`GET http://<machine>/regtoken.json` — le seul endpoint que le module expose hors mode AP — renvoie
`host_symname`, qui EST le DSN. Sans authentification, sans cloud. Le serveur avait deja cette
reponse sous la main (`probeRegtoken`, utilise par la page Systeme) sans en tirer le DSN.

`resolveDsn()` le resout dans cet ordre :

1. `MACHINE_DSN` de `.env.local` — un reglage explicite gagne toujours ;
2. la machine (`regtoken.json` -> `host_symname`) ;
3. le cache local `data/machine-beverages.json` (`restoreDsn`), pour redemarrer quand la machine ne
   repond pas.

Interroge au demarrage avec `compare: true` : si un `MACHINE_DSN` explicite diverge de ce que dit la
machine, le journal le signale au lieu de laisser passer. Resolution paresseuse aussi dans
`handleApi` tant qu'il est inconnu, parce que le DSN part dans chaque ecriture de propriete servie a
la machine. `dsnSource` est expose par `/api/status` et `/api/system`.

`MACHINE_DSN` est desormais commente dans `.env.local` et dans `.env.local.example` : le chemin
dynamique est celui qui tourne.

Verifie sur la machine reelle, cache vide et sans variable d'environnement :

```
De'Longhi LAN server ... machine 192.168.x.x, DSN a decouvrir
01:31:14 SYS profil actif restaure : 1
01:31:14 SYS DSN decouvert sur la machine : AC000W0XXXXXXXX
```

puis `/api/status` -> `dsnSource: "machine (regtoken.json)"`, `/pilotage` affiche
`192.168.x.x · AC000W0XXXXXXXX`, et le cache contient `dsn: {value, at}`.

Ce redemarrage a aussi valide les corrections de l'audit contre la machine reelle : le monitor
decode a l'arrivee donne `etat=0x04 · niveau d'eau bas, bac chocolat · alarmes EMPTY_WATER_TANK,
REPLACE_WATER_FILTER` — nouveau controle de taille et nouvelle formule d'alarmes compris.

Branche non exercee : l'avertissement de divergence (il faudrait forcer un `MACHINE_DSN` faux).

### Cle LAN decouvrable par le compte De'Longhi (2026-08-20)

La cle LAN etait la derniere valeur qu'il fallait extraire a la main (capture logcat + appels cloud)
et coller dans `.env.local`. Elle est maintenant recuperable a la demande depuis la page Systeme, en
saisissant les identifiants du compte De'Longhi.

**La chaine**, quatre sauts, tous verifies contre les vrais serveurs :

| # | Appel | Entree -> sortie |
|---|---|---|
| 1 | Gigya `accounts.login` (eu1) | e-mail + mot de passe -> `sessionInfo.cookieValue` |
| 2 | Gigya `accounts.getJWT` | `login_token` -> `id_token` (JWT RS256, 90 j) |
| 3 | Ayla `token_sign_in.json` | JWT + app_id/app_secret -> `access_token` (24 h) |
| 4 | Ayla `dsns/<DSN>/lan.json` | access_token -> `lanip_key` + `lanip_key_id` |

Le DSN vient de `resolveDsn()`, donc de la machine : la chaine entiere ne demande a l'utilisateur
que son e-mail et son mot de passe.

**Ce qui a ete verifie, et comment**

- Etapes 3 et 4 : rejouees en direct avec le JWT de `docs/secrets.md`. HTTP 200 les deux fois, et la
  `lanip_key` renvoyee est **identique** a celle de `.env.local` (comparaison booleenne, aucune
  valeur affichee). Puis re-verifiees a travers le vrai code via `POST /api/lankey {jwt}` ->
  `{ok:true, keyId:65269, keyLength:32, lanStatus:"enable", changed:false}`.
- Etape 1 : le centre de donnees et le contrat de l'API sont etablis **sans identifiant reel**, avec
  un compte volontairement inexistant. `eu1` repond `403042 invalid loginID or password` (donc
  endpoint, noms de parametres et cle API corrects) ; `us1` repond `301001 This API key is served by
  another data center` (donc eu1 est bien le bon centre). `accounts.getJWT` avec un jeton bidon
  repond `403005`, ce qui confirme le nom du parametre `login_token`.
- Via le vrai endpoint, un mot de passe faux ressort en
  `accounts.login (eu1) : Invalid LoginID [403042] — invalid loginID or password` : les messages de
  Gigya sont transmis tels quels plutot que reecrits.
- **Preuve d'usage** : `LANIP_KEY` neutralisee dans `.env.local`, redemarrage. Le serveur reprend la
  cle du cache (`cle LAN reprise du cache (key_id 65269)`), etablit une session avec la machine et
  dechiffre un monitor reel (`d0 12 75 0f 04 40 02 09 ...`). Une cle obtenue par le cloud fait donc
  bien tourner le protocole.

**Ce qui n'est PAS verifie** : le chemin « mot de passe correct ». Il demande les vrais identifiants,
que je n'ai pas et n'ai pas a avoir. Tout ce qui l'entoure l'est.

**Regles tenues**

- Le mot de passe n'existe que le temps de la requete : jamais journalise, jamais stocke, jamais
  renvoye. Le formulaire l'efface des la reponse, succes ou echec.
- **Aucun endpoint ne renvoie la cle LAN.** `/api/lankey` et `/api/status` n'exposent que `set`,
  `keyId` et `source`. Le `key_id` n'est pas un secret : il circule en clair dans le key exchange.
- Priorite : `LANIP_KEY` (.env.local) > `data/lan-key.json` (cache d'une decouverte, gitignore) >
  decouverte cloud. `DELETE /api/lankey` oublie le cache.
- Le pilotage ne depend jamais du cloud : la decouverte est sur action explicite, et une fois la cle
  en cache plus rien n'appelle l'exterieur.
- Changer de cle jette `S.session` : l'ancienne session etait derivee de l'ancienne cle.
- Les trois valeurs statiques de l'APK (`GIGYA_API_KEY`, `AYLA_APP_ID`, `AYLA_APP_SECRET`) vivent
  dans `.env.local`, pas dans le code. `GET /api/lankey` dit lesquelles manquent, et la page masque
  le formulaire en l'expliquant plutot que d'echouer a l'envoi.

**Etat final de `.env.local`** : `LANIP_KEY` reste ACTIVE. Contrairement au DSN, c'est le secret
critique du pilotage : je n'ai pas voulu remplacer une configuration qui marche par un fichier de
cache. Le cache existe et fonctionne (prouve ci-dessus) ; commenter `LANIP_KEY` suffit a basculer.

### Statistiques d'utilisation : mecanisme etabli, 62 parametres cartographies (2026-08-20)

Demande : chercher sur la machine les statistiques d'utilisation (nombre de cafes, etc.).

**Elles ne passent pas par les proprietes Ayla.** L'app connait des noms parlants
(`d701_tot_bev_b`, `d553_water_tot_qty`, `d552_cnt_calc_tot`, ... liste exacte dans
`p258z7/w.java`), mais les lire ne renvoie rien : les 14 ont ete demandees en LAN, la machine a
servi les 14 commandes et n'a pousse AUCUNE valeur (« import termine : 0 proprietes lues »). Meme
piege que les Bean Systems.

**La bonne voie est la commande ECAM `0xA2`** (`readSettingsParameter`), implementee :
`0D 08 A2 0F <idHi> <idLo> <qty> <crc>`, flag `0x0F`. Reponse `D0 <len> A2 0F` puis n entrees de
6 octets (id 16 bits BE, valeur 32 bits BE), `n = (len-5)/6`, plafonnee a 10 entrees.

Verifie sur la machine du premier coup :

```
d0 0b a2 0f 0b b8 00 00 23 91 2e c0    -> id 3000 = 9105
```

Big-endian confirme par deux voies : les magnitudes seraient absurdes en little-endian, et la
relation `3002 + 3004 = 3000` (8 + 9097 = 9105) ne tient qu'en big-endian.

**La machine enumere** : un id inexistant renvoie les parametres existants SUIVANTS, en sautant les
trous. Demander 100 renvoie `100, 101, 105, 106, 108, 109, 111, 115, 116, 3000`. J'avais d'abord
conclu que « 23000 » etait une sentinelle « parametre inconnu » (parce que 3047 renvoie 23000) --
c'est faux, 23000 est simplement le parametre suivant. C'est cette enumeration qui permet de
cartographier tout l'espace par balayage.

**62 parametres** sur ce modele, en quatre blocs : `1xx` (9), `3xxx` (35), `23xxx` (10), `43xxx` (8).
Les cinq derniers ids que l'app demande (3047, 3048, 3077, 3078, 3080) n'existent pas ici.

**La signification des identifiants n'est PAS etablie.** Aucune table id -> sens dans l'APK : le
viewmodel demande des ids en dur et affiche via les proprietes `d7xx_tot_*`. Je n'ai donc etiquete
aucun compteur. Deux pistes, la premiere gratuite : comparer avec le menu statistiques de l'ecran de
la machine ; sinon, relever, preparer une boisson, relever a nouveau et regarder ce qui bouge.

Endpoints : `POST /api/stats` (`ids[]`, ou `from`+`qty`), `GET /api/stats`. Les valeurs sont
persistees dans `data/machine-beverages.json` (`store.stats`), gitignore -- ce sont des donnees
d'usage personnelles, elles ne sont pas recopiees dans les docs. Voir
`docs/commandes-cafe.md` §12.

### Compteurs sur les cartes, et retrait du tableau des parametres (2026-08-20)

Deux demandes enchainees.

**1. Retrait du tableau « Tous les parametres »** des informations techniques d'une boisson.
L'editeur de recette juste au-dessus montre deja chaque reglage avec ses bornes, son defaut machine
et la valeur du profil : le tableau en dupliquait le contenu en lecture seule. Les informations
techniques gardent ce qui ne se lit nulle part ailleurs (proprietes Ayla, trame brute). Helpers
devenus morts supprimes au passage (`paramIds`, `fmt`, le `useTranslations("recipes")` de la carte)
et la cle `beverages.allParams` retiree du catalogue.

**2. Compteur d'usage sur chaque carte.** La recherche a livre la semantique manquante :
`p018b7/e.java` associe explicitement des ids de parametres a l'enumeration de categories
`p258z7/w.java$a`. Dix significations sont donc **etablies par lecture de code** :

| id | sens | valeur relevee |
|---|---|---|
| 105 | detartrages | 10 |
| 106 | eau, unite 0,5 ml (litres = /2000) | 1108 L |
| 108 | filtres a eau | 5 |
| 115 | nettoyages circuit lait | 437 |
| 3000 | boissons sans lait | 9105 |
| 3001 | boissons avec lait chaud | 2501 |
| 3003 | idem, second compteur (somme avec 3001 dans l'app) | 767 |
| 3017 | avec lait froid — Maestosa uniquement | 0 |
| 3021 | chocolats | 0 |
| 3025 | thes | 2 |

**Point important : la machine compte par CATEGORIE, pas par boisson.** Il n'existe pas de compteur
« nombre d'espressos » — espresso, cafe long, doppio+ et americano alimentent tous 3000. Le seul
compteur propre a une boisson est celui du the, et la propriete `d719_id22_tea` le confirme (22 est
bien l'id du the). La carte affiche donc « ☕ 9 105 (boissons sans lait) », avec une infobulle qui
dit explicitement que le total couvre toute la categorie. `/api/beverages` renvoie
`counter: {id, value, category, scope: "category"}` ; eau chaude et mug de voyage n'ont aucune
categorie connue et n'affichent rien (le total to-go vit dans `d731`/`d732`, sans id de parametre
connu).

`/api/stats` expose en plus un bloc `known` avec les compteurs nommes et convertis.

Verifie dans le navigateur : « Espresso Coffee · … · ☕ 9 105 (boissons sans lait) », « Latte
Macchiato · … · ☕ 2 501 (boissons avec lait chaud) », plus aucun tableau sur la page, panneau
technique intact.

Incident sans consequence : en ouvrant la page, une boite de confirmation « Preparer Espresso Bean
Adapt » restee en attente dans un onglet ouvert precedemment s'est presentee. Elle a ete
**refusee** ; le journal serveur confirme qu'aucune commande de preparation n'a ete envoyee.

### Page /statistiques (2026-08-20)

Nouvelle page, ajoutee a la barre de navigation entre Recettes et Systeme.

- Avertissement en tete, en clair : **la machine compte par categorie, pas par boisson**.
- Total des boissons preparees, presente comme **notre** addition (sans lait + avec lait chaud +
  thes + chocolats), pas comme un compteur expose par la machine. Sur cette machine : 12 375.
- Les 10 compteurs identifies, avec libelle, identifiant brut et conversion d'unite (eau :
  1 108 L pour 2 215 122 en unites de 0,5 ml). Mention du fait que l'app additionne 3001 et 3003 --
  verifie dans `p018b7/e.java`, methode `m()`, `return iIntValue3 + iIntValue2`.
- Les 52 parametres non identifies, donnes **bruts, sans etiquette inventee**, avec la note qui dit
  comment les elucider.
- Deux boutons de lecture. Ils exploitent le fait que la machine **enumere** : 3 requetes de plage
  suffisent a couvrir les 10 compteurs connus (au lieu de 10 requetes unitaires), 8 pour balayer les
  62. L'enchainement attend que le programme precedent soit clos, sinon le serveur repond 409.

Verifie dans le navigateur, puis le bouton « Lire les compteurs » teste de bout en bout : les
3 plages ont ete servies et la machine a repondu a chacune.

**Piege i18n rencontre** : le message `protocolNote` contenait `<id sur 16 bits>`. next-intl lit les
chevrons comme des balises de texte enrichi, le message ne se parse pas et l'interface affiche la
cle brute `stats.protocolNote`. Corrige en notation entre crochets ; controle passe sur tout le
catalogue, aucun autre message ne contient de chevrons. Consigne dans CLAUDE.md.

**Releve differentiel fortuit** — deux releves complets a 26 minutes d'intervalle, une boisson sans
lait preparee entre les deux (3001 et 3003 immobiles). Sept compteurs ont bouge :

| id | delta | lecture |
|---|---|---|
| 3000 | +1 | boissons sans lait, coherent avec le sens etabli |
| 3004 | +1 | suit la meme chose que 3000 |
| 3037 | +1 | suit egalement la meme chose |
| 106 | +112 | x 0,5 ml = 56 ml d'eau |
| 109 | +112 | meme delta -> meme grandeur, meme unite |
| 100 | +1120 | exactement 10 x 112 -> meme grandeur, unite dix fois plus fine |
| 101 | +145 | non proportionnel : autre nature |

Cela etablit que 3004 et 3037 s'incrementent avec 3000, et que 100/106/109 mesurent la meme
grandeur dans trois unites. Cela n'etablit PAS ce que comptent 3004, 3037 et 101 : un seul
echantillon, une boisson dont le type n'etait pas controle. Voir `docs/commandes-cafe.md` §12.7.

### Stockage : migration des JSON vers SQLite (2026-08-20)

Toute la persistance passe par **un seul fichier SQLite**, `data/lan-server.db`, via le module natif
`node:sqlite` (`DatabaseSync`). Nouveau module : `src/lib/store.mjs`.

**Ce qui posait probleme.** Le cache machine etait un unique blob JSON relu puis reecrit EN ENTIER a
chaque propriete recue : `readMachine()` -> mutation -> `writeMachine()`. Un import de profil, c'est
une soixantaine de proprietes, donc une soixantaine de serialisations de 80 ko -- 4,9 Mo reecrits
pour modifier 58 lignes. Et le mode de defaillance etait silencieux : un JSON tronque etait avale par
le `catch` de `readMachine()`, qui repartait d'un cache VIDE sans un mot dans le journal.

**Le schema** (tables `STRICT`, donc une valeur du mauvais type est refusee a l'ecriture et non
decouverte six mois plus tard dans une page qui affiche « NaN ») :

| table | contenu |
|---|---|
| `props` | une ligne par propriete Ayla : `name`, `at`, `kind`, `data` (JSON du reste) |
| `bean_systems` | un profil de grains par ligne |
| `stats` | `id`, `value`, `at` en vraies colonnes |
| `recipes` | recettes locales, `id` en cle primaire |
| `meta` | valeurs JSON nommees : `dsn`, `activeProfile`, `checksums`, `checksumsPrev`, `checksumsAtImport`, `importedAt`, `lanKey` |

**Migration automatique.** Au premier demarrage le module reprend les trois fichiers JSON puis les
renomme en `*.json.migrated` -- conserves, pas supprimes. `PRAGMA user_version` verrouille l'affaire :
un redemarrage ne rejoue pas la migration (verifie). Sur les donnees reelles : 58 proprietes,
62 statistiques, 6 profils de grains, 0 recette, la cle LAN. Comparaison exhaustive champ par champ
avec le JSON d'origine : **identique**.

**Ce qui change dans le code.** Les ecritures sont ciblees (`putProp`, `putStats`, `putBeanSystem`,
`putChecksums`, `setMeta`, `putRecipe`) ; `machineView()` ne sert plus qu'a la LECTURE d'ensemble.
`readMachine`/`writeMachine`/`writeJsonAtomic` et les trois constantes de fichier ont disparu.
`putChecksums` decale l'ancien releve vers `checksumsPrev` et rend le couple `{prev, current}` dans
une seule transaction : c'est ce couple qui dit ce qui a bouge, il ne doit jamais etre a moitie ecrit.

**Durabilite.** `journal_mode = WAL` et `synchronous = FULL`. Le volume est minuscule, donc la
durabilite complete est gratuite : mesure sur 58 ecritures de propriete, **4,0 ms/propriete avec
fsync** contre **5,9 ms sans fsync** pour l'ancien chemin JSON. SQLite est donc a la fois plus rapide
et durable, et le cout d'une ecriture ne depend plus de la taille du cache.

**Deux corrections au passage.**
- `importedAt` n'est plus touche que par les ecritures de donnees machine. L'ancien `writeMachine()`
  le bougeait a chaque ecriture, donc un simple enregistrement du profil actif deplacait la date de
  « lu sur la machine » affichee par les pages.
- `POST /api/recipes` refuse une recette sans `id` (400). Avant, elle etait ecrite sans identifiant
  et la suivante l'ecrasait en silence.

**Verifications.** 18 assertions sur le module (upsert sans doublon, `kind` nul, decalage des sommes,
`clearLanKey` qui dit vrai puis faux, et le rollback : une entree invalide dans un lot de deux
n'en laisse passer aucune). CRUD recettes de bout en bout en HTTP, ordre d'affichage conserve.
Tous les endpoints relus : 28 boissons avec bornes et valeurs, 5 profils nommes, 23 favoris,
62 statistiques, 6 profils de grains, sommes de controle. Pages rendues sans cle de traduction non
resolue. Profil actif, DSN et cle LAN repris de SQLite apres redemarrage. `tsc --noEmit` passe.

**Etat du stockage visible dans `/systeme`** : moteur et version SQLite, version de schema, mode de
journal, nombre de lignes par table, taille du fichier -- plus l'avertissement qui compte.

⚠️ **`data/lan-server.db` est du materiel secret** : il porte la cle LAN, le numero de serie et les
noms de profils saisis sur la machine. Ne jamais le joindre a un rapport de bug. `data/` est
gitignore en entier, `-wal`/`-shm`/`.migrated` compris.

`src/lib/recipes.ts` (mort, shadowe) decrivait encore le stockage fichier : il porte desormais une
seconde banniere disant que la persistance est passee a SQLite et qu'il ecrirait un fichier que plus
rien ne lit.

### Conteneur Docker, CI et releases GitHub (2026-08-20)

**Prerequis livre au passage : l'emplacement de la base devient configurable.** Il etait code en dur
sur `process.cwd()/data`, ce qui ne marche pas en conteneur (image en lecture seule, donnees dans un
volume). Deux variables, testees toutes les deux, creation des repertoires intermediaires incluse :

| Variable | Defaut | Effet |
|---|---|---|
| `DATA_DIR` | `./data` (`/data` dans l'image) | repertoire de tout l'etat persistant, et source de la migration JSON |
| `DATABASE_FILE` | `<DATA_DIR>/lan-server.db` | chemin complet du fichier, pour le sortir de `DATA_DIR` |

**Fichiers ajoutes** : `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `DOCKER.md`,
`.github/workflows/ci.yml`, `.github/workflows/release.yml`. Plus `packageManager: pnpm@11.22.0`
dans `package.json`, pour que corepack et les runners prennent la meme version que le poste.

**L'image.** Multi-etapes sur `node:26-alpine` : dependances completes -> build Next -> dependances
de production seules -> image finale. Pas de `output: "standalone"` de Next : le point d'entree reel
est notre `server.mjs`, alors que le tracage de dependances de standalone part du serveur genere par
Next. L'image installe donc ses dependances de production, plus grosse mais sans zone d'ombre.
Utilisateur `node` (uid 1000), `VOLUME /data`, `HEALTHCHECK` sur `/api/status` via `fetch` (pas
besoin d'ajouter curl). `.dockerignore` exclut `data/` et `.env.local` : **aucun secret dans
l'image**.

**Le point qui decide de tout, documente en tete de DOCKER.md.** Les roles etant inverses, c'est la
cafetiere qui vient nous frapper :
- `SERVER_IP` doit etre une adresse joignable depuis son VLAN, jamais l'IP interne du conteneur ;
- le port doit porter **le meme numero des deux cotes**. `postLocalReg()` annonce `CFG.port`, qui est
  aussi le port d'ecoute : un `-p 8080:3000` enverrait la machine toquer a la mauvaise porte. Verifie
  en relisant `postLocalReg`, pas suppose.

**La CI.** Le projet n'a pas de suite de tests (les changements de protocole se valident sur la vraie
machine), donc la CI verifie ce qui se verifie sans cafetiere : `tsc --noEmit`, `node --check` sur
`server.mjs` et tous les `src/lib/*.mjs` (leur seul filet, puisqu'ils ne passent pas par TypeScript),
la validite du catalogue de messages **et l'absence de chevrons dedans** (le piege next-intl qui
avait fait afficher `stats.protocolNote` en clair), `pnpm build`, l'initialisation du stockage SQLite
avec migration d'un ancien `recipes.json`, puis la construction de l'image et son demarrage reel avec
interrogation de `/api/status` et `/api/system`.

**Les releases.** Sur etiquette `v*` : image multi-architecture `linux/amd64,linux/arm64` poussee sur
GHCR (etiquettes version, mineure, majeure, `latest`), archive `.tar.gz` pour une installation sans
Docker, et release GitHub avec notes generees depuis les commits. `GITHUB_TOKEN` suffit, rien a
configurer. arm64 est construit sous emulation QEMU : lent, mais pas de runner ARM a maintenir.

**Sauvegarde documentee et verifiee** : `VACUUM INTO` sur une connexion en lecture seule produit une
copie coherente d'une base en cours d'utilisation, WAL compris — teste sur la vraie base, la copie
contient bien les 58 proprietes et 62 statistiques. La recette a froid (arret puis copie du seul
`.db`, le WAL etant integre a la fermeture) est egalement documentee, avec l'avertissement de ne
jamais copier le `.db` seul a chaud.

**Verifications faites** : YAML des deux workflows et du compose parses, toutes les sources des
`COPY` du Dockerfile et tous les fichiers de l'archive de release verifies presents, les deux
variables de stockage testees, `tsc --noEmit` passe. **Non verifie ici** : la construction de l'image
elle-meme et son demarrage, le moteur Docker de ce poste etant a l'arret (`com.docker.service`
arrete). C'est precisement ce que fait le job `docker` de la CI a chaque poussee.

### La cle LAN dans une page dediee /cle-lan (2026-08-20)

Le formulaire d'identifiants du compte De'Longhi vivait au milieu de `/systeme`, qui est une fiche
technique en lecture seule. Il a sa propre page.

**Nouvelle page `/cle-lan`**, ajoutee a la barre de navigation avant Systeme. Elle reprend ce qui
etait dans la carte, et expose en plus deux informations que `/api/lankey` renvoyait deja sans que
rien ne les affiche :

- **Etat actuel** : presence, `key_id`, source, **date de decouverte** (`cachedAt`) et **DSN
  interroge** (`dsn`).
- **Recuperation** : les quatre etapes du parcours cloud sont maintenant ecrites sur la page
  (Gigya `accounts.login` en eu1 -> `accounts.getJWT` -> Ayla `token_sign_in.json` -> Ayla
  `dsns/[DSN]/lan.json`), avec le rappel de confidentialite.
- **Oubli de la cle** dans sa propre section, affichee seulement s'il y a quelque chose a oublier.

Le bouton **afficher / masquer** du mot de passe suit, avec ses garde-fous : `type="button"`,
`aria-pressed`, `aria-label` et `title` traduits, `autoCapitalize` / `autoCorrect` / `spellCheck`
desactives (en clair le champ redevient un champ texte ordinaire), et remasquage automatique dans le
`finally`, la ou le mot de passe est deja vide.

**Ce que /systeme garde.** Rien n'est duplique : le bloc « Protocole et reseau » rendait deja
`lanKeySet` / `lanKeyId` / `lanKeySource` depuis `/api/system`, donc l'etat de la cle reste visible
la-bas. La carte a d'abord ete remplacee par un renvoi vers la page dediee, **puis retiree
entierement** dans un second temps : la barre de navigation y mene deja, le renvoi ne faisait que
repeter. `/systeme` ne parle donc plus de la cle LAN que par ces trois lignes du bloc protocole, et
les trois cles `system.lanKey*` correspondantes ont ete retirees du catalogue. Plus **aucun champ
d'identifiant** sur `/systeme` — verifie dans le navigateur : 0 input de type email ou password.

**Messages.** Les cles `system.lanKey*` deviennent un espace de noms `lankey` sans prefixe
redondant ; `/systeme` n'en garde que trois (titre de section, texte de renvoi, libelle du lien).
Deux libelles parlaient encore de `data/lan-key.json`, disparu avec le passage a SQLite : corriges
en « la base locale (data/lan-server.db) ».

**Piege i18n evite** : la description du parcours cloud contient un segment d'URL variable. Ecrit
`dsns/[DSN]/lan.json` et non avec des chevrons, que next-intl lit comme des balises de texte enrichi
— controle automatique du catalogue passe, aucun chevron nulle part.

Verifie dans le navigateur : les deux pages rendues sans aucune cle de traduction non resolue,
navigation a jour, etat lu correctement (key_id 65269, source `.env.local`, date de decouverte, DSN),
bascule du mot de passe fonctionnelle. `tsc --noEmit` passe.

### Correction : la decouverte de la cle LAN echouait sur getJWT (2026-08-20)

**Symptome.** La recuperation de la cle depuis le compte De'Longhi echouait, alors que l'application
Android fonctionnait avec le meme compte.

**Diagnostic sans rien redemander.** Le journal du serveur portait deja le verdict :

```
SYS cle LAN : echec de la decouverte (accounts.getJWT (eu1) : Unauthorized user [403005])
```

Donc `accounts.login` PASSAIT et c'est le saut suivant qui refusait. (Deux autres lignes
`403042 invalid loginID or password` etaient, elles, de simples erreurs de saisie -- a ne pas
confondre avec le vrai bug.)

**Cause.** Le code envoyait `targetEnv: "mobile"` a `accounts.login`. Sonde cote a cote sur les vrais
serveurs, avec le meme compte :

| targetEnv | `sessionInfo` contient | `accounts.getJWT` |
|---|---|---|
| `mobile` | `sessionToken`, `sessionSecret`, `expires_in` | **403005 Unauthorized user** |
| defaut (browser) | `cookieName`, `cookieValue` | **OK**, `id_token` de 695 caracteres |

Une session *mobile* est une session **OAuth1** : son `sessionToken` sert a SIGNER les requetes
suivantes, ce n'est pas un `login_token`. L'app Android fonctionne parce que le SDK Gigya mobile
signe ; notre flux REST, lui, doit demander une session navigateur et transmettre `cookieValue`.

**Correction.** Retrait de `targetEnv: "mobile"`, et lecture de `sessionInfo.cookieValue` seul. Le
repli `?? sessionInfo.sessionToken` est supprime : il ne rattrapait rien, il transmettait un jeton du
mauvais type au lieu d'echouer avec un message clair -- c'est lui qui a transforme une erreur de
parametre en enigme.

**Verifie de bout en bout** sur `POST /api/lankey` : HTTP 200, les quatre sauts en 1,1 s
(login -> getJWT -> token_sign_in -> lan.json), `keyId 65269`, `keyLength 32`, `lanStatus enable`,
`keepAlive 30`, et surtout **`changed: false`** -- la cle obtenue par le cloud est identique a celle
de `.env.local`, ce qui confirme le parcours de facon independante. La reponse ne contient aucun
secret (`lanip_key` absent), et le mot de passe n'apparait dans aucun journal.

### Coherence de l'interface quand la cle LAN est absente (2026-08-20)

Cle supprimee volontairement pour verifier le comportement : `LANIP_KEY` commentee dans
`.env.local`, `meta.lanKey` absente de la base, `lanKeySet: false`, aucune session.

**Ce qui n'allait pas.**

| Endroit | Constat |
|---|---|
| `POST /api/command` | repondait `{"program":"Eteindre","register":{"ok":true,"status":202}}` -- **un succes** |
| page `/` | **aucun avertissement**, 88 boutons actifs (Allumer/Eteindre, profils, Lire, Preparer) |
| page `/pilotage` | avertissait, mais le texte etait anterieur a `/cle-lan` : il ne parlait que de copier `.env.local.example` et de lire `docs/secrets.md`. En dur dans le JSX, hors catalogue. |
| `/pilotage` (clic) | `await fetch(...)` sans lire la reponse : un refus du serveur restait **totalement muet** |

La machine se presente, prend un 412 a l'echange de cles et repart : la commande etait donc acceptee
puis perdue en silence, pendant que l'interface annoncait « envoye ».

**Corrections.**

1. **Refus franc cote serveur.** `NEEDS_LAN_KEY` liste les endpoints qui mettent en file une trame
   que seule une session chiffree peut transporter. Un **POST** vers l'un d'eux sans cle renvoie
   **409** avec `needsLanKey: true` et un message en clair. Les **GET restent servis** : le cache
   deja constitue doit rester consultable sans cle.
2. **`/api/lankey` volontairement hors de la liste**, dans les deux methodes -- le bloquer rendrait
   la situation irrecuperable. Verifie : POST corps vide -> 400 (refus metier), pas 409 ; DELETE -> 200.
3. **Banniere unique** partagee par `/` et `/pilotage` (`common.noLanKey` + lien vers `/cle-lan`),
   affichee quand `status.config.lanKeySet` est faux. L'ancien texte en dur disparait du JSX.
4. **`/pilotage` lit enfin ses reponses** : `send()` et `register()` affichent le retour, erreur
   comprise, dans une zone de message nouvelle.

**Verifie.** Ecritures refusees : `/api/command`, `/api/presence`, `/api/checksums`, `/api/stats`,
`/api/profiles/import`, `/api/beverages/import` -> 409. Lectures intactes : `/api/status`,
`/api/system`, `/api/beverages`, `/api/profiles`, `/api/stats`, `/api/checksums`, `/api/beansystem`,
`/api/recipes`, `/api/lankey` -> 200. Dans le navigateur, la banniere s'affiche a l'identique sur les
deux pages avec un lien actif, et un clic reel sur « Eteindre » affiche desormais
« Erreur : cle LAN absente : aucune session chiffree n'est possible... ». Aucune cle de traduction non
resolue. `tsc --noEmit` passe.

Le garde-fou se leve tout seul des qu'une cle est presente : il ne teste que `CFG.lanKey.length`.

### Le menu se reduit quand la cle LAN est absente (2026-08-20)

Suite logique de la coherence des messages : sans cle, on ne propose plus les pages qui ne peuvent
rien faire.

**`src/app/Nav.tsx`**, nouveau composant client. Le layout reste un composant serveur ; il ne fait
plus que rendre `<Nav />`. La liste des entrees porte un drapeau `needsLanKey`, et le composant
filtre selon `/api/status`.

| Sans cle | Entrees |
|---|---|
| masquees | Boissons, Bean Adapt, Profils, Pilotage, Recettes, Statistiques |
| conservees | **Cle LAN** (sans quoi plus aucun chemin pour recuperer la cle) et **Systeme** (ne depend pas de la cle) |

**Les pages masquees restent servies.** Une URL saisie a la main affiche toujours le cache de la
derniere lecture, avec la banniere d'avertissement. On retire l'invitation, pas l'acces -- verifie :
`/` repond et affiche « Boissons de la machine » avec le menu reduit.

**Deux details a ne pas regresser.**

1. **Etat inconnu = tout afficher.** `lanKeySet === null` (et tout echec du fetch) laisse le menu
   complet. Masquer par defaut ferait clignoter le menu a chaque chargement dans le cas normal --
   cle presente -- qui est le cas courant.
2. **`/cle-lan` emet un evenement `lankey-changed`** apres une recuperation ou un oubli. C'est le
   seul moyen de voir le menu revenir sans rechargement complet : sans lui on resterait coince sur
   `/cle-lan` apres une recuperation reussie, puisque tous les autres liens sont masques. La
   navigation se faisant par liens classiques, tout autre changement de page reconstruit le menu.

**Verifie dans le navigateur.** Menu reduit a « Cle LAN | Systeme » sur `/cle-lan`, `/systeme` et `/`.
Puis, en simulant la reponse de `/api/status` cote navigateur -- donc **sans toucher a la vraie
cle** -- l'emission de `lankey-changed` fait passer le menu de 2 a 8 entrees instantanement.
`tsc --noEmit` passe.

### Adresse de la machine : saisie dans l'interface, et plus aucun defaut (2026-08-20)

**Le defaut en dur disparait.** `CFG.machineIp` valait `process.env.MACHINE_IP ?? "192.168.x.x"` :
la configuration de quelqu'un d'autre, qui donnait l'illusion d'un serveur configure alors qu'il
parlait dans le vide. Desormais `process.env.MACHINE_IP || null`. Meme nettoyage dans
`debug-capture.mjs` (qui exige maintenant `MACHINE_IP` comme les autres variables) et dans
`src/lib/config.ts` (mort).

**Priorite identique au DSN et a la cle LAN** : `MACHINE_IP` dans `.env.local` > `meta.machineIp` en
base (ecrite par l'interface) > rien.

**Nouvelle page `/machine`**, premiere entree du menu — l'ordre suit la dependance reelle : sans
adresse, pas de DSN, donc pas de decouverte de cle LAN, qui a besoin du DSN.

- Etat : adresse, source, date d'enregistrement, DSN decouvert et sa source, et l'adresse que nous
  **annoncons** a la machine (`serverIp:serverPort`).
- Saisie validee : IPv4 **ou nom d'hote** — le champ `host` de `node:http` ne fait pas la
  difference, et un nom d'hote protege d'un changement de bail DHCP. Rejette schema, port et chemin.
- **Test immediat** : l'enregistrement est suivi d'une sonde `regtoken.json` et d'une nouvelle
  resolution du DSN. Une adresse enregistree mais muette est signalee tout de suite, au lieu d'etre
  decouverte au premier echec de commande.
- Oubli de l'adresse memorisee.

**Consequences d'un changement d'adresse** : la session LAN est jetee (elle derivait d'un echange de
cles avec l'ancienne machine) et le DSN memorise est effac -- c'est le numero de serie de l'ANCIEN
appareil. Un `MACHINE_DSN` explicite reste prioritaire.

**Garde-fous.** `probeRegtoken()` et `postLocalReg()` court-circuitent quand l'adresse est inconnue,
au lieu de laisser `node:http` composer un hote nul. `NEEDS_LAN_KEY` devient `NEEDS_MACHINE` et
verifie les deux prerequis dans l'ordre, avec les drapeaux `needsMachineIp` puis `needsLanKey`. Le
menu masque les pages qui dependent des deux : il ne reste que Machine, Cle LAN et Systeme.

**Verifie, en commentant temporairement `MACHINE_IP` dans `.env.local`** (sauvegarde puis restaure,
empreinte sha256 identique verifiee) :

| Controle | Resultat |
|---|---|
| demarrage sans adresse | « machine a configurer » + avertissement au journal |
| `GET /api/machine` | `ip: null`, `source: inconnue` |
| `POST /api/command` | 409 `needsMachineIp: true` |
| adresses invalides (`http://…`, `…:80`, `a b`, vide) | 400, les quatre |
| menu avec cle presente mais sans adresse | reduit a Machine / Cle LAN / Systeme |
| saisie de l'adresse reelle dans l'interface | enregistree, sonde `reachable: true` HTTP 200, **DSN repasse en source « machine (regtoken.json) »** -- la sonde a donc reellement joint la machine |
| menu apres saisie | revenu a 9 entrees, sans rechargement |
| apres restauration de `MACHINE_IP` | `source: MACHINE_IP (.env.local)`, `envForced: true`, ecritures a nouveau autorisees (POST /api/presence -> 200) |

Note : la page signale explicitement quand `MACHINE_IP` est definie dans l'environnement, pour que
la saisie ne paraisse pas ignoree apres un redemarrage.

### La saisie de l'adresse rejoint la page Cle LAN (2026-08-20)

`/machine`, cree une demi-heure plus tot, est **fusionnee dans `/cle-lan`** et supprimee. La raison
est la dependance elle-meme : chez Ayla la cle est rangee sous le DSN, et le DSN ne vient que de la
machine — on ne peut donc pas recuperer la cle avant de connaitre l'adresse. Deux pages pour deux
reglages qui se conditionnent obligeaient a faire l'aller-retour.

**La page, dans l'ordre de la dependance :**

1. « Adresse de la machine » — etat (adresse, source, DSN et sa source, l'adresse que nous
   annoncons), saisie validee, test immediat, oubli ;
2. « Etat actuel » de la cle ;
3. « Recuperer la cle depuis le compte De'Longhi » ;
4. « Oublier la cle memorisee », si elle est memorisee.

Une phrase (`lankey.addressWhy`) explique pourquoi l'adresse figure sur cette page, et precise que
le DSN une fois memorise affranchit la recuperation de cette adresse — mais pas le pilotage.

**Nettoyage.** Entree de menu « Machine » retiree (il ne reste que Cle LAN et Systeme quand un
prerequis manque), `nav.machine` retiree du catalogue, les cinq mentions « page Machine » de
`server.mjs` corrigees, et le lien `needsDsnLink` supprime : la saisie est desormais juste au-dessus
de l'avertissement. Les endpoints `/api/machine` gardent leur nom. `/machine` repond 404 — la page
n'a jamais existe ailleurs que dans cette session.

**Piege rencontre** : `tsc` echouait sur `.next/types/validator.ts`, qui referencait encore
`src/app/machine/page.js`. Ce n'est pas une erreur de code mais un type genere perime — `rm -rf
.next/types` puis rebuild.

**Verifie dans le navigateur.** Menu « Cle LAN | Systeme », sections dans l'ordre attendu, trois
champs (adresse, e-mail, mot de passe), avertissement d'adresse manquante present. Puis saisie
reelle : « Adresse 192.168.x.x enregistree, et la machine repond. DSN : AC000W0XXXXXXXX. », plus
aucun avertissement. Le menu reste reduit — correctement : `ready` exige les DEUX prerequis, et la
cle est absente. `/machine` -> 404, `/cle-lan` -> 200, `tsc --noEmit` passe, le build compile.

### Plusieurs machines (2026-08-20)

Le serveur pilote désormais N cafetières. Trois couches ont bougé.

**Stockage — schéma v2.** Chaque table de données porte une colonne `machine` et une clé primaire
composite, avec `REFERENCES machines(id) ON DELETE CASCADE` ; les réglages qui n'appartiennent à
aucune machine vivent dans une table `settings` à part, plutôt que sous une machine sentinelle qui
aurait fait mentir la clé étrangère. Toute lecture ou écriture passe par `forMachine(id)` : il
n'existe volontairement **aucune** version sans machine de ces fonctions, parce qu'un appel qui
aurait oublié de préciser laquelle écrirait dans la mauvaise sans que rien ne le signale.

SQLite ne sait pas changer une clé primaire : la migration recrée les tables et recopie, en une
seule transaction, en rattachant toutes les lignes existantes à `m1` — la seule lecture possible,
une base v1 ne pouvant décrire qu'une machine.

| Vérification de la migration | Résultat |
|---|---|
| copie de la vraie base (58 propriétés, 62 statistiques, 6 grains, 7 valeurs `meta`) | tout repris sous `m1`, DSN, adresse, modèle, clé LAN et profil actif intacts |
| la vraie base, en place | idem, et le serveur redémarre en lisant tout depuis le cache |
| deuxième démarrage | aucune remigration (`user_version` fait barrage) |
| base plus récente que le code | refus immédiat avec un message, au lieu d'échouer plus loin sur une colonne inconnue |
| suppression d'une machine | ses lignes partent par cascade, celles des autres sont intactes |

La CI joue maintenant cette migration sur une base v1 fabriquée pour l'occasion : c'est la seule
opération du projet capable de détruire les données de quelqu'un.

**Serveur — l'état devient un enregistrement par machine.** `CFG` ne garde que ce qui appartient au
serveur (`serverIp`, `port`). Adresse, cache DNS, DSN et son étranglement, clé LAN, modèle,
génération, session, programme, file de lecture, monitor, keep-alive, profil actif, balayages,
requêtes OTA : tout est par machine. Le journal reste **unique**, chaque ligne portant sa machine —
deux journaux auraient obligé l'interface à recoudre une chronologie, or c'est exactement ce qu'on
regarde quand une commande ne passe pas. Le préfixe `[m1]` n'apparaît qu'à partir de deux machines,
donc la sortie d'une installation mono-machine est inchangée.

**Qui nous appelle ?** C'est le point qui décidait de l'architecture. Les endpoints device-facing ne
portent **aucune** identité : le `uri` annoncé dans `local_reg` est commun, et seul
`key_exchange.json` transporte un `key_id`. L'identification se fait donc sur l'**adresse source**,
la seule information présente sur les trois endpoints : une seule machine connue → c'est elle sans
condition (une installation mono-machine ne peut pas régresser) ; sinon correspondance avec
l'adresse configurée ou résolue ; sinon avec l'adresse déjà reconnue lors d'un échange de clés. Au
key exchange seulement, le `key_id` sert de second recours. Deux machines derrière une même adresse
source ne seraient pas distinguables — c'est dit dans l'interface.

La piste d'un `uri` par machine dans `local_reg` a été écartée : rien ne prouve que l'ESP32 respecte
une base arbitraire, et le module a déjà montré qu'il est pointilleux sur ce genre de détail
(l'en-tête `Host`). L'adresse source ne dépend d'aucun comportement non vérifié.

**Interface.** Un sélecteur dans la barre de navigation (à partir de deux machines), une page
`/machines` pour ajouter, nommer, désigner la machine par défaut et supprimer, et surtout : les
38 appels d'API des pages passent tous par `mfetch`, qui ajoute la machine courante. Un `fetch` nu
viserait la machine **par défaut du serveur**, pas celle qui est affichée — sur des commandes qui
agissent sur un appareil réel, ce n'est pas un détail d'affichage. Le choix vit dans
`localStorage` : un « courant » global aurait fait changer la page sous les yeux de quelqu'un
pendant qu'un autre onglet choisissait autrement.

| Vérifié dans le navigateur | Résultat |
|---|---|
| une seule machine | sélecteur absent, menu et journal identiques à avant |
| ajout d'une deuxième | sélecteur présent, `m2` sans adresse ni clé, 0 donnée |
| bascule sur `m2` | menu réduit à Machines / Clé LAN / Système, `/cle-lan` montre bien l'état de `m2` |
| retour sur `m1` | 28 boissons, ordre de la machine, profils nommés, compteurs, session LAN |
| `/api/status?machine=m99` | HTTP 404 `unknownMachine`, **pas** de repli silencieux sur la machine par défaut |
| POST vers `m2` | HTTP 409 `needsMachineIp` — le refus est par machine |
| présence sur `m1`, avec `m2` déclarée | échange de clés et datapoints routés vers `m1` par adresse source, monitor décodé |
| suppression de la dernière machine | refusée (409 `lastMachine`) |

**Ce que ça ne fait pas, et il faut le dire.** Le catalogue de boissons reste celui d'un seul modèle,
partagé par toutes les machines. Le modèle réel de chacune est lu et comparé ; un écart est signalé
en bandeau sur `/machines`, dans le journal et sur `/systeme` — mais pas corrigé. La raison est celle
déjà consignée : le nombre de recettes standard entre dans le nom des propriétés de recette
(`(profil − 1) × 21` ici), et sur un modèle à 22 recettes chaque lecture viserait la mauvaise
propriété, qui répondrait vide, donc serait interprétée comme « absente sur ce modèle ». L'erreur
ressemblerait à un import normal. Deux cafetières du **même** modèle n'ont, elles, rien à craindre.

Les variables d'environnement ne décrivent que la première machine (`envForced(m, champ)`), puisque
`MACHINE_IP` ne peut pas désigner deux appareils. Ne jamais tester `process.env.MACHINE_*` dans une
fonction qui travaille sur une machine : ce serait laisser la variable revendiquer l'adresse de la
machine numéro 2.

**Reste à éprouver** : deux cafetières réellement raccordées en même temps.

### La configuration rejoint la carte de chaque machine (2026-08-20)

La page Machines renvoyait vers `/cle-lan` pour l'adresse et la clé, c'est-à-dire pour la moitié de
ce qu'on vient y faire. Et `/cle-lan` ne travaillait que sur la machine **sélectionnée** : configurer
la deuxième obligeait donc à basculer dessus d'abord, puis à quitter la page où on était. Deux
allers-retours pour un réglage.

Les deux réglages sont maintenant dans la carte de la machine concernée, dans l'ordre de leur
dépendance (adresse, puis clé — la clé est rangée chez Ayla sous le DSN, que seule la machine
fournit). Le bloc est **ouvert d'office sur une machine incomplète**, replié sur une machine prête :
c'est le réglage qui manque qu'il faut avoir sous les yeux.

Le point qui rend la chose possible : chaque requête **nomme sa machine** (`forId`), au lieu de viser
la machine courante (`mfetch`). C'est ce qui permet de configurer une cafetière sans quitter celle
qu'on regarde — et c'est aussi ce qui aurait envoyé la saisie à la mauvaise machine si on avait
gardé `mfetch` par réflexe. Vérifié : avec `m1` affichée, l'enregistrement de l'adresse depuis la
carte de `m3` ne modifie que `m3`, et le verdict de la sonde s'affiche sous cette carte-là.

`/cle-lan` disparaît du menu et **redirige** (307) vers `/machines` : des liens et des onglets
pointent encore là, et six messages du serveur nommaient cette page. Le menu ne garde donc que deux
entrées inconditionnelles, `/machines` et `/systeme` ; `nav.lanKey` est retirée du catalogue. Les
namespaces `lankey` et `machine` sont **réutilisés tels quels** — une quarantaine de chaînes qu'il
aurait été absurde de dupliquer.

`/api/machines` livre en une requête tout ce que la page affiche : les deux dates de mise en cache
par machine (`ipCachedAt`, `lanKeyCachedAt`), l'adresse annoncée par le serveur, et l'état de la
configuration de découverte. Sinon il aurait fallu interroger `/api/machine` et `/api/lankey` une
fois par machine pour obtenir les mêmes réponses.

**Un garde-fou trouvé par l'usage.** Au premier essai réel de la page, la même cafetière s'est
retrouvée enregistrée deux fois — une fois par nom court, une fois par nom complet. C'est l'erreur
naturelle, et elle échoue **en silence** : l'identification se faisant par adresse source, une seule
des deux entrées reçoit la session, l'autre reste muette pour toujours sans rien dire. Un
avertissement le signale maintenant, sur la base du **DSN** (le numéro de série : deux entrées qui le
partagent sont le même appareil), avec l'adresse saisie ou résolue comme second indice. Vérifié en
direct sur le cas réel : les deux cartes portent l'avertissement, `cafe` et `cafe.maison.lan` résolvant
bien la même adresse.

**Piège rencontré, à ne pas réapprendre** : `server.mjs` n'est pas rechargé à chaud. Une modification
de `machineSummary` sans redémarrage laisse l'IHM — elle, rechargée par HMR — lire un champ que
l'API ne renvoie pas encore, et la page casse sur un `undefined`. Le symptôme accuse le composant ;
la cause est le serveur qui n'a pas redémarré.

### Modèle lu automatiquement, nom modifiable, écrans dégraissés (2026-08-20)

**Le modèle n'était pas calculé à l'ajout d'une machine.** Il ne pouvait pas l'être : il vient du
numéro de série (`d270_serialnumber`), donc d'une **lecture de propriété Ayla**, qui exige une
session chiffrée — donc la clé LAN. Au moment où l'on ajoute une machine, on n'a que son adresse et
le DSN qu'elle vient de donner. Constaté sur le cas réel : une deuxième entrée avec DSN et clé LAN
affichait « Modèle : inconnu », parce que rien n'avait jamais demandé le numéro de série.

`maybeReadModel(m)` le demande au **premier moment possible** : celui où le second prérequis tombe,
dans un sens ou dans l'autre — clé obtenue alors que l'adresse était là, ou adresse saisie alors que
la clé venait de l'environnement. D'où l'appel depuis `POST /api/lankey` et `POST /api/machine`, et
un garde qui rend l'ordre indifférent (modèle déjà connu, prérequis manquant, ou import/programme en
cours → on ne fait rien). Une lecture pure, aucun effet sur la machine. Un bouton « lire le
modèle » / « relire » couvre le reste : machine configurée avant que ça n'existe, lecture expirée,
simple vérification. La réponse n'arrivant pas dans le corps du POST (c'est la machine qui se
connecte et pousse la propriété), la page scrute la liste, bornée à 15 s.

**Le nom était modifiable, mais invisible.** Le champ était noyé au milieu des lignes
d'information — qui sont des faits en lecture seule — avec un bouton grisé tant qu'on n'avait rien
tapé : il avait l'air cassé. Il est remonté en tête du bloc de configuration, avec son propre titre,
un bouton actif dès que la valeur change, et un bouton « vider » qui rend son nom dérivé à la
machine. Le libellé du bouton de bascule passe de « Configurer son adresse et sa clé » à
« Configurer », puisqu'il couvre maintenant trois réglages. Vérifié : renommage en « Cuisine », puis
retour au nom dérivé.

**Moins de texte.** Le formulaire était précédé de quatre paragraphes de prose : la dépendance
adresse → DSN → clé, les quatre étapes du protocole Gigya/Ayla, la note sur les noms d'hôte en
conteneur, le sort du mot de passe. Tout cela est **déjà** dans `doc/` et `DOCKER.md`, où c'est à sa
place ; un écran de saisie n'a pas à le répéter. Il ne reste qu'une ligne courte par champ — la forme
attendue d'une adresse, le sort du mot de passe — et les avertissements. La carte passe de plus de
2 000 caractères à 729. Les verdicts et les confirmations, eux, ne sont pas raccourcis : ils
n'apparaissent qu'après une action, et c'est là qu'ils servent. Dix-neuf clés devenues inutiles sont
retirées du catalogue, qui passe de 589 à 571 messages.

### Supprimer la dernière machine : remise à zéro au lieu d'un refus (2026-08-20)

Le refus (409) était le mauvais choix. Il renvoyait vers « oublier l'adresse » et « oublier la clé »
**sur une page qui n'existe plus**, il fallait donc deux actions à la main pour obtenir un résultat
que le bouton pouvait produire — et même en les faisant, le cache de lectures restait en place.

La dernière machine ne peut effectivement pas quitter le registre : l'application n'a aucun état
« aucune machine » à montrer, et une base vide s'en recréerait une au démarrage. Mais on peut faire
ce que la suppression voulait dire : `forMachine(id).reset()` efface les cinq tables de cette
machine en une seule transaction — adresse, clé LAN, DSN, modèle, sommes de contrôle, propriétés,
statistiques, grains, recettes. L'entrée survit, vide, et l'état d'exécution est reconstruit.

Trois détails qui comptent :

- les `setTimeout` en vol (balayage des grains, lecture des statistiques) référencent l'ancien
  enregistrement : ils sont désarmés **avant** le remplacement, sinon un balayage en cours
  continuerait à s'annoncer à l'ancienne adresse, sur un objet absent du registre — donc invisible ;
- la réponse porte `envRestored` : ce que `.env.local` force revient aussitôt, et le dire est la
  différence entre « ça a marché » et « ça n'a rien fait » ;
- le bouton s'appelle « Tout effacer » quand il ne reste qu'une machine, et « Supprimer » sinon. Les
  deux confirmations nomment ce qui part ; seul le sort de l'entrée diffère.

Vérifié sur une **copie** de la base réelle avant de toucher à quoi que ce soit : 58 propriétés,
62 statistiques, 6 profils de grains, adresse, clé LAN, DSN et modèle effacés, l'entrée `m1`
conservée. Le chemin HTTP, lui, n'a pas encore été joué en direct : `server.mjs` n'est pas rechargé
à chaud et le serveur de développement tournait avec la version précédente.

### Première lecture automatique : modèle ET noms (2026-08-20)

`maybeReadModel` devient `maybeInitialRead` et demande aussi les **noms** — ceux des profils et ceux
des recettes personnalisées, deux familles couvertes par la même somme de contrôle, et celles qui
font qu'un emplacement renommé sur la machine s'affiche sous son nom partout (`readNames`).

Neuf propriétés au premier passage : le numéro de série, quatre propriétés de noms de profils et
quatre de noms de recettes perso (les variantes Striker répondent vide, ce qui compte comme lu).
La file est construite **à partir de ce qui manque**, propriété par propriété : la fonction est donc
idempotente sans drapeau « déjà fait », et une machine dont le modèle est connu mais les noms pas
encore lus obtient quand même ses noms. Vérifié sur les deux états réels : file de 8 propriétés sur
la machine dont le modèle était déjà lu, de 9 après une remise à zéro.

Cet import ne pose **aucune** marque « sommes à jour ». La poser obligerait à répliquer la règle de
`/api/profiles/import`, et une marque posée à tort fait sauter la relecture des noms jusqu'à un
`force: true` : le coût d'une lecture inutile est sans commune mesure.

**Les deux mécanismes précédents sont validés en direct — par l'usage, pas par un test.** L'ordre
d'écriture des valeurs `meta` de la base réelle le raconte sans ambiguïté : `machineIp` et `dsn` à la
même seconde (adresse saisie, sonde qui résout le DSN), `lanKey` 22 s plus tard (récupération
réussie), puis `importedAt` et `model` 15 s après — c'est-à-dire la lecture du modèle déclenchée
toute seule. Et le `createdAt` de l'entrée `m1` est inchangé alors que ses 58 propriétés, ses
62 statistiques et ses 6 profils de grains ont disparu : c'est bien la remise à zéro sur place, pas
une suppression suivie d'une recréation au démarrage.

### La page suit les lectures au lieu de demander un rafraîchissement (2026-08-20)

Défaut constaté sur la machine réelle : les journaux montraient la récupération du modèle, la carte
affichait « Modèle : inconnu, 0 propriétés ». Le serveur avait tout enregistré — `model` et
`importedAt` écrits **2 secondes** après `lanKey`.

La cause n'est pas un cache : une lecture de propriété n'est pas synchrone. Le POST rend la main dès
que l'annonce (`local_reg`) est faite, et c'est la **machine** qui se connecte ensuite pour pousser
la valeur. Le `load()` qui suit l'action arrive donc systématiquement trop tôt.

`machineSummary` expose maintenant `reading` (file restante, lues, échecs, propriété en attente) et
`running` (programme ECAM en cours), et la page scrute toutes les 2 s tant que l'un des deux est
vrai. Un badge « lecture… n restantes » le montre.

Un détail qui compte : `reading` vérifie la **fenêtre** de l'import, pas seulement son drapeau
`active`. Celui-ci ne retombe que quand la machine vient chercher la commande suivante
(`nextImportData`) — si elle ne se connecte jamais, il resterait vrai indéfiniment, et une interface
qui scrute tant qu'il est vrai scruterait pour toujours. Aucune borne n'est donc nécessaire côté
page : la borne est dans la donnée.

Le message ne dit plus « rafraîchissez dans quelques secondes » : c'était refiler le travail.

### L'état est poussé, plus sondé (2026-08-20)

Le sondage toutes les 2 s re-téléchargeait la liste entière pour voir un champ changer. Remplacé par
un flux **Server-Sent Events** sur `GET /api/events`.

**Le déclencheur est le journal.** Tout changement d'état significatif de ce serveur passe déjà par
`L()` : propriété reçue, import démarré ou terminé, commande servie, clé appliquée, adresse changée.
S'y brancher évite d'instrumenter vingt endroits — et d'oublier le vingt-et-unième. Regroupement sur
250 ms, un import journalisant une ligne par propriété.

Ce que le journal ne peut pas dire : la **fin** d'une fenêtre expirée sans que la machine se soit
connectée n'écrit aucune ligne. Sans le veilleur `sseWatch()`, le badge « lecture… » resterait
affiché à décrire un import qui n'existe plus. Il ne tourne que pendant qu'une fenêtre est ouverte
et s'arrête après une dernière émission — celle qui remet les champs à zéro.

Côté page, la réactivité est **fine** : l'état poussé est fusionné machine par machine, et une
machine inchangée garde son identité d'objet, donc React ne redessine pas sa carte. Sans ça chaque
évènement reconstruirait toutes les cartes, ce qui ramènerait le défaut en poussé au lieu de sondé.
Repli conservé : si le flux échoue, scrutation, et seulement pendant qu'une lecture tourne.

**Vérifié sur un banc d'essai** — une copie de `server.mjs` avec Next remplacé par un bouchon, sur le
port 3999, une copie de la base, et `SERVER_IP` en boucle locale pour qu'aucune trame ne parte vers
la machine :

| Contrôle | Résultat |
|---|---|
| en-têtes | `text/event-stream`, `no-cache, no-transform`, `keep-alive`, pas de `Content-Length` |
| à l'abonnement | état complet immédiat, sans attendre le premier changement |
| renommage d'une machine | une trame poussée, avec le nouveau libellé |
| import de 2 propriétés | `reading` apparaît à `remaining: 2` |
| fin de la fenêtre (30 s) | `reading` repasse à `null`, puis le veilleur s'arrête |

Les trames surnuméraires observées pendant le test venaient du banc lui-même : avec `SERVER_IP` en
boucle locale, le keep-alive journalise un échec de `local_reg` toutes les 2,5 s, et chaque ligne de
journal émet. En fonctionnement normal `local_reg` réussit sans rien écrire.

### Vérifier les mises à jour OTA, sans AYLA_TOKEN (2026-08-20)

Deux défauts sur le bloc OTA de la page Système. Le premier, cosmétique : il affichait
« désactivée », puis une phrase se terminant par « vérification cloud désactivée » — le libellé et la
note disaient la même chose. Le second, réel : la vérification exigeait un jeton Ayla brut dans
`AYLA_TOKEN`, que personne n'a sous la main.

Or la récupération de la clé LAN obtient **déjà** un `access_token` Ayla, et le jetait. Le même
jeton ouvre `dsns/<DSN>/ota.json`. `aylaAccessToken()` est donc extrait de `discoverLanKey` — deux
usages en ont besoin — et `checkCloudOta()` lit la fiche avec.

Trois conséquences :

- la récupération de la clé **relève l'OTA au passage**, au mieux disant : un échec là ne doit pas
  faire échouer la récupération, qui est le but de l'appel ;
- `POST /api/ota` refait la vérification à la demande — identifiants d'abord, `AYLA_TOKEN` en repli ;
- **seul le résultat est mémorisé** (`meta.otaCheck`), jamais le jeton. Ouvrir une page ne doit
  déclencher aucun appel au cloud, et rien ne doit rester qui puisse en déclencher un plus tard.

C'est aussi ce qui corrige un défaut de fond : `GET /api/system` appelait le cloud **à chaque
affichage** de la page Système quand `AYLA_TOKEN` était présent. Pour un projet dont l'objet est le
pilotage local, c'était le mauvais réglage par défaut. La fonction ne fait plus que rapporter le
dernier relevé — et la page répond en 0,27 s au lieu de jusqu'à 8 s.

L'action est sur `/machines`, à côté des identifiants qu'elle réutilise ; `/systeme` affiche le
relevé, sur **une** ligne. Le formulaire d'identifiants reste hors de la fiche technique, comme
convenu.

**Vérifié sur le banc d'essai** (Next bouchonné, port 3999, copie de la base) :

| Contrôle | Résultat |
|---|---|
| `GET /api/ota` | `tokenConfigured: false`, `last: null`, DSN présent — aucun appel au cloud |
| `GET /api/system` | 0,27 s, `ota.cloud` = `{tokenConfigured, last}` |
| `POST /api/ota` sans rien | HTTP 400, `needsCredentials`, message explicite |
| `POST /api/ota` avec un JWT invalide | vrai appel à `token_sign_in.json` d'Ayla → HTTP 422 → 502 avec le message. Branche `jwt`, donc Gigya n'est pas sollicité et aucun échec de connexion n'est enregistré pour un compte |

Le chemin heureux — vrais identifiants, vraie fiche OTA — demande un mot de passe : il reste à
jouer par l'utilisateur.

### Jeton Ayla : cascade à quatre niveaux (2026-08-20)

Le principe retenu est celui qui valait déjà pour la clé LAN — frapper un jeton au moment du besoin,
l'utiliser, ne rien conserver — étendu d'un niveau qui évite de retaper le mot de passe.

| Niveau | Coût | Ce qui est conservé |
|---|---|---|
| 1. jeton d'accès en mémoire, non expiré | aucun appel | rien qui survive au processus |
| 2. `refresh_token` mémorisé (opt-in) | un appel à Ayla | le jeton de renouvellement, sur disque |
| 3. identifiants du compte | les quatre sauts | rien |
| 4. `AYLA_TOKEN` | — | rien (déjà dans `.env.local`) |

Le niveau 1 rend gratuite une deuxième vérification dans la même session : `m.aylaToken` garde le
jeton pour la durée annoncée par `expires_in`, avec une marge d'une minute pour ne pas repartir avec
un jeton qui expire pendant la requête.

**Le niveau 2 est le seul secret de niveau COMPTE que ce serveur puisse écrire.** D'où : case
décochée par défaut, étiquetée sans détour, rangée dans `settings` (c'est un identifiant de compte,
pas d'appareil — deux machines du même compte n'en gardent pas deux copies), jamais renvoyée par un
endpoint, oubliable, et emportée par « Tout effacer ». La clé LAN ne donne que le pilotage local
d'une cafetière, et encore faut-il être sur le réseau ; un `refresh_token` agit sur le compte
De'Longhi jusqu'à révocation. La distinction est écrite dans `CLAUDE.md`, section secrets.

Deux détails qui viennent du protocole : Ayla **fait tourner** le `refresh_token` à chaque usage,
donc garder l'ancien casserait l'appel suivant ; et Ayla ne renvoie pas toujours de `refresh_token`,
donc l'interface n'annonce la mémorisation que si le serveur confirme l'avoir faite — une case cochée
sans effet serait un mensonge.

**Le chemin de renouvellement est vérifié, et c'est le banc d'essai qui l'a dit.** Avec un jeton
bidon injecté dans la base, Ayla répond `HTTP 401 Your refresh token is not found` : une réponse
**applicative**, là où un mauvais chemin aurait donné un 404. Le chemin (`/users/refresh_token.json`)
et la forme du corps (`{ user: { refresh_token } }`) sont donc bons. Ma documentation les donnait
pour non vérifiés : corrigé.

| Contrôle sur le banc | Résultat |
|---|---|
| `GET /api/cloudsession` | `set: false` |
| `DELETE` sur une session absente | `removed: false`, pas d'erreur |
| `POST /api/ota` sans rien | 400 `needsCredentials` |
| `POST /api/ota`, JWT invalide + `remember` | 502, et **aucune** session mémorisée — rien à retenir d'un échange raté |
| renouvellement avec un faux jeton | 401 applicatif, session **oubliée**, puis 400 réclamant les identifiants |

Reste non éprouvé : le chemin heureux, qui demande un vrai mot de passe.

### Le catalogue de boissons devient celui du modèle (2026-08-20)

C'était la limite annoncée du multi-machines, et la raison invoquée pour ne pas la lever était
**fausse**. `CLAUDE.md` et un commentaire d'`applyIdentity` affirmaient que basculer le catalogue
exigerait de rendre l'arithmétique des propriétés dépendante du modèle, « ce 21 étant le nombre de
recettes standard DU modèle ». C'était une inférence. La lecture de `p258z7/z.java` la contredit :

```
v(profileId, template)  ->  i11 = (profileId - 1) * 21      puis un offset FIXE par nom :
                            rec_espresso + 39, rec_regular + 40 … rec_brew_over_ice + 59
t(profileId, template)  ->  i10 = (profileId - 1) * 6       puis bs_recipe_01 + 160 … 165
bornes                  ->  d001_rec_espresso … d021_rec_brew_over_ice, même ordre
```

Le `21` est une **constante de l'app**, et les offsets sont attachés au **nom** de la boisson, pas à
sa position dans le catalogue d'un modèle. Autrement dit : la numérotation des propriétés Ayla est un
espace de noms De'Longhi figé, et un modèle en utilise simplement un sous-ensemble. Changer de
catalogue ne change donc **aucune** adresse — et ne périme aucune lecture déjà faite.

Deux défauts que cette lecture a révélés, dans le code qui tournait :

- **le pas du Bean System manquait.** `d160_<p>_bs_recipe_01` était rendu pour tous les profils,
  alors que la formule est `160 + (p − 1) × 6`. Le nom demandé pour p ≥ 2 n'existe pas : la lecture
  répondait vide et était classée « absente sur ce modèle ». La recette Bean Adapt des profils 2 à 5
  était donc illisible, sans que rien ne le dise ;
- **les offsets étaient dérivés de l'index** dans le catalogue (`39 + i`). Juste sur ce modèle par
  coïncidence — son catalogue est un préfixe de la liste globale — et décalé de un sur tout modèle
  auquel manquerait une boisson du milieu.

Et une limite qu'il fallait constater plutôt que supposer : **les recettes perso n'ont pas de
formule par profil.** L'app écrit `d200_1_cstm_recipe_01` … `d205_1_cstm_recipe_06` en dur, et
aucune fonction ne les construit avec un profil variable, contrairement aux recettes standard et au
Bean System. Le profil 1 est donc imposé ; demander `d200_2_…` serait inventer un nom.

**Ce que la table constructeur permet réellement**, sur les 30 modèles connectés :

| Famille | Modèles | Verdict |
|---|---|---|
| PD_SOUL (28 boissons, 5 profils) | 5 | servi |
| PD_SOUL_BETTER (22 boissons, 3 profils, 3 perso) | 5 | servi |
| STRIKER_BEST (48 boissons) | 7 | catalogue servi, **22 boissons marquées non adressables** — les familles « iced » et « mug » passent par l'autre nomenclature (`d%s_rec_%s_…`, pas de 43), non implémentée et non vérifiable sans une telle machine |
| STRIKER_GOOD | 13 | **aucune recette dans la table** — l'app obtient la leur ailleurs. Catalogue par défaut, signalé comme pis-aller |

**La génération se déduit aussi du modèle**, et là encore en portant la règle de l'app plutôt qu'en
la devinant : `p258z7/s.r()` rend vrai quand l'`appModelId` **contient** « striker », sans égard à la
casse. Elle décide des propriétés de transport, donc rester sur « classic » face à une Striker, c'est
parler dans le vide. Déduite du modèle **détecté** et non du catalogue : quand le catalogue est un
pis-aller, il appartient à un autre modèle et dirait « classic » d'une Striker.

`machine-model.json` est supprimé — plus personne ne l'importait, et le laisser aurait fait une
deuxième source de vérité pour les mêmes recettes.

| Vérifié sur le banc d'essai | Résultat |
|---|---|
| 17055 (PD_SOUL) | 28 boissons, 5 profils, 6 perso — **tous les noms de propriétés identiques** à l'implémentation précédente pour le profil 1, celle vérifiée sur la vraie machine |
| 17052 (PD_SOUL_BETTER) | 22 boissons, 3 profils, 3 emplacements perso, `d081_3_rec_espresso` pour le profil 3 |
| 17079 (STRIKER_BEST) | 48 boissons, 22 non adressables signalées, génération **striker** déduite |
| 17069 (STRIKER_GOOD) | repli sur le catalogue par défaut, dit dans le journal, et génération **striker** quand même |
| build de production | 12 pages, dont `/machines` |

Reste non éprouvé : une machine d'un autre modèle que celle-ci. Le contrôle qui compte est donc la
non-régression sur les noms de propriétés, faite exhaustivement.

### Réalignement de l'interface après la bascule du catalogue (2026-08-20)

Trois écarts laissés par le commit précédent, tous du même genre : le serveur avait changé, pas ce
qui le lit ni ce qui le décrit.

**Une ligne vide.** `/systeme` lit `model.connectionType`, que la table extraite ne portait pas —
`extract-catalogs.mjs` ne le reprenait pas de la source. Ajouté, table régénérée : « Wi-Fi ».

**Une réponse inutilement grosse.** `/api/system` expédiait `model.recipes` en entier — 28 entrées
ici, 48 sur une Striker — à chaque affichage de la page, pour des champs que personne n'y lit et que
`/api/beverages` sert déjà. Remplacé par la fiche courte : **524 octets** au lieu de plusieurs
kilo-octets.

**Une phrase qui disait l'inverse.** `machines.modelReadMismatch` annonçait encore que « les lectures
de recettes peuvent être fausses sans en avoir l'air » — le discours d'avant la bascule, quand le
catalogue ne changeait pas. Il change désormais : le message dit maintenant que le catalogue en
service est un remplaçant.

Et un quatrième, celui-là trouvé en relisant l'écran : le premier bloc de `/systeme`, titré « Modèle
de machine », affiche la fiche du catalogue **en service**. Quand ce catalogue est un pis-aller, ce
bloc décrit donc un modèle qui n'est pas celui de la machine — et il le taisait. `/api/system` renvoie
maintenant `fallback` et `detectedKey`, et le bloc porte un avertissement qui nomme les deux.

**Vérification systématique** plutôt que de l'œil : pour chaque page, tous les chemins `d.x.y`
extraits de la source, confrontés à la charge utile réelle du banc d'essai.

| Page | Chemins lus | Verdict |
|---|---|---|
| `/systeme` | 51 | tous présents (`local.error` mis à part, absent quand la sonde réussit — lecture conditionnelle) |
| `/machines` | 32 | tous présents |
| `/statistiques` | 3 | tous présents |
| `/bean-adapt` | 2 | tous présents |

Build de production : 12 pages.

### La page des grains : /beans, flux poussé, cartes, et une bibliothèque locale (2026-08-20)

**Renommée** de `/bean-adapt` en `/beans`, l'ancienne adresse redirigeant en 307 — des onglets
pointent encore là, et plusieurs messages du serveur nomment la fonction « Bean Adapt », qui reste
le libellé du menu : c'est le nom De'Longhi de la fonction, pas celui de la page. Les endpoints
gardent leur nom (`/api/beanadapt*`), comme `/api/machine` l'a gardé après la fusion des pages.

**L'abonnement au flux est extrait** dans `src/app/events.ts` : deux pages en dépendent, et une
deuxième copie aurait divergé au premier correctif. Le rappel y est gardé dans une **référence** —
passé en dépendance de l'effet, une fonction recréée à chaque rendu fermait et rouvrait la connexion
en boucle.

Cette page attendait avec deux minuteurs : `setTimeout(refresh, 6000)` après une lecture,
`setInterval(refresh, 3000)` pendant un balayage. Deux minuteurs qui ne pouvaient que se tromper —
trop tôt ils montraient l'état d'avant, trop tard ils faisaient attendre pour rien. Ils sont
remplacés par deux signaux tirés du flux : `importedAt` qui bouge (la machine a écrit ; `0xBA` passe
par `putBeanSystem`, qui horodate) ou une lecture qui vient de **se terminer** (un balayage enchaîne
un programme par grain, et sa fin est le moment de relire même si rien n'a été écrit).

Vérifié dans le navigateur, sur l'application complète servie depuis un arbre isolé : une lecture
demandée fait apparaître le badge « lecture en cours », et à la fin de la fenêtre la page relit
`/api/beanadapt` d'elle-même — une requête de plus, mesurée, sans aucun minuteur dans la page.

**Deux listes, en cartes.** Les six emplacements de la machine, et une **bibliothèque locale** de
configurations mémorisées côté serveur. La raison d'être de la seconde : la machine n'a que six
emplacements, dont un qui n'est pas un café, et les écraser fait perdre le réglage précédent — on ne
peut pas essayer une mouture puis revenir. La bibliothèque garde un réglage par café sans occuper
d'emplacement.

Rangées dans `meta.beanPresets`, par machine : quelques lignes, et une table aurait coûté une version
de schéma pour un tableau de cinq entrées. Par machine comme les recettes, parce qu'un réglage vaut
pour les bornes d'un modèle et que supprimer une machine doit emporter ses configurations.

Deux détails qui comptent : les bornes sont vérifiées **à l'enregistrement** et pas seulement à
l'écriture (mémoriser un réglage inapplicable ne servirait qu'à faire échouer l'écriture plus tard,
loin de la saisie), et `machineSummary` porte un compteur `beanPresets` parce que `setMeta` ne touche
pas `importedAt` — à dessein, c'est la date des données LUES — donc sans lui un second onglet
n'apprendrait jamais que la bibliothèque a changé.

| Contrôle | Résultat |
|---|---|
| création | `b1`, bornes vérifiées, horodaté |
| mouture 99 | refusée : « hors bornes (1–7) » |
| modification | `createdAt` conservé, `at` mis à jour |
| persistance | relue depuis la base après redémarrage du serveur |
| suppression | `removed: true` ; identifiant inconnu → `false`, sans erreur |
| signal | `beanPresets` dans `/api/machines` suit le nombre |
| « mémoriser » depuis une carte machine | crée l'entrée avec le nom du grain, la carte apparaît |
| écriture dans un emplacement | l'index 0 est exclu des cibles, la confirmation nomme le réglage écrasé |

`alignItems: start` sur les grilles : sans lui une carte courte s'étirait à la hauteur de la plus
grande de sa ligne, ce qui laissait des blancs et faisait croire à une donnée manquante.
