# Analyse de la connexion Wi-Fi — De'Longhi Primadonna Soul ECAM 610.75.MB

> **Note.** Ce document est le fruit d'une analyse menée sur une machine réelle. Les valeurs
> propres à cet exemplaire ont été remplacées par des marqueurs : `IP_MACHINE`,
> `AC000W0XXXXXXXX` (numéro de série), `XX:XX:XX:XX:XX:XX` (adresse MAC), `VLAN_IOT`,
> `IFACE_IOT`, et « Grain A/B/… » pour les noms saisis sur la machine. Les références à
> `secrets.md` désignent un fichier volontairement absent du dépôt : il contenait la clé LAN et
> des données personnelles.

Analyse réalisée le 2026-08-19 à partir de :
- l'APK `it.delonghi` 4.9.6 (versionCode 360) extrait du Pixel 7 Pro, décompilé avec jadx 1.5.6
- l'état réseau réel (OPNsense : baux DHCP, table d'états pf, journal DNS Unbound)
- des sondages HTTP en lecture seule sur la machine
- une capture `adb logcat` de l'app en fonctionnement (2026-08-19 18:02)
- des appels authentifiés à l'API cloud Ayla

> **Secrets** : les identifiants (clé LAN, JWT Gigya, token Ayla, `app_secret`) et les données
> personnelles sont dans **`docs/secrets.md`**, exclu du versionnement par le `.gitignore`.
> Le présent fichier n'en contient aucun.

## 1. Identification de la machine sur le réseau

| Élément | Valeur | Source |
|---|---|---|
| IP | `IP_MACHINE` | bail DHCP réservé |
| Hostname | `cafe` | bail DHCP |
| MAC | `XX:XX:XX:XX:XX:XX` | bail DHCP |
| Fabricant du module | **Espressif Inc.** (ESP32) | OUI de la MAC |
| VLAN | VLAN IoT `VLAN_IOT/24`, iface `IFACE_IOT` | pare-feu du réseau |
| **DSN Ayla** | **`AC000W0XXXXXXXX`** | `/regtoken.json` + logcat `DSN:` |
| Nom machine (app) | `D1705596` | logcat `Wifi Machine found` |
| Jeton d'enregistrement | `9f3340` | `GET /regtoken.json` |
| Enregistré au cloud | oui (`registered: 1`) | `GET /regtoken.json` |
| Mode d'appairage utilisé | `AP-Mode` (donc pas de BLE) | `GET /regtoken.json` |
| Génération | **classique** (pas « Striker ») | logcat : `data_request`, `d302_monitor` |
| LAN mode | **actif** | logcat : `VIP: Lan Mode Changed: true` |

Le `host_symname` renvoyé par `/regtoken.json` **est** le DSN Ayla : le logcat de l'app affiche
`DSN: AC000W0XXXXXXXX` et `connectToMachine address: AC000W0XXXXXXXX`. Il n'y a donc pas
d'identifiant cloud distinct à aller chercher — un simple GET non authentifié sur la machine
suffit à l'obtenir.

Confirmation formelle de l'identité :

```
$ curl http://IP_MACHINE/regtoken.json
{"regtoken":"9f3340","registered":1,"registration_type":"AP-Mode","host_symname":"AC000W0XXXXXXXX"}
```

C'est la signature d'un **module Wi-Fi Ayla Networks**. Le champ `host_symname` est le nom
symbolique du MCU hôte, c'est-à-dire la carte de la machine à café.

L'app contient le code de provisioning **BluFi** (`scanBlufi`, `stopBlufiScan`,
`DEBUG_LOG Blufi: Start scan ble`), mais cette machine **n'a pas de Bluetooth** : elle a été
appairée en mode point d'accès (`registration_type: AP-Mode`). Le code BluFi concerne d'autres
modèles de la gamme.

### 1.1 Fiche complète de l'appareil (cloud Ayla)

`GET https://ads-eu.aylanetworks.com/apiv1/dsns/AC000W0XXXXXXXX.json` :

| Champ | Valeur |
|---|---|
| `id` / `key` | `884583` |
| `dsn` | `AC000W0XXXXXXXX` |
| `model` | **`AY008ESP1`** (module Ayla ESP32) |
| `oem_model` | **`DL-millcore`** (cohérent avec la chaîne `MillCore` de l'app) |
| `oem` | `229b963f` |
| `template_id` | `5651` |
| `sw_version` | **`ADA 1.5.3 esp-idf-v3.3.1 2020-04-13 00:25:55 2cfd564`** |
| `mac` | `e868e7317dcc` (= bail DHCP) |
| `lan_ip` | `IP_MACHINE` |
| `ssid` | *(SSID du réseau — voir `secrets.md`)* |
| `transport_type` | `http` |
| `connection_status` | `Online` |
| `connected_at` / `last_get_at` | `2026-08-19T03:00:49Z` |
| **`lan_enabled`** | **`true`** |
| **`connection_priority`** | **`["LAN"]`** |
| **`ans_enabled`** | **`true`** |
| **`ans_server`** | **`ans-field-eu.aylanetworks.com`** |
| `registered` / `registrable` | `true` / `true` |
| `regtoken` | `9f3340` (= endpoint local) |
| `setup_token` | *(voir `secrets.md`)* |
| `module_updated_at` | `2021-03-18T04:58:48Z` |
| `activated_at` / `created_at` | `2021-03-18T04:58:46Z` |
| `device_type` | `Wifi` |
| `log_enabled` / `enable_ssl` / `homekit` | `false` / `null` / `null` |

Le firmware embarqué est un **Ayla Device Agent 1.5.3 sur ESP-IDF v3.3.1**, compilé le
2020-04-13 et jamais mis à jour depuis mars 2021.

`lan_enabled: true` et `connection_priority: ["LAN"]` sont les deux confirmations décisives :
le LAN mode est autorisé pour cet appareil, et c'est même le **seul** type de connexion locale
déclaré (pas de BLE dans la liste — cohérent avec l'absence de Bluetooth).

---

## 2. Couche transport : ce que la machine fait réellement sur le réseau

### 2.1 Ports ouverts

Scan de 21 ports courants → **un seul port ouvert : TCP/80**.
Fermés/filtrés : 22, 23, 53, 81, 443, 554, 1883, 4433, 5000, 5683, 8080, 8081, 8443,
8883, 8888, 8889, 9000, 10001, 49152, 50000.

Pas de MQTT local, pas de CoAP, pas de TLS entrant.

### 2.2 Connexions sortantes

La table d'états pf ne montre qu'**une seule session sortante**, très longue durée :

| Proto | Destination | Âge | Paquets | Octets |
|---|---|---|---|---|
| UDP | `34.141.46.119:55055` | 12 h 42 | 329 / 329 | 22 381 / 22 372 |

Soit environ 68 octets par paquet, un paquet toutes les ~2 min 20 dans chaque sens : un profil de
**keepalive**, pas de transfert de données.

`34.141.46.119` → `119.46.141.34.bc.googleusercontent.com` = **Google Cloud, europe-west3**.
Or `ads-eu.aylanetworks.com` → `ingress-eufield.aylanetworks.com` → `35.246.183.35`, également
GCP europe-west3. Même région, même fournisseur.

Il s'agit de l'**ANS** (Ayla Notification Service), le canal de notification push descendant qui
permet au cloud de réveiller la machine sans polling. Les datapoints, eux, passent en HTTPS ouvert
à la demande. Trois éléments concordants :

1. La fiche cloud déclare `ans_enabled: true` et `ans_server: ans-field-eu.aylanetworks.com`.
   C'est le **seul** canal push configuré sur l'appareil.
2. **Corrélation temporelle exacte** : la session UDP avait 12 h 42 d'âge à 15:43 UTC, soit un
   démarrage à ~03:01 UTC. La fiche cloud donne `connected_at: 2026-08-19T03:00:49Z`.
   Concordance à quelques secondes.
3. C'est la seule session sortante de l'appareil : il n'y a pas d'autre candidat.

Réserve à garder en tête : `ans-field-eu.aylanetworks.com` résout aujourd'hui vers
`34.89.252.142`, alors que la session observée pointe vers `34.141.46.119` — même région GCP
(europe-west3) mais adresse différente. Vraisemblablement un autre membre du pool, ou une
adresse qui a changé depuis la connexion de l'appareil il y a plus de 12 h. La charge utile
elle-même n'a pas été inspectée : l'API packet capture d'OPNsense a refusé les paramètres
envoyés (`interface`/`fam` rejetés) sur 4 tentatives. Une capture manuelle depuis l'interface web
sur `IFACE_IOT`, filtre `host IP_MACHINE`, lèverait cette dernière réserve.

### 2.3 DNS

Sur une fenêtre de 5 min 41 (17:36:52 → 17:42:33, 1000 requêtes), la machine a émis
**zéro requête DNS**. Elle a résolu son point d'entrée au démarrage (il y a 12 h 42) et garde
l'IP en cache pour toute la session — cohérent avec la session UDP unique du même âge.

En revanche, `supervision.exemple` (Home Assistant, `IP_SUPERVISION`) **interroge `ads-eu.aylanetworks.com`**
(A + AAAA à 17:40:37). Il y a donc déjà, côté Home Assistant, quelque chose qui parle au cloud
Ayla — vraisemblablement une intégration Ayla existante qui interroge le cloud, pas la machine.

---

## 3. Surface locale : le serveur HTTP du port 80

En fonctionnement normal (mode station), le module expose **deux endpoints** :

| Endpoint | Méthode | Résultat |
|---|---|---|
| `/regtoken.json` | GET | **200** — JSON d'identification |
| `/local_reg.json` | **POST / PUT** | **400** sur corps invalide → **handler présent** |
| `/local_reg.json` | GET | 404 |
| tout le reste | toutes | 404 (page HTML générique) |

Le 400 est significatif : un chemin inexistant interrogé avec la même méthode
(`POST /zzz_inexistant.json`) renvoie le 404 HTML générique. `/local_reg.json` est donc un
handler réellement enregistré, accessible uniquement en POST/PUT.

Endpoints Ayla testés et absents (GET et POST) : `/status.json`, `/ident.json`,
`/wifi_status.json`, `/connect_status.json`, `/client_lan_ip.json`, `/lan_ip.json`,
`/module.json`, `/property.json`, `/node_property.json`, `/wifi_profiles.json`,
`/wifi_scan_results.json`, `/ping.json`, `/version.json`, `/info.json`, `/dsn.json`,
`/config.json`, `/lan_ota.json`, `/ota_status.json`. Ils n'existent qu'en **mode AP** (pendant
l'appairage, quand la machine diffuse son propre SSID).

### Conséquence majeure : le LAN mode Ayla est disponible

`/local_reg.json` est **le point d'entrée du LAN mode Ayla**. Les endpoints `/local_lan/*`
ne sont pas hébergés par la machine mais **par le client** : c'est l'inversion de rôles
caractéristique du LAN mode Ayla (cf. section 7.1).

**Un pilotage local est donc réalisable.** Voir section 7 pour le protocole complet.

---

## 4. Protocole applicatif : Ayla + trames ECAM encapsulées

Classe pivot : `it/delonghi/service/DeLonghiWifiConnectService.java` (3787 lignes). Elle importe
à la fois `com.aylanetworks.aylasdk.{AylaDevice,AylaProperty,AylaDatum,AylaRegistration}` **et**
`it.delonghi.ecam.model.{MonitorData,MonitorDataV2}` + `EcamServiceV2` + `android.util.Base64`.

Autrement dit : **le Wi-Fi ne définit pas son propre protocole métier**. Il transporte exactement
les mêmes trames binaires ECAM que le Bluetooth, encodées en base64 dans des propriétés Ayla.

### 4.1 Deux générations de machines

Un booléen interne (`f27338F`, « Striker ») sélectionne le jeu de propriétés :

| | Machines classiques | Machines « Striker » |
|---|---|---|
| Envoi de commande | `data_request` | `app_data_request` |
| Lecture d'état | `d302_monitor` | `d302_monitor_machine` |
| Présence app | `device_connected` | `app_device_connected` |

### 4.2 Propriétés Ayla identifiées

**État / commande**
- `d302_monitor`, `d302_monitor_machine` — état machine (base64 → `MonitorData`/`MonitorDataV2`)
- `data_request`, `app_data_request` — envoi de trame ECAM
- `device_connected`, `app_device_connected` — heartbeat de présence de l'app (timestamp Unix / 1000)
- `app_id` — identifiant de session de l'app, validé/régénéré (`refreshAppID`, `strikerAppIdRequest`)

**Identité et réglages**
- `d270_serialnumber`
- `d281_mach_sett_temperature` / `d281_mchn_sett_temp`
- `d285_mach_sett_radio_conf` / `d285_mchn_sett_radio_conf`
- `d286_mach_sett_profile`

**Recettes (une propriété par boisson)**
- Boissons d'usine : `d001_rec_espresso`, `d002_rec_regular`, `d003_rec_long_coffee`,
  `d004_rec_2x_espresso`, `d005_rec_doppio`, `d006_rec_americano`, `d007_rec_cappuccino`,
  `d008_rec_latte_macchiato`, `d009_rec_caffelatte`, `d010_rec_flat_white`,
  `d011_rec_espr_macchiato`, `d012_rec_hot_milk`, `d013_rec_capp_doppio`,
  `d014_rec_capp_reverse`, `d015_rec_hot_water`, `d016_rec_tea`, `d017_rec_coffee_pot`,
  `d018_rec_cortado`, `d019_rec_long_black`, `d020_rec_mug_to_go`, `d021_rec_brew_over_ice`
- Recettes perso : `d028_rec_custom_1` … `d033_rec_custom_6`, `d240_rec_custom_1` … `d245_rec_custom_6`,
  `d200_1_cstm_recipe_01` … `d205_1_cstm_recipe_06`
- Bean System : `d022_beansystem_1`, `d251_beansystem_1`, `d260_beansystem_par`, `d260_beansystem_sync_par`
- Profils : `d034_profiles_1_3`, `d035_profiles_4_5`, `d051_profile_name1_3`, `d052_profile_name4`
- Noms perso : `d036_recipe_custom_name_1_3`, `d037_recipe_custom_name_4_5`, `d053_custom_name_13`, `d054_custom_name_46`
- Favoris : `d265_favorite_priority_1` … `d268_favorite_priority_4`

Des gabarits dynamiques existent aussi, résolus à l'exécution selon le modèle :
`d%s_rec_%s_<boisson>`, `d%s_%s_rec_<boisson>`, `d%s_recipe_priority_%s`.

### 4.3 Format exact du datapoint envoyé

Méthode `Y1(byte[] ecamPacket)` :

```
payload = trameECAM  ||  uint32_be(unixTimestamp)  [||  appId]     // appId seulement en Striker
datapoint = Base64(payload)
→ écrit dans la propriété  app_data_request  (Striker)  ou  data_request  (classique)
```

Le timestamp est `System.currentTimeMillis() / 1000` sérialisé sur 4 octets big-endian.
Un `Thread.sleep(500)` précède chaque envoi — la machine ne supporte pas les commandes rapprochées.

**Vérifié dans les deux sens.** La valeur réelle de `d302_monitor` relevée en logcat
(`0BJ1DwRAAgkAAAJkAAAAAAB1sWqFHF4=`, 23 octets) se découpe exactement ainsi :

```
octets 0..18  D0 12 75 0F 04 40 02 09 00 00 02 64 00 00 00 00 00 75 B1
              → trame ECAM de 19 octets (= octet[1] + 1), CRC 0x75B1 recalculé OK
octets 19..22 6A 85 1C 5E
              → uint32_be = 1787108446 = 2026-08-19 05:00:46
```

**Attention à ne pas généraliser** : cette queue de 4 octets n'est présente que sur
`data_request` / `d302_monitor`. Les propriétés de recette sont de l'ECAM pur, sans timestamp
(`d001_rec_espresso` : 38 octets, `octet[1] + 1 = 38`, queue de 0 octet). Le découpage doit donc
se faire sur `octet[1] + 1` et non sur la taille du buffer.

### 4.4 Format de la trame ECAM

```
octet 0     : en-tête   0x0D = requête (app → machine)
                        0xD0 = réponse (machine → app)
octet 1     : longueur = (taille totale de la trame) − 1
octet 2     : commande  (0x84 = marche/arrêt, 0x90 = écriture paramètre,
                         0xB0 = recette, 0x75 = monitor)
octet 3     : 0x0F dans le sens requête, 0xF0 dans le sens réponse
octets 4..n : charge utile
2 derniers  : CRC16
```

L'en-tête et l'octet de flag sont des **nibbles inversés selon le sens** — c'est ce qui
distingue requête et réponse. Requêtes relevées dans `p097j6/d.java` :

```
allumage   : 0D 07 84 0F 01 01 <crc16>
extinction : 0D 07 84 0F 02 01 <crc16>
```

Réponses réelles observées (logcat, 2026-08-19) :

```
d001_rec_espresso : D0 25 B0 F0 01 08 00 00 01 18 00 01 01 01 00 14 00 28 00 B4
                    1B 00 01 04 02 00 04 05 04 00 00 00 19 00 01 01 B9 96
d302_monitor      : D0 12 75 0F 04 40 02 09 00 00 02 64 00 00 00 00 00 75 B1
```

> Le `d302_monitor` porte un flag `0x0F` alors que c'est une réponse : le champ n'est donc pas
> systématiquement inversé sur toutes les commandes. À ne pas utiliser comme discriminant fiable ;
> l'en-tête (octet 0), lui, l'est.

CRC16 (fonction `I()`, `p097j6/d.java:573`) — CRC-CCITT orienté octet, **valeur initiale
7439 = 0x1D0F**, calculé sur tous les octets sauf les 2 derniers.

**Validé sur 5 trames réelles** extraites du logcat (`d001_rec_espresso`, `d002_rec_regular`,
`d005_rec_doppio`, `d007_rec_cappuccino`, `d302_monitor`) : CRC recalculé identique au CRC
transmis dans les 5 cas.

```java
int crc = 0x1D0F;
for (int i = 0; i < buf.length - 2; i++) {
    int a = (((crc << 8) | (crc >>> 8)) & 0xFFFF) ^ (buf[i] & 0xFF);
    int b = a ^ ((a & 0xFF) >> 4);
    int c = b ^ ((b << 12) & 0xFFFF);
    crc   = c ^ (((c & 0xFF) << 5) & 0xFFFF);
}
crc &= 0xFFFF;
```

### 4.5 Lecture de l'état

`d302_monitor` / `d302_monitor_machine` est lu de deux façons :
- **push** : abonnement aux `PropertyChange` du SDK Ayla (`DeLonghiWifiConnectService.java:3161`)
- **poll** : `fetchProperties(["d302_monitor_machine"])` toutes les 60 s (log `"Ayla monitor 60 sec"`),
  et `fetchPropertiesCloud(["app_id"])` pour la validation de session

`MonitorDataV2` décode le tableau d'octets : état machine à l'offset 4, compteurs sur les offsets
4/5/12/13 et 7/8, offset 11, et un champ de bits d'alarmes (`isAlarmActive`, avec par exemple
`WATER TANK ALARM`).

---

## 5. Backends tiers de l'app (hors chemin machine)

Le pilotage de la machine passe uniquement par Ayla. L'app contacte par ailleurs :

| Hôte | Rôle |
|---|---|
| `*-field-eu.aylanetworks.com` (`ads`, `user`, `icc`, `mdss`, `message`, `mstream`, `log`, `metric`, `rulesservice`, `gss`) | plateforme IoT — **chemin de contrôle** |
| `delonghibe.reply.it/api/` | backend De'Longhi (recettes, TOC, logs, alarmes, `saveMachineData.sr`) |
| `coffeelink-api.azurewebsites.net/api/` | API Coffee Link |
| `eu-graphql.contentstack.com` | CMS de contenu |
| `coffeerecipes.delonghi.com`, `dlkb.kform.it` | recettes, base de connaissances |
| `delonghibe.s3-eu-west-1.amazonaws.com` | médias |
| Firebase / Crashlytics / Facebook / app-measurement | analytics |

---

## 6. Points de sécurité

1. **`/regtoken.json` est accessible sans aucune authentification** sur le LAN. Il expose le
   numéro de série de la machine et le jeton d'enregistrement Ayla. Dans le modèle Ayla, le
   couple DSN + regtoken permet de revendiquer un appareil sur un compte. Ici la machine est
   déjà enregistrée (`registered: 1`), ce qui limite la portée, et elle est isolée sur le VLAN
   IoT — c'est le bon réflexe et il faut le garder.
2. **Aucun chiffrement ni authentification sur le port 80.** Rien de sensible n'y transite en
   dehors du point 1, mais l'endpoint n'a aucune raison d'être joignable depuis autre chose que
   l'app pendant l'appairage.
3. La session UDP sortante permanente vers GCP est le canal de réveil : la bloquer coupe la
   réactivité du contrôle cloud (l'app deviendrait lente ou non fonctionnelle).

---

## 7. Pilotage local via le Wi-Fi : le LAN mode Ayla

Cette machine n'a **pas de Bluetooth** (cohérent avec `registration_type: AP-Mode` : l'appairage
s'est fait par point d'accès Wi-Fi, pas par BluFi/BLE). Le Wi-Fi est donc la seule voie possible.
Le LAN mode Ayla la rend exploitable.

### 7.1 Architecture : les rôles sont inversés

Contre-intuitif mais central : en LAN mode, **c'est le client qui héberge le serveur HTTP**.
La machine devient cliente et vient chercher ses commandes.

```
1. [cloud, une fois]  GET apiv1/dsns/<DSN>/connection_config.json
                      → { localConnectionConfig: { localKey, localKeyId,
                            keepAlive, lifetime, connectionPriority, autoSync } }

2. [local]  on démarre notre propre serveur HTTP  (ex. 0.0.0.0:8888)

3. [local]  POST http://IP_MACHINE/local_reg.json
            { "local_reg": { "ip": "<notre IP>", "port": 8888,
                             "uri": "/local_lan", "notify": 0 } }

4. [local]  la MACHINE appelle NOTRE serveur :
            POST /local_lan/key_exchange.json
            { "key_exchange": { "ver":1, "proto":1, "key_id":<localKeyId>,
                                "random_1":"...", "time_1":N, "sec":"..." } }
            → on répond { "random_2":"...", "time_2":N }

5. [local]  la machine poll NOTRE  GET /local_lan/commands.json
            → on y dépose les écritures de datapoint (app_data_request)

6. [local]  la machine POST vers NOTRE /local_lan/property/datapoint.json
            → on reçoit d302_monitor_machine en quasi temps réel (plus de poll 60 s)
```

Endpoints à implémenter côté client (tous vus dans le SDK, `localcontrol/lan/`) :
`/local_lan/key_exchange.json`, `/local_lan/commands.json`,
`/local_lan/property/datapoint.json`, `/local_lan/property/datapoint/ack.json`,
`/local_lan/connect_status`. Les handlers correspondants sont `KeyExchangeHandler`,
`CommandHandler`, `PropertyUpdateHandler`, `AckHandler`, `ConnectionStatusHandler`.

### 7.2 Dérivation des clés de session

`AylaEncryption.generateSessionKeys()`. Tout est en HMAC-SHA256 sur des chaînes ASCII :

```
K  = localKey (octets UTF-8 de la chaîne renvoyée par le cloud)
R1 = random_1  (généré par la machine, ASCII)
R2 = random_2  (généré par nous, ASCII)
T1 = time_1 en décimal ASCII
T2 = time_2 en décimal ASCII

derive(K, seed) = HMAC-SHA256(K, HMAC-SHA256(K, seed) || seed)

# sens application → machine :  seed = R1 || R2 || T1 || T2 || tag
appSignKey    = derive(K, R1||R2||T1||T2||'0')      # tag 0x30
appCryptoKey  = derive(K, R1||R2||T1||T2||'1')      # tag 0x31
appIvSeed     = derive(K, R1||R2||T1||T2||'2')[0:16]

# sens machine → application :  ordre des opérandes inversé
devSignKey    = derive(K, R2||R1||T2||T1||'0')
devCryptoKey  = derive(K, R2||R1||T2||T1||'1')
devIvSeed     = derive(K, R2||R1||T2||T1||'2')[0:16]
```

### 7.3 Format d'enveloppe des messages

`AylaEncryption.encryptEncapsulateSign()` :

```
inner  = {"seq_no":<N>,"data":<json>}          # N incrémenté à chaque message
padded = inner complété à un multiple de 16 octets (sur len+1)
sortie = {"enc":"<base64(AES-256-CBC(appCryptoKey, appIvSeed, padded))>",
          "sign":"<base64(HMAC-SHA256(appSignKey, inner))>"}
```

**Piège d'implémentation** : le SDK utilise `AES/CBC/NoPadding` avec `cipher.update()` sans
réinitialiser le chiffrement entre messages. C'est donc un flux CBC continu sur toute la session,
pas un chiffrement indépendant par message — l'état du chiffreur doit être conservé, et une
désynchronisation casse la session (il faut alors refaire un key exchange).

### 7.4 Charge utile

Une fois le canal local établi, la charge utile est **identique** au cloud (section 4) :
on écrit du base64 dans `app_data_request` / `data_request` et on lit
`d302_monitor_machine` / `d302_monitor`. Les constructeurs de trames de `p097j6/d.java` et
`p097j6/b.java` et le CRC de la section 4.4 sont réutilisables tels quels.

### 7.5 Le seul point non local : le bootstrap de la clé — **récupérée**

La clé LAN a été obtenue. Attention, ce n'est **pas** `connection_config.json` (404 sur ce
compte : c'est l'endpoint du SDK récent) mais l'endpoint **legacy `lan.json`** :

```
GET https://ads-eu.aylanetworks.com/apiv1/dsns/AC000W0XXXXXXXX/lan.json
Authorization: auth_token <token Ayla>

{
  "lanip": {
    "lanip_key_id": 65269,
    "lanip_key": "<clé — voir secrets.md>",
    "keep_alive": 30,
    "auto_sync": 1,
    "status": "enable"
  }
}
```

| Champ | Valeur | Usage |
|---|---|---|
| `lanip_key` | *(voir `secrets.md`)* | le `K` de la dérivation (§ 7.2) |
| `lanip_key_id` | `65269` | à placer dans `key_id` du key exchange |
| `keep_alive` | `30` (s) | `AylaLanModule` relance à `keep_alive × 1000 / 3` = **10 s** |
| `auto_sync` | `1` | la machine pousse ses changements spontanément |
| `status` | `enable` | LAN mode autorisé côté cloud |

> **Point d'implémentation** : `lanip_key` est une chaîne base64, mais la dérivation
> (`AylaEncryption.generateSessionKeys`) prend `localKey.getBytes(UTF_8)` — donc **les octets
> ASCII de la chaîne base64 telle quelle**, `==` compris. Il ne faut **pas** la décoder en base64
> avant de la passer en clé HMAC. C'est l'erreur la plus probable à ce stade.

Contrairement à `AylaLocalConnectionConfig`, la réponse `lanip` **ne contient pas de `lifetime`**.
La clé n'a donc pas de date d'expiration annoncée ; elle change en pratique lors d'un
réappairage ou d'une rotation côté cloud. Prévoir malgré tout un rafraîchissement en cas d'échec
de key exchange.

Donc, précisément : **runtime 100 % local, bootstrap cloud ponctuel**. La clé est maintenant en
cache, plus aucun échange avec Internet n'est nécessaire pour lire l'état ou envoyer une commande.
Un « zéro cloud » absolu supposerait d'extraire la clé du firmware — inutile ici puisqu'elle est
obtenue et stable.

### 7.6 Alternative de repli : émuler le cloud Ayla

Rediriger `ads-eu.aylanetworks.com` vers un faux cloud local (via Unbound). Beaucoup plus
lourd : il faudrait reproduire l'API Ayla et gérer la validation TLS côté module ESP32.
À ne considérer que si le LAN mode échoue.

> Note de topologie : la machine est sur le VLAN IoT (`VLAN_IOT`), le contrôleur sur un VLAN
> d'administration (`VLAN_ADMIN`). Le LAN mode demande un flux **bidirectionnel** : VLAN_ADMIN → VLAN_IOT:80 pour le
> `local_reg`, et VLAN_IOT → VLAN_ADMIN sur notre port pour les rappels de la machine. Deux règles à créer.

---

## 7bis. Test réel du 2026-08-19 : le cloud ne délivre pas à un appareil LAN-priority

Test de bout en bout : envoi d'une commande **allumage** (`0D 07 84 0F 01 01 <crc>`, CRC 0x0041)
via un datapoint cloud sur la propriété `data_request`.

**Résultat : la machine ne s'est pas allumée** (état monitor inchangé, `0x04`). Analyse :

| Observation | Constat |
|---|---|
| POST datapoint | **201 Created** — le cloud accepte |
| CRC de la trame | recalculé = transmis (0x0041) — **encodage correct** |
| Réaction machine | juste après le POST : requête DNS + connexion HTTPS sortante → **l'ANS réveille bien la machine** |
| `last_get_at` | **figé à 03:00:49Z** — la machine ne fait aucun GET HTTP cloud |
| Mon datapoint (allumage) | `echo=False` — **jamais consommé** |
| Datapoint antérieur de l'app (`0D 06 A9 F0 01`, SEND_PROFILE, envoyé sur le LAN) | `echo=True` — **consommé** |

**Conclusion.** Avec `connection_priority: ["LAN"]`, la machine ne va pas chercher ses commandes
dans le cloud : elle attend qu'un **client LAN** les lui pousse en local. L'app y parvient parce
qu'elle est sur le même réseau et ouvre une session LAN mode ; le cloud ne fait que refléter la
commande (`auto_sync=1`), d'où le `echo=True`.

Le chemin **cloud pur accepte mais ne délivre pas**. Le pilotage de cette machine passe donc
**obligatoirement par le serveur LAN mode** (§ 7). Le test valide au passage deux briques :
l'encodage ECAM est correct, et l'ANS réveille la machine à la demande — le déclenchement
fonctionnera une fois le `local_reg` établi.

---

## 8. Points ouverts

### Résolus par la capture logcat du 2026-08-19 18:02

| Point | Résultat |
|---|---|
| DSN Ayla | `AC000W0XXXXXXXX` — identique au `host_symname`, obtenable sans authentification |
| Génération | **classique** → couple `data_request` / `d302_monitor`, **sans** `appId` en queue |
| LAN mode utilisable | **oui** — `VIP: Lan Mode Changed: true` observé en direct, et `sameLan: true` |
| Validité du CRC documenté | confirmée sur 5 trames réelles |
| Structure trame + queue timestamp | confirmée par décodage de `d302_monitor` |

Aucune erreur `Key exchange failure`, `AylaDevice OFFLINE` ni `Device is not in LAN mode` dans la
capture : la session LAN s'est établie proprement entre le téléphone et la machine.

### Résolus par les appels cloud

| Point | Résultat |
|---|---|
| `lanip_key` / `lanip_key_id` | **obtenus** — § 7.5 (via `lan.json`, pas `connection_config.json`) |
| `connection_priority` contient `LAN` | **oui**, et c'est le seul type déclaré |
| `lan_enabled` | `true` |
| Nature de la session UDP/55055 | **ANS Ayla** — `ans_enabled: true` + corrélation `connected_at` |

**Plus aucun bloquant pour implémenter le pilotage local.**

### Restant

- **Sémantique complète du monitor** — décodage partiel seulement. Valeur relevée :
  `offset4 = 0x04`, compteur `offset5,6 = 576`, `offset11 = 0x64` (100), octets d'alarme
  `00001001 00000000 00000000 00000010`. Machine en veille au moment de la capture
  (dernier monitor : 05:00:46 le matin même). Il faut capturer pendant une préparation pour
  cartographier les états.
- **Charge utile de la session UDP/55055** — non inspectée (§ 2.2). Sans impact sur le pilotage
  local.

---

## 9. Identifiants et secrets

Déplacés dans **`docs/secrets.md`** (listé dans le `.gitignore`) : clé LAN de la machine,
JWT Gigya, token Ayla, `app_id`/`app_secret` de l'application, identifiants machine et données
personnelles restituées par le cloud.

Ce fichier-ci ne contient donc plus de secret et peut être versionné.
