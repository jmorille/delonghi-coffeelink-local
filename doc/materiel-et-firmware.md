# Matériel et firmware — ECAM 610.75.MB (module Wi-Fi)

> **Note.** Ce document est le fruit d'une analyse menée sur une machine réelle. Les valeurs
> propres à cet exemplaire ont été remplacées par des marqueurs : `IP_MACHINE`,
> `AC000W0XXXXXXXX` (numéro de série), `XX:XX:XX:XX:XX:XX` (adresse MAC), `VLAN_IOT`,
> `IFACE_IOT`, et « Grain A/B/… » pour les noms saisis sur la machine. Les références à
> `secrets.md` désignent un fichier volontairement absent du dépôt : il contenait la clé LAN et
> des données personnelles.

Relevé le 2026-08-19 depuis la fiche appareil du cloud Ayla :

```
GET https://ads-eu.aylanetworks.com/apiv1/dsns/AC000W0XXXXXXXX.json
Authorization: auth_token <token Ayla>
```

46 champs renvoyés. Les valeurs personnelles (SSID, IP publique, géolocalisation, identifiants
de compte, `setup_token`) sont dans **`docs/secrets.md`** et ne sont pas reproduites ici.

---

## 1. Matériel

| Champ | Valeur | Lecture |
|---|---|---|
| `model` | **`AY008ESP1`** | Référence du module Wi-Fi Ayla. `ESP1` = plateforme ESP32 |
| `oem_model` | **`DL-millcore`** | Modèle OEM De'Longhi. « MillCore » = le groupe moulin-broyeur ; c'est ce nom qui apparaît aussi comme chaîne interne dans l'app, et c'est lui qui porte la fonction Bean Adapt |
| `oem` | `229b963f` | Identifiant OEM De'Longhi chez Ayla |
| `mac` | `XX:XX:XX:XX:XX:XX` | OUI **Espressif Inc.** — confirme l'ESP32. Concorde avec le bail DHCP |
| `device_type` | `Wifi` | Pas de variante cellulaire/BLE déclarée |
| `imei` | `null` | Pas de modem cellulaire |
| `unique_hardware_id` | `null` | Non renseigné par cet OEM |
| `product_class` | `null` | Non renseigné |

Le module est donc un **Ayla AY008ESP1 (ESP32)** embarqué dans la machine, relié au MCU hôte
de la cafetière. Le DSN `AC000W0XXXXXXXX` est le numéro de série du module, et il est également
exposé comme `host_symname` sur l'endpoint local `/regtoken.json`.

---

## 2. Firmware

| Champ | Valeur |
|---|---|
| `sw_version` | **`ADA 1.5.3 esp-idf-v3.3.1 2020-04-13 00:25:55 2cfd564`** |
| `module_updated_at` | `2021-03-18T04:58:48Z` |

Décomposition de la version :

| Élément | Valeur | Commentaire |
|---|---|---|
| Agent | **ADA 1.5.3** | *Ayla Device Agent*, la pile logicielle Ayla embarquée |
| SDK | **esp-idf v3.3.1** | SDK Espressif. Branche ancienne — ESP-IDF 3.3.x est en fin de vie depuis 2022 |
| Date de compilation | **2020-04-13 00:25:55** | Le binaire a été compilé il y a plus de 6 ans |
| Commit | `2cfd564` | Révision source du build |

### Constat

Le firmware n'a **jamais été mis à jour depuis l'activation** : `module_updated_at`
(2021-03-18T04:58:48Z) est à 2 secondes de `activated_at` (2021-03-18T04:58:46Z) — c'est
l'horodatage de la première mise en service, pas d'une mise à jour ultérieure.

Le module tourne donc sur un binaire de **avril 2020** avec un SDK ESP-IDF **3.3.1** qui ne
reçoit plus de correctifs de sécurité. `log_enabled: false` et l'absence d'OTA appliquée sur
5 ans suggèrent que De'Longhi ne pousse pas de mise à jour sur ce parc.

À rapprocher de l'absence de chiffrement sur le serveur HTTP local (`enable_ssl: null`) et de
`/regtoken.json` accessible sans authentification : ce module est à garder isolé sur le VLAN IoT.

---

## 3. Capacités déclarées côté plateforme

| Champ | Valeur | Signification |
|---|---|---|
| **`lan_enabled`** | **`true`** | Le LAN mode Ayla est autorisé pour cet appareil |
| **`connection_priority`** | **`["LAN"]`** | Seul type de connexion locale déclaré. Pas de `BLE` — cohérent avec l'absence de Bluetooth sur cette machine |
| **`ans_enabled`** | **`true`** | Canal de notification push activé |
| **`ans_server`** | **`ans-field-eu.aylanetworks.com`** | Serveur ANS. C'est la session UDP permanente observée sur le réseau |
| `has_properties` | `true` | L'appareil expose des propriétés (les ~60 datapoints ECAM) |
| `transport_type` | `http` | Transport cloud en HTTP(S), pas MQTT |
| `enable_ssl` | `null` | Pas de TLS sur le canal local |
| `log_enabled` | `false` | Remontée de logs vers Ayla désactivée |
| `homekit` | `null` | Aucune intégration HomeKit |
| `template_id` | `5651` | Modèle de propriétés Ayla utilisé par cet OEM |

`lan_enabled: true` + `connection_priority: ["LAN"]` sont les deux éléments qui rendent le
pilotage 100 % local possible (voir `analyse-connexion-wifi.md` § 7).

---

## 4. Réseau

| Champ | Valeur |
|---|---|
| `lan_ip` | `IP_MACHINE` |
| `connection_status` | `Online` |
| `connected_at` | `2026-08-19T03:00:49Z` |
| `last_get_at` | `2026-08-19T03:00:49Z` |
| `ip`, `ssid`, `lat`, `lng`, `locality` | voir `secrets.md` |

`connected_at` et `last_get_at` sont identiques : la machine s'est connectée une fois au réveil
et n'a plus rien demandé au cloud depuis (elle est restée en veille). Cet horodatage coïncide au
seconde près avec l'ouverture de la session UDP/ANS observée sur le pare-feu.

---

## 5. Cycle de vie de l'appareil

| Événement | Date |
|---|---|
| `created_at` | 2021-03-18T04:58:46Z |
| `activated_at` | 2021-03-18T04:58:46Z |
| `module_updated_at` | 2021-03-18T04:58:48Z |
| `registered` | `true` |
| `registrable` | `true` |
| `registration_type` | **`AP-Mode`** — appairage par point d'accès Wi-Fi, pas par BLE/BluFi |
| `provisional` | `false` |
| `id` / `key` Ayla | `884583` |
| `dsn` / `product_name` | `AC000W0XXXXXXXX` |

`registration_type: AP-Mode` est la confirmation côté cloud que cette machine n'a **pas** de
Bluetooth : l'appairage s'est fait en mode point d'accès. Le code BluFi (provisioning BLE)
présent dans l'app concerne d'autres modèles de la gamme.

`registrable: true` signifie que l'appareil peut encore être revendiqué par un compte — à
rapprocher du `regtoken` lisible sans authentification sur le LAN.

---

## 6. Champs nuls ou non renseignés

`address`, `dealer`, `facility_uuid`, `homekit`, `imei`, `enable_ssl`, `product_class`,
`unique_hardware_id` — tous `null`. De'Longhi n'exploite pas ces champs de la plateforme Ayla.
