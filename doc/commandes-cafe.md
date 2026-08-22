# Commandes café — protocole ECAM (préparation des boissons)

> **Note.** Ce document est le fruit d'une analyse menée sur une machine réelle. Les valeurs
> propres à cet exemplaire ont été remplacées par des marqueurs : `IP_MACHINE`,
> `AC000W0XXXXXXXX` (numéro de série), `XX:XX:XX:XX:XX:XX` (adresse MAC), `VLAN_IOT`,
> `IFACE_IOT`, et « Grain A/B/… » pour les noms saisis sur la machine. Les références à
> `secrets.md` désignent un fichier volontairement absent du dépôt : il contenait la clé LAN et
> des données personnelles.

Analyse du 2026-08-19, extraite de `p097j6/d.java` (constructeurs de trames) et
`it/delonghi/service/DeLonghiWifiConnectService.java` (dispatch), APK 4.9.6.

Objectif : disposer des trames exactes pour **déclencher chaque programme de café** depuis un
serveur LAN mode maison. Toutes les trames sont ensuite encapsulées et envoyées comme décrit dans
`analyse-connexion-wifi.md` § 4.3 (base64 → propriété `data_request`).

> Rappel format ECAM (§ 4.4 du doc principal) : `0D <len> <cmd> <flag> <payload…> <crc16>`,
> `len` = taille totale − 1, CRC-CCITT init **0x1D0F** sur tous les octets sauf les 2 derniers.
> En envoi (app → machine) l'en-tête est `0x0D` et le flag `0xF0`.

---

## 1. La commande de préparation — `0x83`

Une seule commande sert à préparer **toutes** les boissons : `0x83`
(`dispenseBeveragePacket`). Quatre constructeurs la produisent, selon le type de boisson :

| Méthode | Nom | Usage |
|---|---|---|
| `O()` | dispenseBeveragePacket | boissons **chaudes** (cas standard) |
| `Q()` | dispenseColdOrToGoBeveragePacket | boissons **froides** / **to-go cold** |
| `P()` | dispenseColdOrToGoBeveragePacket | variante (mêmes octets que O, dispatch cold/programmé) |
| `R()` | dispenseColdOrToGoColdBrewBeveragePacket | **cold brew** |

Les quatre produisent la **même structure d'octets** (`cmd=0x83`, `flag=0xF0`). Elles ne diffèrent
que par les paramètres inclus dans la charge utile (les variantes froides ajoutent `ICED`,
`MUG_SIZE`, `NUM_ICE_CUBES`).

### 1.1 Structure de la trame

```
offset   contenu
  0       0x0D                         en-tête (envoi)
  1       len = (taille totale) − 1
  2       0x83                         commande « préparer boisson »
  3       0xF0                         flag
  4       beverageId                   identifiant de la boisson (voir § 2)
  5       mode                         enum s (voir § 3) ; | 0x80 si « checkValues »
  6..n    liste de paramètres          TLV : id (1 o) + valeur (1 ou 2 o) — voir § 4
  n+1     (profileId << 2) | action    profil (1..5) et action enum b (voir § 3)
  n+2..3  CRC16
```

- **`checkValues`** (booléen) : quand vrai, l'app met le bit 0x80 sur l'octet de mode. Utilisé
  pour un contrôle préalable ; laisser faux pour une préparation normale.
- **`profileId`** : le profil utilisateur actif (1 à 5), lu depuis la machine (`ecamMachine.B()`).
- Le nombre d'octets d'un paramètre (1 ou 2) dépend de sa **longueur déclarée** dans la
  `DefaultsTable` de la machine (`z.Z(id)`). Les quantités liquides (`COFFEE`, `MILK`,
  `HOT_WATER`) sont sur 2 octets big-endian ; le reste sur 1 octet.

### 1.2 Ce que fait réellement l'app pour « lancer un café »

Dispatch dans `DeLonghiWifiConnectService` (lignes 3269-3330) — action toujours
`PREPARE_BEVERAGE` (2), mode selon le type :

| Type de boisson | Constructeur | mode (`s`) |
|---|---|---|
| chaude | `O()` | **`START` (1)** |
| froide / to-go cold | `Q()` | `START` (1) |
| chaude programmée | `P()` | `START_PROGRAM` (2) |
| cold brew | `R()` | `START_PROGRAM` (2) puis `CHECK_START` (3) |

**Recette minimale pour lancer un espresso** (beverageId 1, profil 1, sans paramètre surchargé) :

```
0D <len> 83 F0  01  01  <TLV paramètres>  ((1<<2)|2 = 0x06)  <crc16>
              bev  START                    profil1 + PREPARE
```

En pratique l'app envoie toujours la liste de paramètres de la recette (dose, arôme, température…).
Envoyer la boisson « nue » lance la recette par défaut de la machine.

### 1.3 Enregistrer une recette DANS un profil

Même commande `0x83`, mais **mode `DONTCARE` (0)** et **action `SAVE_BEVERAGE` (1)**
(`DeLonghiWifiConnectService:2959`). Le profil visé est dans le dernier octet de données,
`(profileId << 2) | action` — c'est ce qui permet de personnaliser une recette **par profil** :

```
0D <len> 83 F0 <beverageId> 00 <TLV paramètres> <(profileId<<2)|1> <crc16>
                             ↑ DONTCARE                        ↑ SAVE_BEVERAGE
```

Exemple réel (espresso, café 40 ml, arôme 4, vers le **profil 3**) :

```
0d 0d 83 f0 01 00 01 00 28 02 04 0d 15 86
                                    └ (3<<2)|1 = 0x0D
```

⚠️ C'est une **écriture persistante** : elle remplace la recette enregistrée de ce profil sur la
machine, comme une reprogrammation depuis l'écran. `DELETE_BEVERAGE (0)` supprime.

Dans le chemin Wi-Fi, l'enregistrement utilise **toujours** `SAVE_BEVERAGE` : les variantes
`SAVE_BEVERAGE_INVERSION (5)` n'apparaissent que dans les chemins Bluetooth (`EcamService`).

### 1.4 Inversion lait/café à la préparation

Pour **préparer**, l'app choisit `PREPARE_BEVERAGE_INVERSION (6)` au lieu de
`PREPARE_BEVERAGE (2)` quand le paramètre **`INVERSION (12)` de la recette vaut 1**
(`RecipeData.T()`, `it/delonghi/ecam/model/RecipeData.java:349` ; usage ligne 3396).

Sur ce modèle, `INVERSION` vaut 1 par construction pour le **flat white**, le **cappuccino
inversé**, le **cortado** et le **long black** (bornes lues : min 1 / défaut 1 / max 1). Envoyer
l'action 2 pour ces boissons est donc incorrect.

### 1.5 Arrêt d'une préparation en cours

Même commande `0x83`, mode **`STOPV2` (2)**, action `PREPARE_BEVERAGE` (ligne 3402/3410) :

```
0D <len> 83 F0 <beverageId> 02 <TLV> <(profileId<<2)|2> <crc16>
```

---

## 2. Identifiants de boisson (`beverageId`)

**Corrigé le 2026-08-19** après recoupement de deux sources concordantes :
`assets/MachinesModels.json` de l'APK (table « Machine Template » v1.510, entrée
`product_code` 0132217055 = ECAM 610.75.MB) et le logcat de l'app parlant à la machine
(`capture-reveil-app.txt`, `loadEspressoSoul` / `getClassicBeverages`).

> ⚠️ La 1re version de ce document déduisait les ids de l'ordre des propriétés Ayla
> (thé = 16, cortado = 18, brew over ice = 21…). **C'était faux** : les ids ne sont pas
> contigus et ne suivent pas la numérotation des propriétés. Envoyer 21 pour un
> « brew over ice » viserait une autre boisson.

Les 28 boissons de CE modèle (`nStandardRecipes: 18`, `nCustomRecipes: 6`, `nProfiles: 5`) :

| ID | Boisson | Propriété bornes | ID | Boisson | Propriété bornes |
|---:|---|---|---:|---|---|
| 1 | Espresso | `d001_rec_espresso` | 16 | Eau chaude | `d015_rec_hot_water` |
| 2 | Café (regular) | `d002_rec_regular` | 22 | Thé | `d016_rec_tea` |
| 3 | Café long | `d003_rec_long_coffee` | 23 | Verseuse (coffee pot) | `d017_rec_coffee_pot` |
| 4 | Espresso ×2 | `d004_rec_2x_espresso` | 24 | Cortado | `d018_rec_cortado` |
| 5 | Doppio+ | `d005_rec_doppio` | 25 | Long black | `d019_rec_long_black` |
| 6 | Americano | `d006_rec_americano` | 26 | Travel mug | `d020_rec_mug_to_go` |
| 7 | Cappuccino | `d007_rec_cappuccino` | 27 | Brew over ice | `d021_rec_brew_over_ice` |
| 8 | Latte macchiato | `d008_rec_latte_macchiato` | 200 | Espresso Bean Adapt | `d022_beansystem_1` |
| 9 | Caffelatte | `d009_rec_caffelatte` | 230 | Recette perso 1 | `d028_rec_custom_1` |
| 10 | Flat white | `d010_rec_flat_white` | 231 | Recette perso 2 | `d029_rec_custom_2` |
| 11 | Espresso macchiato | `d011_rec_espr_macchiato` | 232 | Recette perso 3 | `d030_rec_custom_3` |
| 12 | Lait chaud | `d012_rec_hot_milk` | 233 | Recette perso 4 | `d031_rec_custom_4` |
| 13 | Cappuccino doppio+ | `d013_rec_capp_doppio` | 234 | Recette perso 5 | `d032_rec_custom_5` |
| 15 | Cappuccino inversé | `d014_rec_capp_reverse` | 235 | Recette perso 6 | `d033_rec_custom_6` |

**Il n'y a pas d'id 14, ni 17 à 21.** Les ids 19-27 signifient autre chose sur les machines
protocole v1 (`p127m6/a.java`, `C0391a.a(int)` branche sur `g.h().o()`) — cette machine est
en **protocole v2**, la table ci-dessus est celle qui s'applique.

La **liste des boissons n'est jamais demandée à la machine** : c'est l'app qui la connaît via
`MachinesModels.json`, indexée par les 5 derniers caractères du `product_code` (`17055`).
La machine ne fournit que les *valeurs* (§ 6). Table reprise dans
`lan-server/src/lib/machine-catalogs.json` (extraite) + `src/lib/beverages.mjs` (libellés FR,
catégories, mapping des propriétés).

Chaque boisson déclare aussi la liste des **paramètres qu'elle accepte** (`ingredients`) :
par exemple l'espresso n'en a que 7 (`1,2,4,8,24,25,27`) — exactement les 7 paramètres que
contient sa trame de bornes réelle.

## 3. Enums de contrôle

### 3.1 Mode — `p127m6/s` (octet 5)

| Nom | Valeur | Sens |
|---|---:|---|
| `DONTCARE` | 0 | indifférent (utilisé pour save/delete) |
| `START` | 1 | **démarrer la préparation** |
| `START_PROGRAM` | 2 | démarrer une préparation programmée |
| `STOPV2` | 2 | **arrêter** (même valeur que START_PROGRAM ; le contexte diffère) |
| `CHECK_START` | 3 | vérification avant démarrage (cold brew) |
| `STOP` | 4 | arrêt (variante) |
| `STOP_PROGRAM` | 5 | arrêt de programme |
| `SKIP_RINSE` | 6 | sauter le rinçage |
| `ADVANCED_MODE` | 7 | mode avancé |

> `START_PROGRAM` et `STOPV2` valent tous deux **2**. La distinction se fait par l'octet d'action
> (§ 3.2), pas par le mode seul.

### 3.2 Action — `p127m6/b` (bits bas du dernier octet de données)

| Nom | Valeur | Sens |
|---|---:|---|
| `DELETE_BEVERAGE` | 0 | supprimer la boisson |
| `SAVE_BEVERAGE` | 1 | enregistrer |
| `PREPARE_BEVERAGE` | 2 | **préparer** |
| `PREPARE_AND_SAVE_BEVERAGE` | 3 | préparer et enregistrer |
| `SAVE_BEVERAGE_INVERSION` | 5 | enregistrer (ordre lait/café inversé) |
| `PREPARE_BEVERAGE_INVERSION` | 6 | préparer (inversé) |
| `PREPARE_SAVE_BEVERAGE_INVERSION` | 7 | préparer + enregistrer (inversé) |

Dernier octet de données = `(profileId << 2) | action`. Exemple profil 1 + préparer :
`(1<<2)|2 = 0x06`. L'« inversion » concerne l'ordre de service lait-puis-café (macchiato vs latte).

---

## 4. Paramètres de recette — `p127m6/i`

Chaque paramètre inséré dans la trame est un couple `id` + `valeur`. Table des IDs (vérifiée) :

| ID | Nom | Signification probable | Octets |
|---:|---|---|:---:|
| 0 | `TEMP` | Température café | 1 |
| 1 | `COFFEE` | Quantité de café (ml) | **2** |
| 2 | `TASTE` | Intensité / arôme | 1 |
| 3 | `GRANULOMETRY` | Finesse mouture | 1 |
| 4 | `BLEND` | Mélange | 1 |
| 5 | `INFUSION_SPEED` | Vitesse d'infusion | 1 |
| 6 | `PREINFUSIONE` | Pré-infusion | 1 |
| 7 | `CREMA` | Crema | 1 |
| 8 | `DUExPER` | 2 tasses (double) | 1 |
| 9 | `MILK` | Quantité de lait (ml) | **2** |
| 10 | `MILK_TEMP` | Température lait | 1 |
| 11 | `MILK_FROTH` | Mousse de lait | 1 |
| 12 | `INVERSION` | Ordre lait/café | 1 |
| 13 | `THE_TEMP` | Température thé | 1 |
| 14 | `THE_PROFILE` | Profil thé | 1 |
| 15 | `HOT_WATER` | Eau chaude (ml) | **2** |
| 16 | `MIX_VELOCITY` | Vitesse mélange | 1 |
| 17 | `MIX_DURATION` | Durée mélange | 1 |
| 18 | `DENSITY_MULTI_BEVERAGE` | Densité multi-boisson | 1 |
| 19 | `TEMP_MULTI_BEVERAGE` | Température multi-boisson | 1 |
| 20 | `DECALC_TYPE` | Type détartrage | 1 |
| 21 | `TEMP_RISCIACQUO` | Température rinçage | 1 |
| 22 | `WATER_RISCIACQUO` | Eau de rinçage | 1 |
| 23 | `CLEAN_TYPE` | Type nettoyage | 1 |
| 24 | `PROGRAMABLE` | Programmable | 1 |
| 25 | `VISIBLE` | Visible | 1 |
| 26 | `VISIBLE_IN_PROGRAMMING` | Visible en prog. | 1 |
| 27 | `INDEX_LENGTH` | Index de calibre (voir note) | 1 |
| 28 | `ACCESSORIO` | Accessoire (carafe lait…) | 1 |
| 31 | `ICED` | Glacé | 1 |
| 32 | `MUG_SIZE` | Taille mug | 1 |
| 33 | `MUG_ADJUST` | Ajustement mug | 1 |
| 37 | `NUM_ICE_CUBES` | Nombre de glaçons | 1 |
| 38 | `INTENSITY` | Intensité | 1 |
| 39 | `RINSE` | Rinçage | 1 |

Filtre `E0()` — paramètres réellement insérés dans une trame de dispensing : `id < 23`, plus
`ACCESSORIO(28)`, `ICED(31)`, `INDEX_LENGTH(27)`, `MUG_ADJUST(33)`, `INTENSITY(38)`, `RINSE(39)`.
Le paramètre `DUExPER(8)` est systématiquement retiré avant construction ; `TASTE(2)` est omis
pour `beverageId = 200` (sauf `checkValues`).

> ⚠️ **lan-server n'applique AUCUN de ces trois filtres.** `frameDispense` sérialise tous les
> paramètres que l'éditeur lui donne, et l'éditeur les donne tous. Mesuré sur les 28 boissons de
> cette machine, cela fait partir dans la trame `0x83` trois identifiants que l'app n'y met jamais :
> `PROGRAMABLE(24)` sur 26 boissons, `VISIBLE(25)` sur 28, `PROG_TIME(30)` sur 1. Sans conséquence
> connue — mais `0x83` sert aussi l'écriture PERSISTANTE d'une recette dans un profil
> (`SAVE_BEVERAGE`), donc ce sont des octets écrits dans un appareil réel que le constructeur n'y
> écrit pas. Décision à prendre ; en attendant, ne pas croire que le comportement est aligné parce
> que la règle est écrite ci-dessus.

> **`INDEX_LENGTH(27)` n'est pas une longueur en millilitres.** L'app le passe par une énumération
> `SMALL(0) / MID(1) / LARGE(2) / NOT_SET(255)` dont le paramètre s'appelle `mugSize`, et
> `RecipeData.J()` traite la valeur 4 comme un cas spécial sur Maestosa. Mais les bornes lues sur
> cette machine disent **0–4, défaut 1** (0–3 sur la verseuse), soit cinq positions pour une
> énumération qui en connaît trois. Surtout, elles sont **identiques sur un espresso et sur un café
> long** : un paramètre décrivant le volume versé n'aurait pas la même plage sur deux boissons de
> longueurs si différentes — le volume a ses propres paramètres (`COFFEE`, `MILK`, `HOT_WATER`).
> D'où le libellé « Index de calibre » plutôt que « longueur ». **Effet observable non établi** :
> il reste à faire varier la valeur et à observer ce qui coule, ce qui exige de préparer une
> boisson sur l'appareil.

> **Longueur des paramètres** : `COFFEE`, `MILK`, `HOT_WATER` sont sur 2 octets (quantités en ml,
> big-endian). La liste exacte des paramètres 2 octets est portée par la `DefaultsTable` de la
> machine ; `z.Z(id)` la consulte à l'exécution. Les valeurs ci-dessus sont l'usage attendu, à
> confirmer par lecture de la table réelle (machine en veille lors de l'analyse).

---

## 5. Autres commandes utiles (vérifiées dans le code)

| Fonction | Trame | Commande |
|---|---|---|
| **Allumer** | `0D 07 84 0F 02 01 <crc>` | 0x84 |
| **Éteindre** | `0D 07 84 0F 01 01 <crc>` | 0x84 |
| Lire les bornes d'une boisson | `0D 06 B0 F0 <bevId> <crc>` | 0xB0 |
| Lire la recette d'un profil | `0D 07 A6 F0 <profil> <bevId> <crc>` | 0xA6 |
| Lire les noms de profils | `0D 07 A4 F0 <premier> <nb> <crc>` | 0xA4 |
| Lire les noms de recettes perso | `0D 07 AA F0 <premier> <nb> <crc>` | 0xAA |
| Lire l'ordre des favoris | réponse `0xA8` | 0xA8 |
| Lire un Bean System | `0D 06 BA F0 <index> <crc>` | 0xBA |
| Sélectionner un Bean System | `0D 06 B9 F0 <id> <crc>` | 0xB9 |
| Envoyer un profil | `0D 06 A9 F0 <id> <crc>` | 0xA9 |
| Lire un réglage machine | `0D 08 95 <flag> <addrHi> <addrLo> <qty> <crc>` | 0x95 — voir § 14.1 |
| Écrire un réglage machine | `0D 0B 90 <flag> <addrHi> <addrLo> <valeur 32 bits> <crc>` | 0x90 — voir § 14.1 |
| Écrire les noms de profils | `0D <len> A5 F0 <premier> <dernier> …` | 0xA5 — voir § 14.2 |
| Écrire les noms de recettes perso | `0D <len> AB F0 <premier> <dernier> …` | 0xAB — voir § 14.2 |
| Écrire l'ordre des favoris | `0D 12 AD F0 <profil> <12 ids> <crc>` | 0xAD — voir § 14.3 |
| Sauver/supprimer Bean System | `0D 33 BB F0 …` (52 o) | 0xBB — voir `bean-adapt.md` |
| Lire un monitor | réponse `D0 12 75 0F …` | 0x75 |
| Lire le numéro de série (et donc le modèle) | réponse `D0 1B A1 0F …` | 0xA1 — voir § 13 |

### 5.1 Quelles trames RÉPONDENT — et ce que « pas de réponse » implique

Fait opérationnel absent des premières versions de ce document, alors que tout l'ordonnancement du
serveur repose dessus. **Trois natures, mais seulement deux comportements** — et la frontière n'est
pas celle qu'on devine à la lecture des trames :

| famille | commandes | la machine… |
|---|---|---|
| **lecture** | `0x95`, `0xA2`, `0xA3`, `0xA6`, `0xB0`, `0xBA` | renvoie un `data_response` |
| **lecture (monitor)** | `0x75`, `0x60`, `0x70` | pousse un datapoint `d302_monitor` — **pas** de `data_response` |
| **action** | `0x83`, `0x84`, `0xB9` | ne répond **rien** |
| **action acquittée** | `0xA9` | répond `D0 07 A9 F0 <profil> <statut> <crc>` |
| **écriture** | `0x90`, `0xA5`, `0xAB`, `0xAD`, `0xBB` | ne répond **rien** non plus |

> ⚠️ **`0xA9` ACQUITTE, et ce document affirmait le contraire.** Relevé deux fois, à deux sessions
> distinctes, chaque fois environ une seconde après que la trame a été servie :
>
> ```
> →  0d 06 a9 f0 01 d7 c0          demande : profil 1
> ←  d0 07 a9 f0 01 00 3b 3c       réponse : profil 1, statut 00
> ```
>
> La réponse reprend le profil demandé à l'octet 4 et porte un second octet à `00` — vu à `00`
> dans les deux relevés, donc sa signification reste **inconnue** : ne pas l'appeler « statut »
> ailleurs que par commodité tant qu'une valeur non nulle n'aura pas été observée.
>
> Conséquence pratique, et elle est coûteuse : une sélection de profil rangée parmi les actions
> « sans réponse » est attendue par **fenêtre de présence**. Mesuré le 2026-08-22 — trame servie à
> 16:48:16, acquittée à 16:48:17, tâche close à 16:49:31 : **quatre-vingts secondes** de présence
> maintenue pour une commande confirmée en une. Pendant tout ce temps la file est occupée et le
> keep-alive tourne à 2,5 s. La preuve d'exécution existe, elle n'était simplement pas lue.


> ⚠️ **La ligne « monitor » a été séparée le 2026-08-22, et c'est une correction, pas une nuance.**
> Ce document rangeait `0x75` avec les lectures qui renvoient un `data_response`. C'est faux :
> la machine répond à une demande de monitor en **poussant la propriété `d302_monitor`**, jamais
> par un `data_response`. Mesuré trois fois de suite sur l'appareil, monitor reçu et décodé —
> `état=0x02`, capteurs, alarmes — pendant que la tâche qui l'avait demandé était déclarée « sans
> réponse » puis « échouée ». Aucun `d0 .. 75 ..` n'a jamais été observé, alors que les
> `d0 41 a2 0f …` des statistiques abondent dans le même journal.
>
> Conséquence pratique pour qui écrit un client : **une lecture d'état ne s'attend pas comme les
> autres lectures.** L'attendre sous forme de `data_response` la fait échouer à tous les coups, et
> le symptôme est trompeur — l'état arrive et s'affiche, mais la commande est comptée en échec, ce
> qui ressemble à s'y méprendre à une machine déconnectée.
>
> Et le corollaire qui compte autant : ces poussées de monitor sont **aussi spontanées**. Pendant
> une préparation la machine en émet une toutes les 1 à 3 secondes sans que rien ne l'ait demandée
> (voir § 11.5). Un client qui apparierait n'importe quelle poussée à n'importe quelle lecture en
> attente déclarerait donc lues des données jamais reçues. L'appariement doit porter sur la
> commande demandée.
>
> **Cadence mesurée de la poussée `d302_monitor` : 12 à 13 secondes.** Relevé le 2026-08-22 sur
> quatre intervalles consécutifs — 13 s, 12 s, 13 s, puis 12,4 s au chronomètre (16:36:42,297 puis
> 16:36:54,740). La première poussée arrive à **l'ouverture de session**, avant même qu'une trame
> `0x75` ait été servie : ce n'est donc pas une réponse, c'est une horloge.
>
> Conséquence pour qui attend une lecture d'état : **le délai d'attente doit dépasser cette cadence,
> pas l'égaler.** Une échéance de 12 s en fait un tirage au sort selon l'endroit où la demande tombe
> dans le cycle. Et le coût d'entrée s'y ajoute : sur une session froide, la machine consomme
> d'abord une visite pour `device_connected` — 2,7 s mesurées entre la mise en file et le moment où
> la trame `0x75` lui est enfin servie, une visite valant une commande.
>
> C'est ce qui explique l'asymétrie déroutante avec les statistiques : `0xA2` répond dans la **même
> seconde**, parce qu'il rend un vrai `data_response`. Les deux lectures n'attendent pas la même
> chose — l'une une réponse, l'autre un battement.



Les deux dernières familles se distinguent par ce qu'elles laissent derrière (une écriture est
persistante dans l'appareil), pas par leur comportement en réponse : **aucune des deux n'accuse
réception**.

⚠️ **Conséquence à ne pas manquer : pour une trame qui n'a rien à répondre, un délai atteint est un
SUCCÈS, pas une panne.** Le seul acquittement dont on dispose est indirect — la machine est venue
chercher la commande dans `commands.json`. Une durée d'attente n'est donc pas une échéance d'échec
mais une **durée de présence soutenue** : on continue d'annoncer `local_reg` pendant ce temps, et on
conclut positivement quand il expire. Traiter ces trames comme les lectures ferait échouer toute
écriture réussie. Inversement, une lecture s'achève **quand sa réponse arrive**, à la vitesse de la
machine, et non quand un chronomètre le décide.

Une trame illisible est comptée comme une action : c'est le choix prudent, il fait tenir la présence
au lieu d'attendre une réponse qui ne viendra peut-être jamais.

Ce tableau couvre les trames que **ce serveur émet**. `0xA4`, `0xAA`, `0xA8` et `0xA1` n'y figurent
pas alors qu'ils apparaissent au § 5 : ce sont des octets de commande qu'on **décode en réponse**,
les données correspondantes étant obtenues par lecture de propriétés Ayla (§ 6.4) plutôt qu'en
envoyant la trame.

⚠️ **Allumage / extinction : ne pas inverser.** `turnMachineOn` = `m0()` = `… 02 01`,
`turnMachineOff` = `l0()` = `… 01 01` (vérifié dans `DeLonghiWifiConnectService` et confirmé
en conditions réelles). Une version antérieure de ce tableau les donnait dans l'autre sens.

---

## 6. Lecture des recettes sur la machine — formats `0xB0` et `0xA6`

**Élucidé et validé le 2026-08-19.** Deux commandes distinctes, deux formats différents ; ne
pas les confondre avec la commande de préparation `0x83`.

### 6.1 `0xB0` — bornes min / défaut / max  (`RECIPE_MIN_MAX_SYNC`)

Porté par les propriétés `d001_rec_espresso` … `d021_rec_brew_over_ice` (+ `d028..d033` pour
les perso, `d022_beansystem_1`). C'est ce que l'app appelle `loadMinMaxFromDefault`.
Parser d'origine : `p097j6.d.X()`.

```
octet 0     0xD0
octet 1     len = taille totale − 1
octet 2     0xB0
octet 3     0xF0
octet 4     beverageId
octets 5..  QUADRUPLETS : id (1 o) puis min, défaut, max
            → 1 octet chacun, ou 2 octets big-endian si le paramètre est « 2 octets »
2 derniers  CRC16
```

**Validé sur la trame réelle** `d001_rec_espresso` (38 octets) : le parcours tombe
exactement sur le CRC et donne des valeurs cohérentes avec la machine physique.

| Paramètre | min | défaut | max |
|---|---:|---:|---:|
| COFFEE (café, ml) | 20 | **40** | 180 |
| TASTE (arôme) | 0 | **4** | 5 |
| DUExPER (2 tasses) | 0 | 0 | 1 |
| PROGRAMABLE | 0 | 1 | 1 |
| VISIBLE | 0 | 1 | 1 |
| INDEX_LENGTH | 0 | 1 | 4 |
| BLEND | 0 | 0 | 0 |

Les 7 paramètres correspondent exactement aux `ingredients` déclarés pour l'espresso dans
`MachinesModels.json` (`1,2,4,8,24,25,27`) — deux sources indépendantes concordantes.

### 6.2 `0xA6` — valeurs enregistrées d'un profil  (`RECIPE_QTY_READ`)

Requête : `0D 07 A6 F0 <profileId> <beverageId> <crc>` (`p097j6.d.M0()`, « recipeQtyPacket »).
Porté aussi par les propriétés `d039_1_rec_espresso` … `d059_1_rec_brew_over_ice` pour le
profil 1 (`loadRecipeFromProfile`). Parser d'origine : `p097j6.d.u0()`.

```
octet 4     profileId
octet 5     beverageId
octets 6..  PAIRES : id (1 o) puis valeur (1 o, ou 2 o big-endian si « 2 octets »)
2 derniers  CRC16
```

**Nom de la propriété par profil** (formule de `p258z7/z.java`, `v(profileId, template)`) :

```
numéro = offsetBase + (profileId − 1) × 21          offsetBase = 39 pour l'espresso,
                                                    puis +1 par boisson du catalogue
→ profil 1 : d039_1_rec_espresso … d059_1_rec_brew_over_ice
→ profil 2 : d060_2_rec_espresso … d080_2_rec_brew_over_ice
```

**Les deux familles particulières ne suivent PAS ce pas de 21**, et elles ne le suivent pas de deux
façons différentes — c'est `p258z7/z.java` qui le dit, pas une supposition :

- **Bean System** — `t(profileId, template)` : `i10 = (profileId − 1) × 6`, puis
  `bs_recipe_01 + 160`. Donc `d160_1_bs_recipe_01`, `d166_2_bs_recipe_01`, `d172_3_…`
  ⚠️ Ce pas de 6 **manquait** : une version antérieure du code rendait `d160_{p}_bs_recipe_01` pour
  tous les profils, c'est-à-dire un nom qui n'existe pas pour p ≥ 2. La lecture répondait vide et
  était classée « absente sur ce modèle » — la recette Bean Adapt des profils 2 à 5 était donc
  illisible, sans que rien ne le signale. Un nom faux ne produit pas d'erreur ici, il produit du
  silence.
- **Recettes perso** — `d200_1_cstm_recipe_01` … `d205_1_cstm_recipe_06`, **profil 1 en dur**. Ce
  n'est pas un raccourci : l'app écrit ces noms littéralement (`C1("d200_1_cstm_recipe_01")`) et
  n'a aucune fonction qui les construise avec un profil variable, contrairement aux deux cas
  ci-dessus. Demander `d200_2_cstm_recipe_01` serait **inventer un nom**.

⚠️ **Piège d'interprétation qui en découle.** Comme ces six propriétés sont les mêmes quel que soit
le profil demandé, elles apparaissent « lues » pour les cinq profils dès qu'elles l'ont été une
fois. Relevé sur cette machine : profil 2 affiche 6 boissons avec valeurs enregistrées — ce sont
exactement les six recettes perso, et aucune boisson standard. Ne pas en conclure que les profils
2 à 5 ont été lus.

### 6.3 Paramètres sur 2 octets

L'app ne devine pas la longueur : elle la lit dans une table **téléchargée du backend**
(`getCommonData.sr` → `parameters[] {id,length,description}`, cache `DeLonghi.k()`, test
`z.Z(id)` = `length > 1`). Cette table n'est pas dans l'APK. Sur cette famille de machines,
les paramètres 2 octets sont les quantités liquides : **`COFFEE` (1), `MILK` (9),
`HOT_WATER` (15)** — confirmé par le décodage exact de la trame espresso.

Le décodeur de `lan-server/src/lib/beverages.mjs` signale `exact: false` quand le parcours ne
tombe pas sur le CRC : c'est le symptôme d'un paramètre 2 octets non répertorié.

### 6.4 Comment lire ces propriétés en LAN pur (sans le cloud)

Le protocole LAN Ayla permet de **demander** une propriété. Au lieu de servir un
`data_request` dans `commands.json`, on sert une commande de lecture — port de
`AylaLanCommand.newGetPropertyCommand` (`com/aylanetworks/aylasdk/localcontrol/lan/AylaLanCommand.java:53`) :

```json
{"cmds":[{"cmd":{"cmd_id":1,"method":"GET","data":"",
  "resource":"property.json?name=d001_rec_espresso",
  "uri":"/local_lan/property/datapoint.json"}}]}
```

La machine POSTe alors la valeur sur `/local_lan/property/datapoint.json`, endpoint que le
serveur déchiffre déjà. Aucun appel au cloud, aucun token. Implémenté dans `server.mjs`
(`readPropertyCmd` / `startImport`), exposé par `POST /api/beverages/import`.

## 8. Profils, noms et favoris — `0xA4`, `0xAA`, `0xA8`

**Élucidé et validé sur la machine le 2026-08-19** (import réel via `/profils`).

### 8.1 Quelle génération ? `isStriker = false`

Le service choisit ses propriétés ET son parser selon `isStriker`
(`DeLonghiWifiConnectService.java:1703`). Le logcat de cette machine dit **`isStriker = false`**,
donc c'est le chemin **classic** :

| Donnée | Propriété (classic) | Parser | Variante Striker (absente ici) |
|---|---|---|---|
| Noms profils 1-3 | `d034_profiles_1_3` | `J0()` stride **21** | `d051_profile_name1_3`, `K0()` stride 22 |
| Noms profils 4-5 | `d035_profiles_4_5` | `J0()` stride 21 | `d052_profile_name4` |
| Noms recettes perso 1-3 | `d036_recipe_custom_name_1_3` | `J0()` stride 21 | `d053_custom_name_13` |
| Noms recettes perso 4-6 | `d037_recipe_custom_name_4_5` | `J0()` stride 21 | `d054_custom_name_46` |
| Ordre des favoris | `d{260+p}_{p}_rec_priority` | `I0()` | `d265_favorite_priority_1`… |

> Le stride Striker vaut 22 parce que `K0()` lit un octet « mug » supplémentaire par entrée.
> Sur cette machine c'est **21** : 20 octets de nom + 1 octet d'icône. Interroger les variantes
> Striker est sans risque — elles répondent vide.

### 8.2 Format d'un bloc de noms (`0xA4` profils, `0xAA` recettes perso)

```
octet 0     0xD0
octet 1     len = taille totale − 1
octet 2     0xA4 (profils) ou 0xAA (recettes perso)
octet 3     0xF0
octet 4     index du PREMIER élément du bloc
octet 5     index du DERNIER élément du bloc
octets 6..  entrées de 21 octets : 20 octets de nom UTF-16 **big-endian**
            (zéros de fin ignorés ; tout-à-zéro = emplacement vierge) + 1 octet d'icône
2 derniers  CRC16
```

Deux pièges vérifiés sur trames réelles :

1. **Le nombre d'entrées se lit dans la trame** (octets 4 et 5), il ne se déduit pas de la
   taille : `01 03` = éléments 1 à 3, `04 05` = éléments 4 et 5, `04 06` = 4 à 6.
2. **Le bloc peut laisser un octet résiduel** avant le CRC. `J0()` fait une division entière
   `(len − 7) / 21` et l'ignore. Un décodeur qui exige un ajustement exact rejette `d034`
   (3 entrées de 21 octets = 63, pour 64 octets disponibles).

Java décode « UTF-16 » sans BOM en **big-endian** ; Node ne sait faire que `utf16le`, il faut
donc permuter les octets par paires avant de convertir.

**Relevé réel** (`d034_profiles_1_3`, 72 octets) :

```
d0 47 a4 f0 01 03 | 00 4a 00 e9 00 72 00 f4 00 6d 00 65 00 00 …  0c
                    J     é     r     ô     m     e            icône 12
```

### 8.3 Ordre des favoris (`0xA8`)

Parser `I0()` :

```
octet 4     profileId
octets 5..  (len − 6) identifiants de boisson, dans l'ordre d'affichage de l'écran
```

Relevé : 23 boissons par profil, l'ordre diffère d'un profil à l'autre, et il commence par
`200` (Bean Adapt) sur les cinq profils de cette machine.

### 8.4 Sélection du profil actif (`0xA9`)

`0D 06 A9 F0 <profileId> <crc>` — c'est la trame que le serveur utilisait déjà comme « présence
soutenue » pendant un réveil ; c'est aussi la commande de sélection de profil, exposée par
`POST /api/command {"action":"selectProfile","profileId":n}`.

## 9. Sommes de contrôle — `0xA3` (validation de cache)

**Validé sur trame réelle le 2026-08-19.** C'est le mécanisme qui permet à l'app de savoir si
les recettes d'un profil ont changé **sans tout relire**.

Requête : `0D 05 A3 F0 <crc>` — 6 octets (`p097j6.d.J()`).

```
octet 0     0xD0
octet 1     len = taille totale − 1
octet 2     0xA3
octet 3     0xF0
octets 4..  `size` sommes de 16 bits big-endian : quantités des recettes du profil 1..size
+2          somme des quantités des recettes personnalisées
+2          somme des noms
2 derniers  CRC16
```

`size` **n'est pas dans la trame** : l'app le tient de son propre modèle (6 par défaut,
`g.h().d().y().size()`). On le déduit de la taille : total = 10 + 2·size, donc
**`size = (len − 9) / 2`**.

**Trame réelle de cette machine** (20 octets, `size` déduit = 5, cohérent avec `nProfiles`) :

```
d0 13 a3 f0 | 7a 3f | 7a 3f | c0 57 | 7a 3f | 7a 3f | b4 31 | bc f4 | 08 1a
              prof1   prof2   prof3   prof4   prof5   perso    noms    crc
```

Le profil 3 se distingue (`0xc057` contre `0x7a3f` pour les quatre autres) : ses quantités
diffèrent réellement, les autres sont aux valeurs d'usine. La somme est donc bien discriminante.

Sémantique, d'après `it/delonghi/handlers/b.java:387` :

```java
namesOk      = names  == cache.namesChecksum
quantitiesOk = custom == cache.customRecipesQtyChecksum
if (quantitiesOk && profilActif.checksum != sArr[profilActif - 1]) quantitiesOk = false;
```

Une seule petite trame remplace donc la relecture des 21 propriétés de recette par profil.
Implémenté côté serveur : `POST /api/checksums` demande la trame, `GET /api/checksums` renvoie
les sommes, les précédentes, ce qui a changé, et ce qui est périmé par rapport au dernier import.
`POST /api/profiles/import` saute la lecture des noms quand leur somme n'a pas bougé (`force:true`
pour outrepasser). Les sommes **ne couvrent pas** l'ordre des favoris : lui est toujours relu.

## 10. Trame de présence : ne pas utiliser `0xA9`

`0xA9` (`SEND_PROFILE`) **sélectionne un profil** — ce n'est pas un battement de cœur inoffensif.
S'en servir comme signal de présence avec un profil arbitraire impose ce profil à la machine :
une simple demande de sommes de contrôle a ainsi ramené la machine du profil 3 au profil 1.

Pour tenir la présence sans effet de bord, utiliser une **demande de monitor** (`V(data2)`) :

```
0D 05 75 0F <crc>
```

C'est une lecture pure. Le serveur ne garde `0xA9` que pour le réveil (où c'est la recette
validée, cf. `ETAT.md`) et pour la sélection de profil elle-même, où réaffirmer la même valeur
est idempotent.

## 11. Trame monitor `0x75` — état, capteurs, alarmes

**Élucidé le 2026-08-20** d'après `it/delonghi/ecam/model/MonitorDataV2` (le tableau indexé y est
la trame complète décodée du base64), et confirmé sur la machine.

```
octet 4        état machine
octets 5, 6    CAPTEURS — champ de bits 16 bits ; octet = 5 + groupe, bit = position
octets 7,8,12,13  alarmes — champ de bits 32 bits (7 | 8<<8 | 12<<16 | 13<<24)
octets 9,10,11    PROGRESSION — fonction, étape, pourcentage (§ 11.5)
```

> ⚠️ Les octets 5-6 étaient nommés « progress » dans les premières versions de ce projet.
> **C'était faux.** La valeur 256 relevée signifie « groupe 1, bit 0 » = carafe à lait connectée,
> ce que l'écran de la machine confirmait au même instant.

### 11.1 Capteurs (énum `p127m6/p`, couple groupe/bit)

| Groupe | Bit | Nom | Sens |
|---:|---:|---|---|
| 0 | 0 | `WATER_SPOUT` | buse à eau |
| 0 | 1 | `MOTOR_UP` | moteur haut |
| 0 | 2 | `MOTOR_DOWN` | moteur bas |
| 0 | 3 | `COFFEE_WASTE_CONTAINER` | bac à marc |
| 0 | 4 | `WATER_TANK_ABSENT` | réservoir d'eau absent |
| 0 | 5 | `KNOB` | molette |
| 0 | 6 | `WATER_LEVEL_LOW` | niveau d'eau bas |
| 0 | 7 | `COFFEE_JUG` | verseuse |
| 1 | 0 | `IFD_CARAFFE` | **carafe à lait, molette hors nettoyage** |
| 1 | 1 | `CIOCCO_TANK` | **carafe à lait, molette sur nettoyage** |
| 1 | 2 | `CLEAN_KNOB` | molette nettoyage |
| 1 | 5 | `DOOR_OPENED` | porte ouverte |
| 1 | 6 | `PREGROUND_DOOR_OPENED` | trappe café moulu ouverte |


> ✅ **Élucidé le 2026-08-22, en trois mesures ne faisant varier qu'une chose à la fois.** Les
> bits 1.0 et 1.1 disent **tous deux « carafe à lait en place »** ; ce qui les distingue est la
> **position de la molette** de la carafe :
>
> | état physique | octet 6 | bit levé |
> |---|---|---|
> | carafe retirée | `0b00000000` | — |
> | carafe en place, molette sur **nettoyage** | `0b00000010` | 1.1 `CIOCCO_TANK` |
> | carafe en place, molette **ailleurs** | `0b00000001` | 1.0 `IFD_CARAFFE` |
>
> **« Ailleurs » et non « mousse » : le détecteur ne connaît qu'UNE frontière, nettoyage ou pas.**
> Trois positions hors nettoyage ont été mesurées — mousse au cran où elle se trouvait, mousse au
> minimum, et la graduation « insert » — et donnent la **même trame, octet pour octet, CRC
> compris**. Le premier libellé écrit ici disait « molette sur mousse » : c'était sur-interpréter
> une seule mesure, la position où la molette se trouvait ce jour-là.
>
> Jamais les deux ensemble — ce que les quatre préparations enregistrées montraient déjà sans
> qu'on sache l'expliquer : **trois des quatre préparations portent `IFD_CARAFFE`** (l'espresso, le
> macchiato et le lait chaud) et **la quatrième porte `CIOCCO_TANK`** (le second espresso). Ce
> n'est donc pas le lait qui lève le bit — un espresso pur le lève aussi — c'est bien la molette :
> la capture `espresso-veille` est la seule enregistrée molette sur nettoyage. **Les noms de l'énum induisent en
> erreur** : `CIOCCO_TANK` ne désigne aucun bac à chocolat ici, ce modèle n'expose aucune boisson
> chocolatée sur les 28 entrées de son catalogue. On garde les noms, qui viennent du protocole, et
> on corrige les libellés. L'app officielle n'aide pas : `MonitorDataV2.g()` **exclut** de sa liste
> `IFD_CARAFFE`, `CIOCCO_TANK`, `WATER_SPOUT` et les inconnus — elle n'en montre aucun.
> Captures : `scripts/captures/carafe.json` (retrait) et `carafe-molette.json` (molette).
>
> ✅ **L'alarme `CLEAN_KNOB` (bit 14) est la demande de nettoyage du circuit lait.** Relevée dans
> les captures : elle est absente au début du macchiato, se lève **à la trame où le lait coule**
> (`f=10 e=4`, 18 s), reste levée jusqu'à la fin de la boisson, et est **encore levée à l'ouverture
> de la capture du lait chaud** enregistrée plus tard. Les deux espressos ne la lèvent jamais, et
> elle est retombée sur toutes les lectures du lendemain. Lecture la plus simple : « du lait est
> passé, il faut nettoyer », persistante jusqu'au nettoyage — c'est une inférence, mais les quatre
> préparations la soutiennent sans exception.
>
> ⚠️ **À ne pas confondre avec le CAPTEUR `CLEAN_KNOB` (groupe 1, bit 2), qui porte le même nom et
> n'a jamais été observé levé** — y compris molette physiquement sur nettoyage, où seul le bit 1.1
> se lève. Son rôle reste inconnu ; ce n'est pas « la molette est sur nettoyage ».

> ⛔ **Ni le cran de mousse ni la position « insert » ne sont rapportés.** Les deux bits sont des
> détecteurs tout-ou-rien et aucun octet continu ne varie avec la graduation. Vrai de `0x75`, la
> seule trame qu'on interroge — inutile de refaire la mesure, mais rien ne dit qu'une autre
> commande ne l'exposerait pas.
>
> ⚠️ **La même expérience a corrigé la sentinelle de repos.** Carafe branchée et machine au repos,
> la trame dit **`f=12, e=0`** — une fonction absente des quatre préparations enregistrées.
> Retirer la carafe la ramène à `f=7, e=0`. Le prédicat de l'app (`f == 7 && e == 0`) lisait donc
> « préparation en cours, 0 % » en permanence dès que la carafe était en place. Le repos se teste
> désormais sur **l'étape seule** (`e == 0`), invariant vérifié sur les cinq captures : l'étape 0
> n'y apparaît jamais au milieu d'une préparation.

### 11.2 États observés (octet 4)

| Valeur | Sens | Certitude |
|---|---|---|
| `0x04` | **veille** | confirmé (extinction/allumage suivis en direct) |
| `0x02` | **prête** — écran de sélection des boissons | confirmé par l'écran de la machine |
| `0x00` | en chauffe | déduit : relevé juste après un réveil |

Le serveur raisonne donc « **éveillée sauf 0x04** » plutôt que sur une liste blanche d'états
allumés : une version précédente n'acceptait que `0x00` et affichait « état inconnu » alors que la
machine était bel et bien prête.


> ⚠️ **`0x04` ne veut PAS dire « la machine ne fait rien ».** Relevé le 2026-08-22 : un espresso
> complet — mouture, infusion, écoulement jusqu'à 100 % — s'est déroulé avec `état=0x04` sur ses
> **49 trames**, sans qu'aucune commande d'allumage ne soit passée par le serveur. La même boisson
> avait été enregistrée plus tôt le même jour à `0x02` de bout en bout. L'octet 4 décrit donc l'état
> de l'interface de la machine, pas son activité : **c'est la progression (octets 9-11, § 11.5) qui
> dit si quelque chose est en cours**, et elle prime. L'accueil affichait sans cela son interrupteur
> sur « éteint » juste au-dessus d'une barre annonçant « Écoulement du café — 84 % ».
> Capture de référence : `scripts/captures/espresso-veille.json`.

### 11.3 Alarmes (octets 7, 8, 12, 13)

Champ de bits 32 bits construit par `MonitorDataV2.b()` :
`octet7 | octet8<<8 | octet12<<16 | octet13<<24`. Chaque bit actif est résolu par
`p127m6/l` — méthode `a(int)`, qui **fait autorité sur les couples (groupe, bit) de l énum** :
plusieurs index y sont explicitement `IGNORE_ALARM` sur cette génération.

| Bit | Identifiant | Libellé |
|---:|---|---|
| 0 | `EMPTY_WATER_TANK` | Réservoir d eau vide |
| 1 | `COFFEE_WASTE_CONTAINER_FULL` | Bac à marc plein |
| 2 | `DESCALE_ALARM` | Détartrage nécessaire |
| 3 | `REPLACE_WATER_FILTER` | Remplacer le filtre à eau |
| 4 | `COFFE_GROUND_TOO_FINE` | Mouture trop fine |
| 5 | `COFFEE_BEANS_EMPTY` | Réservoir à grains vide |
| 6 | `MACHINE_TO_SERVICE` | Machine à faire réviser |
| 8 | `TOO_MUCH_COFFEE` | Trop de café |
| 9 | `COFFEE_INFUSER_MOTOR_NOT_WORKING` | Moteur d infusion bloqué |
| 11 | `EMPTY_DRIP_TRAY` | Vider le bac d égouttage |
| 12 | `HYDRAULIC_CIRCUIT_PROBLEM` | Problème de circuit hydraulique |
| 14 | `CLEAN_KNOB` | Molette en position nettoyage |
| 15 | `COFFEE_BEANS_EMPTY_TWO` | Réservoir à grains vide (2e moulin) |
| 17 | `BEAN_HOPPER_ABSENT` | Réservoir à grains absent |
| 18 | `GRID_PRESENCE` | Grille absente |
| 19 | `INFUSER_SENSE` | Infuseur mal positionné |
| 22 | `EXPANSION_SUBMODULES_PROB` | Problème de sous-modules d extension |
| 25 | `CONDENSE_FAN_PROBLEM` | Problème de ventilateur de condensation |

Bits **7, 10, 13, 16, 20, 21, 23, 24, 26-31** : `IGNORE_ALARM`. L énum `l` déclare pourtant des
alarmes à ces positions (`COFFEE_HEATER_PROBE_FAILURE`, `STEAMER_PROBE_FAILURE`,
`TANK_IS_IN_POSITION`, `TANK_TOO_FULL`, `NOT_ENOUGH_COFFEE`, `EXPANSION_COMM_PROB`,
`GRINDING_UNIT_*`, `CLOCK_BT_COMM_PROBLEM`, `SPI_COMM_PROBLEM`) : elles ne sont pas atteignables
par ce chemin. Le serveur les remonte marquées « non répertoriée » plutôt que de leur coller un
nom faux.

**Relevé réel sur cette machine** : `0x00000008` → bit 3 → `REPLACE_WATER_FILTER`.

### 11.4 Le profil actif n'est PAS lisible

Vérifié plutôt que supposé : `d286_mach_sett_profile` et `d281_mach_sett_temperature` ne renvoient
**rien** sur cette machine (alors que `d270_serialnumber` répond — trame `0xA1` avec le numéro en
ASCII), et l'app officielle ne le lit pas davantage : `EcamMachine.B()` renvoie un champ local
initialisé à 1, qu'aucun code n'alimente depuis une trame machine. Le profil actif est donc une
**intention côté client**, à persister, pas une donnée à observer.

## 7. À vérifier sur machine

Résolu depuis la 1re version : les **échelles réelles** (§ 6.1 — café en ml 20/40/180, arôme
0..5), la **liste des paramètres 2 octets** (§ 6.3), les **identifiants de boisson** (§ 2) et
le **sens allumage/extinction** (§ 5).

**Résolu depuis, sur la machine (relevés des 2026-08-19 → 2026-08-22)** :

- **Import réel** — les bornes remontent : **28 boissons sur 28** ont leurs quads min/déf/max en
  cache. Le décodeur n'est plus validé sur une trame mais sur le catalogue entier.
- **Lectures en veille** — oui. Mieux : une préparation **complète** a été enregistrée avec l'octet
  d'état à `0x04` de bout en bout, sans qu'aucune commande d'allumage soit passée (§ 11.2). L'octet
  d'état ne dit pas si la machine répond.
- **profileId courant** — tranché, et **négativement** : il n'est pas lisible, voir § 11.4. Le forcer
  côté client n'est pas un pis-aller en attendant mieux, c'est la seule option disponible. (Cette
  entrée contredisait § 11.4 dans le même document.)
- **Noms des recettes perso et des profils** — lus : **5 noms de profils sur 5** avec leurs icônes,
  **5 ordres de favoris**, **6 noms de recettes perso sur 6**. Le pas de 21 octets est confirmé
  (§ 8.2) ; le parser `K0()` à 22 octets est bien le chemin Striker, et n'a pas lieu d'être ici.
- **Trame « lancer espresso » de bout en bout** — faite, sous surveillance, le 2026-08-22 : quatre
  préparations réelles (espresso, espresso macchiato, lait chaud, second espresso), dont la
  progression décodée est en § 11.5 et les trames archivées dans `scripts/captures/`.

Reste ouvert :

- **Propriétés par profil 2..5** : toujours **non vérifié**, malgré les apparences. La formule
  `offsetBase + (profileId − 1) × 21` produit bien `d060_2_rec_espresso`, `d081_3_…`, `d102_4_…`,
  `d123_5_…`, mais **aucune boisson standard n'a jamais répondu pour p ≥ 2** : les six valeurs qui
  s'affichent pour ces profils sont les recettes perso, dont le nom fixe le profil à 1 (§ 6.2).
  Lire une seule boisson du profil 2 suffirait à clore le point.
- **Comportement du `checkValues`** (bit 0x80 sur le mode) : à tester prudemment.
- **Arrêt d'une préparation** (§ 1.5) : la trame est construite et passe par la file, mais elle n'a
  jamais été déclenchée sur une boisson réellement en cours d'écoulement.
- **Effet réel d'`INDEX_LENGTH`** (§ 4) : le paramètre part bien dans la trame, ses bornes sont
  connues (0–4), mais ce qu'il change dans la tasse n'a pas été observé.
- **Filtre `E0()` non appliqué** (§ 4) : décider si l'on s'aligne sur l'app, qui n'envoie jamais
  `PROGRAMABLE(24)`, `VISIBLE(25)` ni `VISIBLE_IN_PROGRAMMING(26)` dans une trame `0x83`.

### 11.5 Progression d'une préparation (octets 9, 10, 11)

**Élucidé et mesuré sur la machine le 2026-08-22**, sur trois préparations réelles. Les trois
octets sont journalisés mot pour mot par l'app dans `BrewBeveragesViewModel.P()` :

```java
"BEVERAGE DISPENSING FLOW : Fun OnGoing: " + monitorData.f()
                          + " Exe Prog: " + monitorData.e()
                          + " Percent : " + monitorData.d()
```

Pour un monitor de **mode 2** (la réponse `0x75`, la seule que le service Wi-Fi demande),
`MonitorDataV2` lit `f()` à l'octet **9**, `e()` à l'octet **10**, `d()` à l'octet **11**.

| Octet | Nom dans l'app | Contenu |
|---:|---|---|
| 9 | `FunctionOngoing` | la **phase** en cours |
| 10 | `ExecutionProgress` | l'étape à l'intérieur de la phase |
| 11 | `Percent` | pourcentage 0-100 de la boisson **entière** |

#### Fonctions relevées

| Valeur | Sens | Certitude |
|---|---|---|
| 0 | veille | l'app en fait son prédicat `n()` |
| 5 | chauffe | table de l'app, non observée ici |
| 7 | **café** | confirmé — espresso et macchiato |
| 10 | **boisson lactée** | confirmé — macchiato et lait chaud |
| 11 | eau chaude | table de l'app, non observée |
| 16, 17 | écoulement café / lait | table de l'app, non observées |

#### Étapes relevées, fonction 7 (café)

| `e` | Sens | Source |
|---:|---|---|
| 0 | **repos** | l'app en fait son prédicat `o()` : `f==7 && e==0` |
| 4 | mouture | app (`disp_grinding`) + observé |
| 5, 6 | non nommées — l'octet 5 (capteurs) y montre `MOTOR_UP`/`MOTOR_DOWN` | observées |
| 7 | chauffe de l'eau | app (`disp_water_heating`) |
| 8 | infusion | app (`icn_infusion_bean`) + observé |
| 9, 10 | non nommées | observées |
| 11 | écoulement du café | app (`disp_coffee_delivery`) + observé |
| 13, 14 | terminé | app (`icn_dispensing_complete`) + observées |

#### Étapes relevées, fonction 10 (lait)

| `e` | Sens | Source |
|---:|---|---|
| 1 | chauffe | app (`disp_water_heating`) + observé |
| 2 | mouture | app (`disp_grinding`) |
| 3, 5 | non nommées | observées |
| 4 | écoulement du lait | app (`disp_milk_delivery`) + observé |
| 7 | mouture | app (`disp_grinding`) |

**Cinq valeurs d'étape observées ne sont nommées par personne** — ni par la table de l'app, ni par
nos relevés. L'app y garde simplement l'illustration précédente ; le serveur les rend `null` et
l'interface dit « préparation en cours ». Leur inventer un nom serait une affirmation de plus que
ce qu'on sait.

#### Les trois relevés

Espresso (café seul) — 34,5 s de la commande au 100 % :

```
+4,3 s   f=7  e=4   0 %   mouture
+11,1    f=7  e=6   0 %   octet 5 → 0x04 puis 0x06 : moteur de l'infuseur
+17,0    f=7  e=8   5 %   infusion — le pourcentage démarre
+23,4    f=7  e=11 17 %   écoulement
+28,5    f=7  e=11 68 %
+34,5    f=7  e=14 100 %  terminé
+39,1    f=7  e=0   0 %   repos
```

Espresso macchiato (lait puis café) — 41 s :

```
+4,2 s   f=10 e=1   0 %   chauffe
+11,8    f=10 e=4   4 %   écoulement du lait
+15,2    f=10 e=5  38 %   fin du lait
+17,5    f=7  e=4  40 %   BASCULE sur le café — le pourcentage NE REPART PAS de zéro
+35,4    f=7  e=11 53 %
+41,1    f=7  e=13 100 %
```

Lait chaud 50 ml (lait seul) — 18 s :

```
+4,6 s   f=10 e=1   0 %
+12,1    f=10 e=4  22 %
+15,5    f=10 e=5  90 %   ← dernier pourcentage publié
+17,7    f=7  e=0   0 %   repos
```

#### Trois conséquences, dont une qui casse l'implémentation naïve

1. **La fonction est la PHASE, pas le type de boisson.** Un macchiato passe de 10 à 7 en cours de
   route. Une interface qui lirait la fonction une seule fois se tromperait à la moitié.
2. **Le pourcentage couvre la boisson entière** et ne se remet pas à zéro au changement de phase :
   le lait mène à 38, le café **reprend à 40**. C'est donc une barre unique, sans recollage.
3. ⚠️ **Le 100 % n'est pas garanti.** Le lait chaud s'est arrêté à 90 % puis est retombé
   directement au repos. L'écart entre les deux relevés était de 2,2 s, donc une trame à 100 % a
   pu être manquée — mais on ne peut pas s'en remettre à une trame qu'on n'a pas vue.
   **Le seul signal de fin fiable est le retour à `f=7, e=0`**, vérifié aux trois préparations, y
   compris celle qui n'a jamais quitté `f=10` : c'est l'état de repos **global** de la machine,
   pas la fin de la fonction café.

#### Aucune durée n'existe

Ni durée écoulée, ni durée restante, dans aucune des trois trames monitor. Le seul champ temporel
du protocole est l'horodatage de 4 octets en queue de trame, une horloge. L'app officielle n'affiche
d'ailleurs pas de temps : une barre de pourcentage et le nom de l'étape. Le « depuis N s » de
l'accueil est **mesuré par le serveur**, et l'interface le dit.

#### Effet de bord relevé

À l'instant où le lait commence à couler, l'octet 8 passe à `0x40` — **bit d'alarme 14,
`CLEAN_KNOB`** — et il **reste actif après la préparation** : la machine réclame le nettoyage de la
carafe. Vérifié en direct (`alarmBits = 0x4008`, soit filtre à eau + molette de nettoyage).

#### Où c'est implémenté

`src/lib/monitor.mjs` (`decodeMonitor`, `MONITOR_ETAPES`) — extrait de `server.mjs` parce que le
décodage est **pur**, ce qui rend `scripts/verif-monitor.mjs` possible : il rejoue les trois
captures ci-dessus (`scripts/captures/*.json`) et vérifie notamment que le lait chaud ne publie
jamais 100 %. C'est, avec l'ordonnanceur de tâches, la seule partie du protocole prouvable sans
l'appareil, et les deux tournent en CI.

## 12. Statistiques d'utilisation — `0xA2` (lecture de paramètres machine)

La machine tient des compteurs d'utilisation : nombre de boissons, détartrages, filtres, litres
d'eau… **62 paramètres** sur ce modèle. Ils ne se lisent pas comme les recettes.

### 12.1 Le piège des propriétés `d7xx_tot_*`

L'app connaît des propriétés Ayla à noms parlants (`p258z7/w.java` en donne la liste exacte) :

```
d700_tot_bev_b      d701_tot_bev_b       d701_tot_bev_bw     d702_tot_bev_other
d703_tot_bev_w      d719_id22_tea        d731_tot_mug_hot    d732_tot_mug_cold
d733_tot_bev_counters                    d550_water_calc_qty d552_cnt_calc_tot
d553_water_tot_qty  d554_cnt_filter_tot  d557_milk_cln_cnt
```

**Les lire directement ne renvoie rien.** Vérifié : les 14 ont été demandées en LAN
(`property.json?name=`), la machine a servi les 14 commandes et n'a poussé **aucune** valeur —
« import terminé : 0 propriétés lues ». C'est exactement le piège des Bean Systems (§ bean-adapt) :
la propriété reste vide tant que la commande ECAM correspondante n'a pas été envoyée.

### 12.2 La commande

Port de `p097j6.d.d0(paramAddress, qty)`, appelée par `DeLonghiWifiConnectService.W()`
(« readSettingsParameter ») :

```
0D 08 A2 0F <idHi> <idLo> <qty> <crc16>
```

- identifiant sur **16 bits big-endian** ;
- `qty` = nombre de paramètres demandés ;
- flag **`0x0F`**, comme la trame monitor — pas `0xF0` ;
- lecture pure, aucun effet sur la machine.

### 12.3 La réponse

Port de `p097j6.d.L()` case `-94` :

```
0        0xD0
1        len = taille totale − 1
2        0xA2
3        0x0F
4..      n entrées de 6 octets : id sur 16 bits BE, puis valeur sur 32 bits BE
2 dern.  CRC16
```

`n = (len − 5) / 6`. **Plafonné à 10 entrées par réponse**, quoi qu'on demande (`qty: 30` en renvoie
10).

Les valeurs sont **big-endian** (`z.g0()`), et deux éléments le confirment sur les trames réelles :
en little-endian les magnitudes seraient absurdes, et la relation `3002 + 3004 = 3000` (8 + 9097 =
9105) ne tient qu'en big-endian.

Exemple réel, `qty: 1` sur l'id 3000 :

```
d0 0b a2 0f  0b b8  00 00 23 91  2e c0   (+ 4 octets d'horodatage du datapoint)
             ^id 3000 ^valeur 9105  ^crc
```

### 12.4 La machine ÉNUMÈRE — c'est ce qui permet de cartographier

Demander un id inexistant ne produit pas d'erreur : la machine renvoie **les paramètres existants
suivants**, en sautant les trous. Demander l'id 100 renvoie
`100, 101, 105, 106, 108, 109, 111, 115, 116, 3000` — donc 102-104, 107, 110 et 112-114 n'existent
pas, et le bloc suivant commence à 3000.

⚠️ Ne pas interpréter cela comme un code d'erreur : une première lecture a conclu à tort que
« 23000 » était une sentinelle « paramètre inconnu », parce que demander 3047 (inexistant) renvoie
`23000`. C'est simplement le paramètre existant suivant.

D'où la méthode de balayage : demander `qty: 10`, reprendre au dernier id reçu + 1, s'arrêter quand
la liste n'avance plus.

### 12.5 Inventaire sur ECAM 610.75.MB

62 paramètres, en quatre blocs :

| Bloc | Identifiants |
|---|---|
| `1xx` | 100, 101, 105, 106, 108, 109, 111, 115, 116 |
| `3xxx` | 3000-3021, 3024, 3025, 3032, 3037-3046 |
| `23xxx` | 23000-23009 |
| `43xxx` | 43000, 43005, 43010, 43011, 43012, 43014, 43015, 43016 |

Les ids que l'app demande sur son écran de statistiques (`p018b7/e.java`) sont 105, 106, 108, 115,
3000, 3001, 3003, 3017, 3021, 3025, 3047, 3048, 3077, 3078, 3080 — **les cinq derniers n'existent
pas sur ce modèle**, ce qui explique qu'ils renvoient le bloc 23xxx.

### 12.6 Signification des identifiants

Il n'existe pas de table « id → nom » dans l'APK, mais `p018b7/e.java` **associe explicitement**
certains ids à l'énumération de catégories `p258z7/w.java$a`, ce qui donne 10 significations
**établies** (lecture de code, pas déduction) :

| id | catégorie (`w.a`) | note |
|---|---|---|
| 105 | `TOTAL_DESCALES` | nombre de détartrages |
| 106 | `TOTAL_LITRES_WATER` | unité = **0,5 ml** → litres = valeur / 2000 (`u.a(v) = v × 0,5`) |
| 108 | `TOTAL_FILTERS` | filtres à eau remplacés |
| 115 | `TOTAL_MILK_CLEANS` | nettoyages du circuit lait |
| 3000 | `TOTAL_BEVERAGE_BLACK` | boissons sans lait ; l'app y ajoute 3077 s'il existe |
| 3001 | `TOTAL_BEVERAGE_WITH_HOT_MILK` | l'app y ajoute 3003 |
| 3003 | idem, second compteur | sommé avec 3001 par l'app |
| 3017 | `TOTAL_BEVERAGE_WITH_COLD_MILK` | **Maestosa uniquement** (0 ici) |
| 3021 | `TOTAL_CHOCO` | chocolats |
| 3025 | `TOTAL_TEA` | thés |

⚠️ **La machine compte par CATÉGORIE, pas par boisson.** Il n'existe aucun compteur « nombre
d'espressos » : espresso, café long, doppio+ et americano alimentent tous `3000`. Le seul compteur
propre à une boisson est celui du thé — et la propriété `d719_id22_tea` le confirme, 22 étant bien
l'id du thé dans le catalogue. Ne jamais étiqueter un de ces nombres comme le compte d'une tasse
précise.

Les 52 autres identifiants restent **sans signification connue**. Pour les élucider :

1. **L'écran de la machine** — son menu statistiques affiche ses propres compteurs ; comparer un
   total affiché aux valeurs lues identifie l'id sans rien couler.
2. **Différentiel** — relever, préparer une boisson, relever à nouveau.

### 12.7 Un relevé différentiel réel (2026-08-20)

Deux relevés complets à 26 minutes d'intervalle, avec **une boisson sans lait** préparée entre les
deux (sans lait : 3001 et 3003 n'ont pas bougé). Sept compteurs seulement ont changé :

| id | delta | lecture |
|---|---|---|
| 3000 | **+1** | boissons sans lait — cohérent avec le sens établi en § 12.6 |
| 3004 | **+1** | suit la même chose que 3000 |
| 3037 | **+1** | suit également la même chose |
| 106 | +112 | × 0,5 ml = **56 ml** d'eau, plausible pour la tasse servie |
| 109 | +112 | **même delta** que 106 → même grandeur, même unité |
| 100 | +1120 | exactement **10 × 112** → même grandeur, unité dix fois plus fine |
| 101 | +145 | non proportionnel aux précédents : autre nature (durée ? mouture ?) |

Ce que cela **établit** : 3004 et 3037 s'incrémentent avec 3000, et 100/106/109 mesurent la même
grandeur dans trois unités différentes.

Ce que cela **n'établit pas** : ce que comptent exactement 3004, 3037 et 101, ni pourquoi trois
compteurs suivent la même chose (totaux par circuit ? depuis la dernière remise à zéro ?
depuis le dernier entretien ?). Un seul échantillon, une seule boisson, dont le type n'était pas
contrôlé. Ne rien en conclure de plus sans d'autres relevés.

La méthode, en revanche, est validée : un relevé avant/après suffit à isoler les compteurs
concernés par une boisson donnée.

Indices structurels déjà relevés (à confirmer, pas à supposer) :

- `3000 = 3002 + 3004` sur les valeurs réelles ;
- `23007` et `23008` portent exactement la même valeur ;
- les magnitudes séparent nettement trois familles : quelques unités (3006, 3007, 3013, 3043-3046),
  quelques milliers (3000, 3001, 3011, 3014, 3037), et des centaines de milliers à millions (100,
  106, 109, 23004-23008) — ces derniers ressemblant à des volumes ou des durées cumulées plutôt
  qu'à des comptages de tasses.

Les relevés complets ne sont pas reproduits ici : ce sont des données d'usage personnelles. Elles
vivent dans `lan-server/data/machine-beverages.json` (gitignoré) et `GET /api/stats` les expose.
Seules les quelques valeurs qui servent de **preuve de décodage** apparaissent ci-dessus (la trame
de l'id 3000 et la relation `3002 + 3004 = 3000`) : sans elles, rien ne démontrerait le
big-endian.

---

## 13. Identification du modèle — `d270_serialnumber` (commande `0xA1`)

**Élucidé et vérifié en direct le 2026-08-20.** La machine publie son numéro de série, et les
5 chiffres qui identifient le modèle sont dedans. Aucun cloud, aucun jeton, aucun compte.

### 13.1 Ce que fait l'app

`DeLonghiWifiConnectService.n1()` (« getWifiMachines ») ne demande pas le modèle au cloud. Il lit
la propriété Ayla **`d270_serialnumber`** via `l1()`, en tire un nom, puis appelle
`DefaultsTable.getDefaultValuesForMachine(nom)` — table `MachinesModels.json` **indexée par les
5 derniers caractères du `product_code`** (`DefaultsTable`, ligne 197 :
`product_code.substring(len − 5)`).

### 13.2 La dérivation

`l1()` convertit la valeur en chaîne hexadécimale via `z.e()`, qui écrit `" XX"` par octet — donc
**3 caractères par octet**, l'octet *n* occupant les indices 3n+1 et 3n+2. Les indices utilisés
(23, 26, 29, 32, 35, 71, 74) sont tous de la forme 3n+2 : c'est le **quartet bas** des octets
7 à 11 et 23, 24. Et `m1()`, juste en dessous, lit le numéro de série comme de l'**ASCII brut à
partir de l'octet 6**. Or pour un chiffre ASCII (`0x30`–`0x39`), le quartet bas EST le chiffre.

D'où, sans passer par l'hexadécimal :

```
série  = ASCII(octets 6 …)
nom    = "D" + série[1..5] + série[17] + série[18]
modèle = série[1..5]
```

### 13.3 Format de la trame (relevé sur la machine)

```
octet 0     0xD0
octet 1     len = taille totale − 1        (0x1B → 28 octets)
octet 2     0xA1                           ← la commande ; aucun autre usage connu
octet 3     0xF0
octets 4-5  ?                              (non identifiés)
octets 6..  numéro de série en ASCII        (19 caractères ici)
puis        0x00 de fin
2 derniers  CRC16
```

Exemple réel, chiffres du numéro de série masqués sauf la clé de modèle :

```
d0 1b a1 0f 00 cd  32 31 37 30 35 35 …  00 c3 6f
                   ^  ^^^^^^^^^^^^^^
                   │  « 17055 » = les 5 caractères qui donnent le modèle
                   └─ série[0], hors clé
→ nom « D1705596 »  →  clé 17055  →  product_code 0132217055  →  ECAM 610.75.MB (PD_SOUL)
```

`0xA1` n'a **pas** de décodeur générique dans le serveur : cette propriété est routée par son
**nom exact**, avant l'aiguillage par octet de commande.

### 13.4 Ce que ça permet, et ce que ça ne permet pas

La liste des boissons, les bornes des paramètres et **les noms des propriétés de recette**
dépendent du modèle : `d{39+i+(p−1)×21}` — ce 21 est le nombre de propriétés de recette standard
*du modèle*. Une table de travers ne donne donc pas une erreur franche, elle donne des lectures
qui visent à côté.

L'identification permet de **le détecter et de le dire**. Elle ne suffit pas à basculer le
catalogue : il faudrait rendre cette arithmétique dérivée du modèle, et non écrite pour un seul.

La table constructeur contient **117 machines**, dont **30 non-Bluetooth** — les seules capables
de LAN mode — en quatre familles : `PD_SOUL` (5 modèles, 28 recettes), `PD_SOUL_BETTER` (5, 22),
`STRIKER_BEST` (7, 48) et `STRIKER_GOOD` (13, 0 recette déclarée).

---

## 14. Écritures et réglages — `0x90`, `0x95`, `0xA5`, `0xAB`, `0xAD`

Relevé en extrayant les 23 constructeurs de trames de `p097j6/d.java` (les noms lisibles ont
survécu à l'obfuscation dans les appels `Log`) puis en croisant avec ce que
`DeLonghiWifiConnectService` envoie réellement. **L'application envoie 13 trames par Wi-Fi.**
Celles décrites ici en complétaient la moitié manquante : elles étaient toutes des ÉCRITURES, plus
la lecture symétrique des réglages.

### 14.1 Réglages machine — `0x95` (lecture) / `0x90` (écriture)

```
Lecture   0D 08 95 <flag> <addrHi> <addrLo> <qty> <crc16>          (9 octets)
Écriture  0D 0B 90 <flag> <addrHi> <addrLo> <v31..24> <v23..16> <v15..8> <v7..0> <crc16>   (12 o)
```

`flag` = `0x0F` si l'adresse est < 1000, `0xF0` sinon (règle recopiée de l'app ; toutes les
adresses connues sont sous 1000).

**Réponse `0x95`** — format DIFFÉRENT de `0xA2`, ne pas les confondre :

```
octet 1     len
octets 4-5  adresse du PREMIER réglage (16 bits)
octets 6…   n × 4 octets de valeur, adresses CONSÉCUTIVES ; n = (len − 7) / 4
```

L'identifiant n'est donc **pas** répété devant chaque valeur, contrairement à `0xA2`. Confondre
les deux formats décale chaque valeur d'un cran : des réglages plausibles et faux.

**Adresses connues** (relevées dans `p018b7/d.java`, le view-model de l'écran « réglages » :
chaque écran appelle `readParameter(addr, 1)` puis `writeParameter(addr, valeur)`) :

| Adresse | Réglage | Propriété Ayla équivalente (classic / Striker) |
|---|---|---|
| 50 | dureté de l'eau | `d283_mchn_sett_water` / `d283_mach_sett_water_hard` |
| 61 | température du café | `d281_mchn_sett_temp` / `d281_mach_sett_temperature` |
| 62 | arrêt automatique | `d282_mchn_sett_aoff` / `d282_mach_sett_auto_off` |
| 63 | **champ de bits** (voir ci-dessous) | `d284_mchn_sett_user_conf` / `d284_mach_sett_user_conf` |
| 64 | démarrage automatique — heures | — |
| 65 | démarrage automatique — minutes | — |
| 194 | inconnu (lu par l'app, jamais écrit) | — |
| 210 | code PIN (valeur encodée) | — |

**Ces réglages existent donc AUSSI comme propriétés Ayla.** L'app choisit la propriété quand la
machine est jointe par le cloud et la trame sinon (`p018b7/d.X()` fait exactement ce test pour la
dureté de l'eau). Les deux chemins sont utilisables en LAN ; le serveur demande les deux.

**Adresse 63 — champ de bits** (`p018b7/d.f0()`, et `Parameter.f()/g()` qui testent l'octet de
POIDS FAIBLE des 4, soit `b[3]`) :

| Bit | Masque | Réglage | Sens |
|---|---|---|---|
| 0 | 0x01 | démarrage automatique | **INVERSÉ** : bit à 1 = désactivé |
| 2 | 0x04 | signal sonore | 1 = activé |
| 3 | 0x08 | éclairage de la tasse | 1 = activé |
| 4 | 0x10 | économie d'énergie | 1 = activé |
| 5 | 0x20 | chauffe-tasses | 1 = activé |

⚠️ Écrire cette adresse **remplace les cinq bits d'un coup**. Il faut donc lire l'octet courant et
n'en changer qu'un ; poser l'octet depuis un état supposé éteint les quatre autres réglages.

⚠️ **Tous les modèles n'exposent pas tous les réglages.** `MachinesModels.json` porte un drapeau par
réglage (`water_hardness_settings`, `auto_off_settings`, `buzzer_settings`, `cup_light_settings`,
`cup_warmer_settings`, `energy_saving_settings`, `auto_start_settings`, `time_settings`,
`pin_settings`, `filter_settings`). Pour l'ECAM 610.75 : dureté de l'eau, arrêt automatique, filtre,
signal sonore et économie d'énergie sont déclarés ; démarrage programmé, chauffe-tasses, éclairage
de tasse, horloge et code PIN ne le sont pas.

### 14.2 Écriture des noms — `0xA5` (profils) / `0xAB` (recettes perso)

```
0D <len> A5|AB F0 <premier> <dernier> [ 20 octets de nom UTF-16BE + 1 octet d'icône ] × n <crc16>
len = n × 21 + 7
```

Pendant exact des lectures `0xA4` / `0xAA` (§ 8.2), **même pas de 21 octets**. Les octets 4 et 5
portent le premier et le dernier index comme en lecture, ce qui permet d'écrire **une seule
entrée** (`premier = dernier = index`) sans toucher aux autres — c'est ce que fait l'app.

⚠️ La variante Striker (`d.k0()`) a un pas de **22** octets : une valeur de plus par entrée.
Écrire un bloc au mauvais pas décale tous les noms suivants.

### 14.3 Ordre des favoris — `0xAD`

```
0D 12 AD F0 <profil> <12 identifiants de boisson> <crc16>          (19 octets, longueur FIXE)
```

Pendant de la lecture `0xA8` (§ 8.3). Exactement 12 emplacements : une liste plus courte se
complète de zéros.

### 14.4 Modes de monitor — `0x60`, `0x70`, `0x75`

`getByteMonitorMode` (`p097j6/d.V()`) construit trois trames de la même forme
`0D 05 <cmd> 0F <crc16>` selon son argument : `0` → `0x60`, `1` → `0x70`, `2` → `0x75`.

**Seul `0x75` est envoyé par le service Wi-Fi de l'application** ; les deux autres n'apparaissent
que côté Bluetooth. Contenu de leur réponse **inconnu**, et rien ne garantit que le module y
réponde en mode LAN. Le serveur les expose comme des sondes (`POST /api/monitormode`) qui
journalisent la réponse brute sans la décoder.

### 14.5 Restant non porté

- `0xE8` — `getPacketForRefreshAppId`, trame fixe `0D 06 E8 F0 00 ED 7C <crc16>`, variante Striker.
  En classic l'app envoie à la place un blob de 12 octets qui **ne commence pas par `0x0D`** (donc
  pas une trame ECAM). Rôle non établi.
- `0xA1` en LECTURE de paramètres : `d.r0(addr, qty)` choisit `0xA1` quand `qty > 4` et `0x95`
  sinon. On ne sait pas ce que la première forme change.

## 15. Le référentiel des commandes, et comment il se complète

Ce document est la table de référence ; `lan-server/src/lib/ecam-args.mjs` en est la forme
exécutable. Un seul module y porte **tout** ce qui nomme une commande ECAM :

| ce qu'il porte | à quoi ça sert |
|---|---|
| `ECAM_OPS` | la nature (lecture / action / écriture) et le nom de chaque octet de commande |
| `opTrame(b64)` | lire une trame **sortante** — celles que nous émettons portent 4 octets d'horodatage en queue, retirés ici |
| `opReponse(valeur)` | lire une trame **entrante** — une réponse n'en porte pas, et la valeur est d'abord vérifiée |
| `natureTrame` | décide si un pas attend une réponse ou une fenêtre de présence (§ 5.1) |
| `describeFrame` | l'opération et les octets ; `{ octets: false }` pour un libellé de tâche |
| `profilVise` | le profil visé, `0xA9` octet 4 ou `0x83` `(profil << 2) \| action` (§ 1.3) |
| `argumentsTrame` | les arguments en clair — l'inverse exact des constructeurs de trames |
| `TWO` | les paramètres de recette sur 16 bits (§ 3) |

Une table de protocole dupliquée diverge au premier ajout **sans lever la moindre erreur** : on
obtient des valeurs plausibles et fausses. `TWO` a existé en trois exemplaires avant d'être
ramenée ici.

### 15.1 Ce qui n'y est pas se voit — c'est le but

L'application officielle est le seul émetteur au monde à produire des trames que nous n'avons
jamais vues, et **elle ne les rejoue pas** : ce qui n'est pas relevé au passage est perdu. Le
multiplexeur (§ 7 de `analyse-connexion-wifi.md`) est donc un instrument de relevé, et ses deux
journaux marquent l'inconnu en capitales plutôt que de le laisser se fondre dans le reste :

| marqueur | ce qu'il signale | ce qu'il conserve |
|---|---|---|
| `commande NON IDENTIFIÉE (0x..)` | un octet de commande absent d'`ECAM_OPS` | la trame complète, en hexadécimal |
| `PROPRIÉTÉ NON IDENTIFIÉE` | une propriété Ayla que le serveur ne sait pas nommer | hexadécimal **et** base64 d'origine |
| `valeur non-trame : …` | une valeur qui n'est pas de l'ECAM du tout | la valeur, mot pour mot |

L'hexadécimal se compare aux tables de ce document ; le base64 se recolle tel quel dans un test
ou un rejeu. Aucun des trois n'interprète quoi que ce soit : un outil qui a déjà décidé quoi
jeter ne peut plus rien apprendre.

**Une valeur n'est lue comme une trame qu'après vérification de sa forme.** `Buffer.from(x,
"base64")` ne lève jamais : il ignore ce qui n'en est pas et rend des octets qui ont l'air de
quelque chose. Relevé en direct : `device_connected = 1787407876`, un horodatage unix en clair
que la vraie application nous écrit, se journalisait « commande 0x3b non décodée — d7 bf 3b e3
4e fc ef ». Sept octets inventés là où la valeur était lisible telle quelle — et surtout, cet
octet fabriqué servait à **aiguiller** le décodage. La vérification est donc : forme base64,
puis en-tête `0xD0` (réponse) ou `0x0D` (requête), sinon ce n'est pas une trame.

### 15.2 L'invariant à tenir en ajoutant un décodeur

> ⚠️ **Une réponse que le serveur décode parfaitement mais qui manque à `ECAM_OPS` produit un
> faux signal de découverte** : le journal la crie « NON IDENTIFIÉE » alors qu'elle est connue,
> et le marqueur perd sa valeur d'alerte.

Ajouter un décodeur, c'est donc ajouter sa ligne à la table dans le même geste.
`lan-server/scripts/verif-args.mjs` le vérifie en CI sur les octets effectivement routés :
`0xA1`, `0xA2`, `0xA3`, `0xA4`, `0xA6`, `0xA8`, `0xAA`, `0xB0`, `0xBA`, `0x95`.

### 15.3 Commandes connues de l'app mais absentes de la table

Elles sont listées ici pour être **reconnues quand elles passeront**, pas pour être décodées :
voir § 14.5 pour `0xE8` et pour `0xA1` en lecture de paramètres. Tant qu'aucune n'a été observée
en mode LAN, elles n'entrent pas dans `ECAM_OPS` — une entrée inventée ferait taire le marqueur
qui doit justement se déclencher le jour où l'une d'elles arrive.


#### 15.1. « Non identifiée » ne doit jamais vouloir dire « pas une trame »

Relevé en direct, dans le journal des applications, pendant une session de la vraie application :

```
18:48:54  IN a1  commande NON IDENTIFIÉE (0x37) · trame 45 da 37 88 34 eb af ff ff fa 93 81
```

Une trame ECAM commence par `0x0D`. Celle-ci commence par `0x45`. Ce n'était donc pas une commande
inconnue : **ce n'était pas une trame du tout**, et le troisième octet — `0x37` — n'était le code
d'aucune opération, seulement l'octet qui se trouvait là.

> ⚠️ **`Buffer.from(x, "base64")` ne lève jamais.** Il ignore ce qui n'est pas du base64 et rend
> des octets d'allure plausible. Toute valeur ressort donc avec un « octet de commande », qu'elle
> en ait un ou non.

Le défaut était déjà connu **dans l'autre sens** : `device_connected = 1787407876`, un horodatage
unix, avait été journalisé « commande 0x3b non décodée — d7 bf 3b e3 4e fc ef », sept octets
inventés là où la valeur se lisait telle quelle. Il avait été corrigé côté entrant (`opReponse`) et
**pas côté sortant**, où il compte pourtant davantage : c'est une valeur qu'on relaie à une vraie
cafetière.

Le filtre vit maintenant en un seul endroit, `octetsEcam()`, et les deux sens le lisent — forme
base64 valide, longueur suffisante, en-tête `0x0D` (requête) ou `0xD0` (réponse). Hors de là,
`describeFrame()` répond :

```
valeur non-trame · 45 da 37 88 34 eb af ff ff fa 93 81 · b64 Rdo3iDTrr///+pOB
```

Trois choix dans cette ligne, chacun pour une raison :

- **aucun octet n'est rogné.** `describeFrame()` retire les 4 octets d'horodatage d'une trame —
  c'est juste quand on sait ce qu'on regarde, et faux dès qu'on ne le sait pas ;
- **l'hexadécimal**, pour se comparer aux tables de ce document ;
- **le base64 d'origine**, parce qu'il se recolle tel quel dans un test ou un rejeu.

L'enjeu n'est pas cosmétique. Ce marqueur existe pour faire ressortir ce que le référentiel ne
connaît pas encore ; une valeur mal nommée y **fabrique une découverte qui n'existe pas**, et
masque du même coup la seule information vraie — que cette valeur n'est pas une trame. Reste, elle,
une vraie question ouverte — et la ligne ci-dessus n'en montre qu'une partie. `describeFrame()`
retirait **quatre octets d'office** (l'horodatage d'une trame) : les douze affichés sont les douze
survivants, **la valeur en faisait seize**, et les quatre derniers sont perdus pour cette capture.
C'est ce rognage que la correction supprime, mais elle lui est postérieure.

> ⚠️ **Seize octets, c'est exactement un bloc AES**, et le § 7sexies de
> `analyse-connexion-wifi.md` décrit précisément cette signature : en CBC, un message sauté ne
> salit que les **16 premiers octets** du message suivant. L'hypothèse à écarter AVANT de chercher
> une commande inconnue est donc que ce ne soit pas de l'applicatif du tout, mais un bloc de tête
> sali — auquel cas l'information n'est pas dans ces octets, elle est **en amont** : un message qui
> a disparu juste avant.

