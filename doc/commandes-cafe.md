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
`lan-server/src/lib/machine-model.json` (extraite) + `src/lib/beverages.mjs` (libellés FR,
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
| 27 | `INDEX_LENGTH` | Longueur d'index | 1 |
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
| Écrire un paramètre | `0D 0B 90 <flag> …` | 0x90 |
| Sauver/supprimer Bean System | `0D 33 BB F0 …` (52 o) | 0xBB — voir `bean-adapt.md` |
| Lire un monitor | réponse `D0 12 75 0F …` | 0x75 |

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

Perso : `d200_1_cstm_recipe_01` … `d205_1_cstm_recipe_06`. Bean System :
`d160_1_bs_recipe_01`. (Relevés pour le profil 1 ; l'incrément par profil reste à confirmer.)

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
octets 9,10,11    compteurs/divers (accesseurs f(), e(), d() de l app)
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
| 1 | 0 | `IFD_CARAFFE` | **carafe à lait** |
| 1 | 1 | `CIOCCO_TANK` | bac chocolat |
| 1 | 2 | `CLEAN_KNOB` | molette nettoyage |
| 1 | 5 | `DOOR_OPENED` | porte ouverte |
| 1 | 6 | `PREGROUND_DOOR_OPENED` | trappe café moulu ouverte |

### 11.2 États observés (octet 4)

| Valeur | Sens | Certitude |
|---|---|---|
| `0x04` | **veille** | confirmé (extinction/allumage suivis en direct) |
| `0x02` | **prête** — écran de sélection des boissons | confirmé par l'écran de la machine |
| `0x00` | en chauffe | déduit : relevé juste après un réveil |

Le serveur raisonne donc « **éveillée sauf 0x04** » plutôt que sur une liste blanche d'états
allumés : une version précédente n'acceptait que `0x00` et affichait « état inconnu » alors que la
machine était bel et bien prête.

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

Reste ouvert :

- **Import réel** : lancer `POST /api/beverages/import` machine réveillée et vérifier que les
  21 propriétés de bornes remontent bien (le décodeur est validé sur une trame, pas encore sur
  les 21). Vérifier au passage si la machine répond aux lectures **en veille**.
- **Propriétés par profil 2..5** : la formule `offsetBase + (profileId − 1) × 21` est déduite du
  code, seulement observée pour le profil 1.
- **profileId courant** : lire sur la machine avant d'émettre une préparation (on force 1).
- **Noms des recettes perso et des profils** : `0xAA` / `0xA4`, chaînes UTF-16BE de 20 octets,
  pas de 22 octets sur cette machine (parser `K0()`).
- **Comportement du `checkValues`** (bit 0x80 sur le mode) : à tester prudemment.
- Valider une trame « lancer espresso » de bout en bout, machine sous surveillance, avant
  d'automatiser.

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
