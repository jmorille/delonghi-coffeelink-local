# Format des trames d'une boisson — décodage pas à pas

**Établi le 2026-08-23**, sur des trames réellement lues d'une ECAM 610.75.MB. Chaque octet cité
ci-dessous a été revérifié : longueur annoncée, CRC recalculé, et parcours relu par le décodeur de
production (`decodeRecipeBounds` / `decodeRecipeValues` de `src/lib/beverages.mjs`).

Ce document déroule **six trames `0xB0`** — une octet par octet au § 1, cinq autres comparées au
§ 2 — puis les deux autres trames d'une boisson. C'est un **exemple déroulé**, pas une spécification : les formats sont spécifiés au
[§ 6 de `commandes-cafe.md`](commandes-cafe.md), la commande de préparation au § 1, la table des
identifiants de paramètre au § 4. Ce qui manquait, c'était un parcours octet par octet sur le cas le
plus large, et la réponse à une question qu'on se pose forcément en le lisant : *où est le drapeau
qui dit qu'il y a du café, du lait, de l'eau ?*

Presque rien ici n'est spécifique à un appareil : pas de série, pas d'adresse, et le mug de voyage
est une boisson du catalogue dont les valeurs enregistrées sont celles d'usine. **La seule différence
avec la copie privée de `../docs/` est le nom d'un emplacement perso** — un nom saisi sur la machine,
donc masqué ici (§ 4) et conservé là-bas.

## Pourquoi le mug de voyage

Sur les 28 boissons de ce modèle, **c'est la seule qui déclare les trois quantités à la fois** —
café, lait et eau chaude. Café + eau existe ailleurs (Americano 40/110 ml, Long Black 80/120 ml),
café + lait sur huit boissons, mais les trois ensemble nulle part d'autre. C'est donc la trame la
plus large que ce modèle produise pour une recette, et celle qui exerce tous les cas du parcours.

Ses trois quantités valent **0**, sous des minimums de 40, 60 et 50 : cette boisson n'a jamais été
configurée. C'est une propriété du modèle et non de l'exemplaire — les *défauts* valent 0 eux aussi.

## Trois trames, trois rôles — ne pas les confondre

| Trame | Sens | Ce qu'elle dit |
|---|---|---|
| `0xB0` | machine → nous | **ce que la boisson déclare** : quels paramètres, et leurs bornes min/défaut/max |
| `0xA6` | machine → nous | **ce qu'un profil a enregistré** : une valeur par paramètre |
| `0x83` | nous → machine | **l'ordre** : préparer cette boisson, ou écrire cette recette dans un profil |

Les bornes sont communes aux cinq profils ; seules les valeurs sont par profil. Un profil ne peut que
choisir une valeur à l'intérieur des bornes.

## 1. `0xB0` — ce que la boisson déclare

Propriété `d020_rec_mug_to_go`. 56 octets.

```
d0 37 b0 f0 1a   <entrées…>   9a 25
│  │  │  │  └─── boisson : 0x1a = 26 (mug de voyage)
│  │  │  └────── flag 0xF0
│  │  └───────── commande 0xB0 — bornes d'une recette (RECIPE_MIN_MAX_SYNC)
│  └──────────── len = 0x37 = 55 = taille totale − 1  →  56 octets
└─────────────── en-tête de RÉPONSE (0xD0 ; une requête porte 0x0D)
```

CRC-CCITT, init **`0x1D0F`**, sur tous les octets **sauf les deux derniers**. Recalculé : `9a25`,
identique à celui porté par la trame.

Puis on marche séquentiellement à partir de l'offset 5 : **1 octet d'identifiant, puis min, défaut,
max**.

| offset | octets | id | nom | min | déf. | max |
|---:|---|---:|---|---:|---:|---:|
| 5 | `18 00 01 01` | 24 | `PROGRAMABLE` | 0 | 1 | 1 |
| 9 | `01 00 28 00 00 00 f0` | 1 | **`COFFEE`** (16 b) | 40 | 0 | 240 |
| 16 | `02 01 03 05` | 2 | `TASTE` | 1 | 3 | 5 |
| 20 | `09 00 3c 00 00 01 cc` | 9 | **`MILK`** (16 b) | 60 | 0 | 460 |
| 27 | `04 00 00 00` | 4 | `BLEND` | 0 | 0 | 0 |
| 31 | `0c 00 00 01` | 12 | `INVERSION` | 0 | 0 | 1 |
| 35 | `1c 00 00 04` | 28 | `ACCESSORIO` | 0 | 0 | 4 |
| 39 | `19 00 02 02` | 25 | `VISIBLE` | 0 | 2 | 2 |
| 43 | `0f 00 32 00 00 01 04` | 15 | **`HOT_WATER`** (16 b) | 50 | 0 | 260 |
| 50 | `1b 00 ff 04` | 27 | `INDEX_LENGTH` | 0 | 255 | 4 |
| 54 | `9a 25` | — | CRC | | | |

`5 + 7×4 + 3×7 + 2 = 56` ✓ — l'arithmétique tombe sur le CRC, ce qui est la preuve que chaque
largeur était la bonne.

### La largeur, et pourquoi on ne peut pas indexer par position

Une entrée fait **4 octets** (valeurs 8 bits) ou **7 octets** (valeurs 16 bits big-endian). Les
paramètres 16 bits sont les quantités liquides : `COFFEE` (1), `MILK` (9), `HOT_WATER` (15) — la
table `TWO` de `src/lib/ecam-args.mjs`.

Deux conséquences pratiques :

- **L'ordre est celui de la machine, pas celui des identifiants.** Ici : 24, 1, 2, 9, 4, 12, 28, 25,
  15, 27. Rien ne garantit cet ordre d'une boisson à l'autre, donc on lit les identifiants, on ne
  compte pas les positions.
- **Une largeur mal choisie décale tout ce qui suit et produit des valeurs plausibles.** C'est
  exactement ce que `exact: false` signale dans `beverages.mjs` : le parcours ne tombe plus sur le
  CRC. Une trame `exact: false` ne se rattrape pas au coup d'après — toutes ses valeurs sont
  douteuses, y compris celles lues avant le décalage, puisqu'on ne sait plus lequel est le premier
  paramètre mal aligné.

La table des largeurs n'est **pas dans l'APK** : l'application la télécharge (`getCommonData.sr`).
Les trois quantités ci-dessus ont été établies par le décodage exact, pas par cette table.

## 2. Cinq autres trames `0xB0` — et ce que la comparaison démolit

Cinq trames de plus, relues par le même décodeur : longueur annoncée conforme, CRC recalculé
conforme, et parcours tombant exactement sur le CRC (`exact: true`) pour les cinq. Elles ne sont pas
là pour l'illustration — **elles réfutent deux affirmations que ce dépôt portait par écrit**, dont une
qui vivait dans un commentaire de code (§ 2.6).

| boisson | id | propriété | octets | entrées |
|---|---:|---|---:|---:|
| Espresso | 1 | `d001_rec_espresso` | 38 | 7 |
| Cappuccino doppio+ | 13 | `d013_rec_capp_doppio` | 41 | 7 |
| Eau chaude | 16 | `d015_rec_hot_water` | 26 | 4 |
| Thé | 22 | `d016_rec_tea` | 30 | 5 |
| Emplacement perso 1 | 230 | `d028_rec_custom_1` | 45 | 8 |
| *(rappel, § 1)* Mug de voyage | 26 | `d020_rec_mug_to_go` | 56 | 10 |

⚠️ **L'indice de la propriété n'est pas l'identifiant de la boisson.** « Eau chaude » est la boisson
**16** et se lit dans `d015_…` ; le thé est la **22** et se lit dans `d016_…`. Les deux numérotations
sont indépendantes — c'est le catalogue qui les apparie — et les confondre fait lire les bornes d'une
autre boisson.

### 2.1 Eau chaude (16) — la plus courte du modèle

`d0 19 b0 f0 10 … 37 96` — 26 octets, `len` = 0x19 = 25 → 26 ✓, CRC recalculé `3796` ✓.

| offset | octets | id | nom | min | déf. | max |
|---:|---|---:|---|---:|---:|---:|
| 5 | `18 00 01 01` | 24 | `PROGRAMABLE` | 0 | 1 | 1 |
| 9 | `19 00 01 01` | 25 | `VISIBLE` | 0 | 1 | 1 |
| 13 | `0f 00 14 00 fa 01 a4` | 15 | **`HOT_WATER`** (16 b) | 20 | 250 | 420 |
| 20 | `1b 00 01 04` | 27 | `INDEX_LENGTH` | 0 | 1 | 4 |
| 24 | `37 96` | — | CRC | | | |

`5 + 3×4 + 7 + 2 = 26` ✓. Une seule quantité, et son défaut (250) tombe dans ses bornes : cette
boisson est configurée d'usine et ne compose pas.

### 2.2 Thé (22)

`d0 1d b0 f0 16 … ae 16` — 30 octets, `len` = 0x1d = 29 → 30 ✓, CRC `ae16` ✓.

| offset | octets | id | nom | min | déf. | max |
|---:|---|---:|---|---:|---:|---:|
| 5 | `18 00 01 01` | 24 | `PROGRAMABLE` | 0 | 1 | 1 |
| 9 | `19 00 02 02` | 25 | `VISIBLE` | 0 | 2 | 2 |
| 13 | `0f 00 14 00 96 01 a4` | 15 | **`HOT_WATER`** (16 b) | 20 | 150 | 420 |
| 20 | `1b 00 01 04` | 27 | `INDEX_LENGTH` | 0 | 1 | 4 |
| 24 | `0d 00 01 03` | 13 | `THE_TEMP` | 0 | 1 | 3 |
| 28 | `ae 16` | — | CRC | | | |

`5 + 4 + 4 + 7 + 4 + 4 + 2 = 30` ✓. C'est la seule des six à déclarer `THE_TEMP` (13) — l'autre
réglage qu'aucun emplacement perso ne porte, et donc la seconde moitié du refus
`hotWaterNotInCustomSlot` de `transfert.mjs`.

### 2.3 Espresso (1)

`d0 25 b0 f0 01 … b9 96` — 38 octets, `len` = 0x25 = 37 → 38 ✓, CRC `b996` ✓.

| offset | octets | id | nom | min | déf. | max |
|---:|---|---:|---|---:|---:|---:|
| 5 | `08 00 00 01` | 8 | `DUExPER` (2 tasses) | 0 | 0 | 1 |
| 9 | `18 00 01 01` | 24 | `PROGRAMABLE` | 0 | 1 | 1 |
| 13 | `01 00 14 00 28 00 b4` | 1 | **`COFFEE`** (16 b) | 20 | 40 | 180 |
| 20 | `1b 00 01 04` | 27 | `INDEX_LENGTH` | 0 | 1 | 4 |
| 24 | `02 00 04 05` | 2 | `TASTE` | 0 | 4 | 5 |
| 28 | `04 00 00 00` | 4 | `BLEND` | 0 | 0 | 0 |
| 32 | `19 00 01 01` | 25 | `VISIBLE` | 0 | 1 | 1 |
| 36 | `b9 96` | — | CRC | | | |

`5 + 6×4 + 7 + 2 = 38` ✓. **La trame commence par un paramètre que le mug de voyage n'a pas** :
`DUExPER` (8), le doublement de tasse.

### 2.4 Cappuccino doppio+ (13)

`d0 28 b0 f0 0d … 9a de` — 41 octets, `len` = 0x28 = 40 → 41 ✓, CRC `9ade` ✓.

| offset | octets | id | nom | min | déf. | max |
|---:|---|---:|---|---:|---:|---:|
| 5 | `1c 02 02 02` | 28 | `ACCESSORIO` | **2** | 2 | **2** |
| 9 | `18 00 01 01` | 24 | `PROGRAMABLE` | 0 | 1 | 1 |
| 13 | `19 00 01 01` | 25 | `VISIBLE` | 0 | 1 | 1 |
| 17 | `01 00 50 00 64 00 b4` | 1 | **`COFFEE`** (16 b) | 80 | 100 | 180 |
| 24 | `1b 00 01 04` | 27 | `INDEX_LENGTH` | 0 | 1 | 4 |
| 28 | `09 00 32 00 96 04 38` | 9 | **`MILK`** (16 b) | 50 | 150 | 1080 |
| 35 | `04 00 00 00` | 4 | `BLEND` | 0 | 0 | 0 |
| 39 | `9a de` | — | CRC | | | |

`5 + 5×4 + 2×7 + 2 = 41` ✓. Deux choses ici, et elles sont toutes deux des cas limites du code :

- **`ACCESSORIO` a `min == max == 2`** : la valeur est imposée, non réglable, et **doit quand même
  partir dans la trame `0x83`** — même règle que l'`INVERSION` d'un flat white, qui est ce qui
  sélectionne l'action de préparation.
- **Cette boisson déclare `COFFEE` sans `TASTE`.** Une quantité n'entraîne pas ses options : le
  cappuccino ordinaire (7) porte bien `TASTE 0/3/5`, le doppio+ non. Le catalogue extrait de l'APK
  dit la même chose, donc ce n'est pas une lacune de lecture.

### 2.5 Un emplacement perso (230)

`d0 2c b0 f0 e6 … 39 92` — 45 octets, `len` = 0x2c = 44 → 45 ✓, CRC `3992` ✓. `0xe6` = 230, le
premier des emplacements perso.

| offset | octets | id | nom | min | déf. | max |
|---:|---|---:|---|---:|---:|---:|
| 5 | `18 00 01 01` | 24 | `PROGRAMABLE` | 0 | 1 | 1 |
| 9 | `01 00 14 00 00 00 b4` | 1 | **`COFFEE`** (16 b) | 20 | **0** | 180 |
| 16 | `02 00 ff 05` | 2 | `TASTE` | 0 | **255** | 5 |
| 20 | `09 00 32 00 00 04 38` | 9 | **`MILK`** (16 b) | 50 | **0** | 1080 |
| 27 | `04 00 00 00` | 4 | `BLEND` | 0 | 0 | 0 |
| 31 | `0c 00 00 01` | 12 | `INVERSION` | 0 | 0 | 1 |
| 35 | `1c 00 00 04` | 28 | `ACCESSORIO` | 0 | 0 | 4 |
| 39 | `19 00 00 01` | 25 | `VISIBLE` | 0 | 0 | 1 |
| 43 | `39 92` | — | CRC | | | |

`5 + 6×4 + 2×7 + 2 = 45` ✓. C'est la trame qui montre les **deux** marqueurs de « jamais configuré »
côte à côte, et sur des paramètres de nature différente : une quantité à `0` sous un minimum de 20 ou
50, et une option à `255` au-dessus d'un maximum de 5 (§ 4). Elle ne déclare ni `HOT_WATER` (15) ni
`INDEX_LENGTH` (27).

### 2.6 Ce que la comparaison établit

⚠️⚠️ **Les bornes d'un réglage ne sont PAS les mêmes d'une boisson à l'autre.** C'est la réfutation
la plus lourde de conséquences ici, parce que l'affirmation inverse était écrite dans le code —
`src/lib/transfert.mjs` et `scripts/verif-transfert.mjs` justifiaient tous deux l'absence de bornage
par « les bornes d'un paramètre sont les mêmes d'une boisson à l'autre, sans quoi la machine ne
saurait pas la préparer ». Les six trames le démentent :

| réglage | mesuré au plus étroit | mesuré au plus large |
|---|---|---|
| `COFFEE` (1) | 80–180 (cappuccino doppio+) | 20–180 (espresso, perso) et 40–**240** (mug de voyage) |
| `MILK` (9) | 60–460 (mug de voyage) | 50–**1080** (cappuccino doppio+, perso) |
| `HOT_WATER` (15) | 50–260 (mug de voyage) | 20–**420** (eau chaude, thé) |

Un minimum de café qui vaut 20, 40 ou 80 selon la boisson, un maximum d'eau chaude qui passe de 260 à
420 : une valeur reportée telle quelle d'une boisson à l'autre **peut atterrir hors des bornes de la
cible**. La conclusion du code — `planTransfert` ne borne rien — reste la bonne, mais pour une raison
qui n'est pas celle qui était écrite : ce module ne reçoit **pas** les bornes de la cible, seulement
la liste des identifiants qu'elle déclare, donc il n'a pas de quoi borner et n'a pas à en faire
semblant. L'écart est signalé là où les bornes sont connues — `editor.initialOutOfBounds` sur une
recette rouverte, `recipes.freeOutOfTarget` à l'enregistrement.

**L'ordre des entrées change à chaque boisson, y compris la première.** Mesuré :

```
mug de voyage (26)       24  1  2  9  4 12 28 25 15 27
espresso (1)              8 24  1 27  2  4 25
cappuccino doppio+ (13)  28 24 25  1 27  9  4
eau chaude (16)          24 25 15 27
thé (22)                 24 25 15 27 13
emplacement perso (230)  24  1  2  9  4 12 28 25
```

Trois premières entrées différentes sur six trames (24, 8, 28). Il n'y a donc **aucune position
fixe**, pas même pour l'ouverture du corps : on lit les identifiants, on ne compte jamais les rangs.
Le nombre d'entrées va de **4 à 10**, et le jeu de paramètres lui-même change.

**`VISIBLE` (25) à `0/2/2` n'est pas propre au mug de voyage** — le thé le porte aussi. La note de fin
de ce document affirmait le contraire (« borné 0-1 partout ailleurs sur ce modèle ») sur la foi d'une
seule trame ; elle est corrigée. Mesuré : `0/1/1` sur eau chaude, espresso et cappuccino doppio+,
`0/2/2` sur thé et mug de voyage, `0/0/1` sur l'emplacement perso. Ce que vaut le **2** reste inconnu.

⚠️ **Le catalogue de l'APK et la machine se contredisent sur le thé.** Le catalogue extrait déclare
`ingredients = [13, 15, 24, 27, 28]` — donc `ACCESSORIO` (28) et pas `VISIBLE` (25) — là où la trame
déclare `VISIBLE` et pas `ACCESSORIO`. Les cinq autres boissons concordent exactement. **Sur
désaccord, la trame gagne** : c'est la déclaration de l'appareil, le catalogue n'est qu'une capacité
lue dans un binaire. Cela vaut d'être su avant de bâtir quoi que ce soit sur `bev.ingredients` — ce
que fait `planTransfert` pour la liste des réglages de la cible.

**`min == max` existe, et sous deux formes.** `ACCESSORIO 2/2/2` (cappuccino doppio+) est une valeur
imposée par la boisson ; `BLEND 0/0/0` est déclaré par les quatre trames qui le portent et n'est
réglable sur aucune. Ni l'un ni l'autre ne s'omet dans un `0x83`.

**La règle `composable` se relit sur les six trames, et elle sélectionne les deux mêmes.** Espresso
(une quantité, défaut 40 utilisable), cappuccino doppio+ (deux quantités, défauts 100 et 150
utilisables), eau chaude et thé (une seule quantité) : non. Emplacement perso 230 (deux quantités,
défauts hors bornes) et mug de voyage (trois quantités, défauts hors bornes) : oui. Ces trames sont
figées dans `scripts/verif-transfert.mjs`, qui rejoue ces verdicts sans machine.

## 3. Il n'y a AUCUN drapeau café / lait / eau

C'est le point important, et c'est une réponse négative : **la présence d'un ingrédient n'est pas un
bit.** Il n'existe pas d'octet de masque, ni dans cette trame ni dans les autres.

Ce qui existe :

- **L'ingrédient est identifié par son identifiant de paramètre** — `0x01` café, `0x09` lait,
  `0x0f` eau chaude. Dans cette trame ils sont aux offsets **9, 20 et 43**.
- **La trame `0xB0` ne dit que ceci** : « cette boisson déclare ces trois quantités, voici leurs
  bornes ». C'est une déclaration de capacité, pas un contenu.
- **La présence se lit dans la QUANTITÉ**, et elle se lit dans la trame de valeurs `0xA6`. Un
  ingrédient est absent quand sa quantité est **sous son minimum** — la convention de la machine est
  `0`, une valeur hors bornes par construction.

C'est aussi la règle de l'application officielle : `Q6.g.i()` n'ajoute le bloc café — quantité puis
`TASTE` — que `if (recipeData.k() > 0)`. Cocher un ingrédient, c'est lui donner une quantité ; la
présence n'a donc pas d'état à elle, et deux sources de vérité pour un même fait seraient deux
occasions de diverger.

## 4. `0xA6` — ce que le profil a enregistré

Propriété `d058_1_rec_mug_to_go`. 29 octets. Requête : `0D 07 A6 F0 <profil> <boisson> <crc>`.

```
d0 1c a6 f0 01 1a   <paires…>   37 9b
│  │  │  │  │  └─── boisson 0x1a = 26
│  │  │  │  └────── profil 0x01 = 1
│  │  │  └───────── flag 0xF0
│  │  └──────────── commande 0xA6 — valeurs d'un profil (RECIPE_QTY_READ)
│  └─────────────── len = 0x1c = 28  →  29 octets
└────────────────── en-tête de réponse
```

Même règle de largeur, mais des **paires** au lieu de quadruplets : identifiant, puis valeur.

| offset | octets | id | nom | valeur |
|---:|---|---:|---|---:|
| 6 | `01 00 00` | 1 | **`COFFEE`** (16 b) | **0** ← absent (min 40) |
| 9 | `02 03` | 2 | `TASTE` | 3 |
| 11 | `09 00 00` | 9 | **`MILK`** (16 b) | **0** ← absent (min 60) |
| 14 | `04 00` | 4 | `BLEND` | 0 |
| 16 | `0c 00` | 12 | `INVERSION` | 0 |
| 18 | `1c 00` | 28 | `ACCESSORIO` | 0 |
| 20 | `19 02` | 25 | `VISIBLE` | 2 |
| 22 | `0f 00 00` | 15 | **`HOT_WATER`** (16 b) | **0** ← absent (min 50) |
| 25 | `1b ff` | 27 | `INDEX_LENGTH` | 255 |
| 27 | `37 9b` | — | CRC | |

`6 + 3+2+3+2+2+2+2+3+2 + 2 = 29` ✓, CRC recalculé `379b` conforme.

⚠️ **Les deux trames ne portent pas le même nombre d'entrées** : dix pour les bornes, neuf pour les
valeurs — `PROGRAMABLE` (24) est déclaré mais n'a pas de valeur enregistrée. Ne jamais apparier les
deux trames par position ; toujours par identifiant.

### Le marqueur d'absence est `0` pour une quantité, et `255` seulement pour certaines options

Deux faits, et ils n'ont pas la même portée :

- **Quantité absente = 0**, mesuré des deux côtés : les trois quantités du mug de voyage, et le café
  des emplacements perso vides.
- **Option « sans objet » = 255** : mesuré **uniquement sur les emplacements perso**. Un emplacement
  perso configuré sans café porte `TASTE 255` et `BLEND 255`.

⚠️ **Le mug de voyage contredit le second.** Café absent (0, sous un minimum de 40) et pourtant
`TASTE = 3`, `BLEND = 0`. Donc `255` n'est **pas** une règle du protocole, c'est une règle des
emplacements perso, et l'étendre par analogie écrirait 255 dans un `TASTE` borné 1-5 sur une boisson
qui ne l'a jamais porté. `valeurAbsente` dans `src/lib/ingredients.mjs` prend un argument pour ça,
et `scripts/verif-transfert.mjs` fige les deux comportements.

### Corollaire : « jamais configuré » se lit dans le DÉFAUT, pas dans la valeur

Les trois quantités du mug de voyage ont aussi un **défaut à 0**, hors de leurs bornes. C'est une
caractéristique du modèle : elle ne bouge pas quand on écrit une valeur. C'est sur elle qu'est bâtie
la règle `composable` (`ingredients.mjs`) : *déclarer au moins deux quantités et n'avoir de défaut
utilisable pour aucune* sélectionne, sur ce modèle, **exactement les six emplacements perso et le mug
de voyage**. Bâtie sur la valeur enregistrée, la même règle aurait basculé au premier réglage écrit.

## 5. `0x83` — commander la boisson

C'est la trame que **nous** émettons, et la seule des trois qui agisse sur l'appareil.

```
offset   contenu
  0      0x0D                      en-tête d'envoi
  1      len = taille totale − 1
  2      0x83
  3      0xF0                      flag
  4      beverageId
  5      mode                      1 = START ; 0 = DONTCARE (écriture) ; 2 = arrêt
                                   | 0x80 = « checkValues »
  6..n   paires id + valeur        même règle de largeur que 0xA6
  n+1    (profileId << 2) | action 2 = PREPARE, 1 = SAVE, 6 = PREPARE_INVERSION
  n+2..3 CRC16
```

⚠️ **Le même octet de commande prépare un café et écrase durablement la recette d'un profil.** Ce
qui les sépare est l'octet 5 et les deux bits bas du dernier octet : `mode 1` + `action 2` prépare,
`mode 0` + `action 1` **écrit**. C'est pourquoi `ecam-args.mjs` affine `0x83` par son mode avant de
le nommer dans le journal.

Exemple **calculé** pour un mug de voyage portant les trois ingrédients — café 40 ml, arôme 3, lait
60 ml, accessoire 0, eau 50 ml, inversion 0, mélange 0 — profil 1, préparation :

```
0d 19 83 f0 1a 01 01 00 28 02 03 09 00 3c 1c 00 0f 00 32 0c 00 04 00 06 e3 1a
│  │  │  │  │  │  └──────── paires : 01=40  02=3  09=60  1c=0  0f=50  0c=0  04=0
│  │  │  │  │  └─────────── mode 1 = START
│  │  │  │  └────────────── boisson 26
│  │  │  └───────────────── flag
│  │  └──────────────────── 0x83
│  └─────────────────────── len = 0x19 = 25  →  26 octets
└────────────────────────── envoi
                                              06 = (1 << 2) | 2 → profil 1, PREPARE
                                              e3 1a = CRC
```

⚠️ **Cette trame-là est construite, pas capturée.** Sa forme est cohérente (longueur et CRC
recalculés), mais **elle n'a jamais été envoyée à l'appareil**, et pour une raison de fond : aucune
mesure ne couvre café + lait + eau chaude dans la même tasse. La trame sera syntaxiquement valide et
acceptée ; ce que la machine en fait physiquement n'est pas établi. Ne pas la présenter comme un
relevé.

## Ce qui n'est pas établi

- **Le comportement d'une préparation à trois ingrédients** (ci-dessus). Syntaxe connue, effet non.
- **L'ordre des paires dans `0x83`.** L'exemple suit l'ordre de la recette. L'application ordonne par
  ingrédient (`Q6.g.i()`) ; rien ne dit que la machine soit sensible à l'ordre, et rien ne dit le
  contraire.
- **La table des largeurs au-delà des trois quantités.** Elle vient du backend ; les trois liquides
  ont été établis par le décodage exact, les autres sont supposés 8 bits parce que le parcours tombe
  sur le CRC. Six trames et douze paramètres distincts tombent désormais dessus (§ 2), ce qui est une
  preuve pour ces trames-là et non pour toutes — un paramètre 16 bits jamais rencontré se lirait
  encore sur 8.
- **La signification de `VISIBLE` (25) à 2.** Le paramètre est borné `0/2/2` sur le mug de voyage
  **et sur le thé**, `0/1/1` sur les trois autres boissons du catalogue mesurées, `0/0/1` sur
  l'emplacement perso (§ 2.6). Ce que la valeur 2 autorise de plus reste inconnu.
- **`INDEX_LENGTH` (27) vaut 255** pour un paramètre borné 0-4 : encore un « jamais configuré », mais
  ce paramètre n'est ni une quantité ni une option d'ingrédient, donc la convention n'y a pas été
  vérifiée.
