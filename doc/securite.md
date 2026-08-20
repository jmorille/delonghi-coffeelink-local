# Analyse de sécurité — module Wi-Fi ECAM 610.75.MB

> **Note.** Ce document est le fruit d'une analyse menée sur une machine réelle. Les valeurs
> propres à cet exemplaire ont été remplacées par des marqueurs : `IP_MACHINE`,
> `AC000W0XXXXXXXX` (numéro de série), `XX:XX:XX:XX:XX:XX` (adresse MAC), `VLAN_IOT`,
> `IFACE_IOT`, et « Grain A/B/… » pour les noms saisis sur la machine. Les références à
> `secrets.md` désignent un fichier volontairement absent du dépôt : il contenait la clé LAN et
> des données personnelles.

Analyse du 2026-08-19. Contexte : le firmware du module Wi-Fi n'a pas été mis à jour depuis
mars 2021 (voir `materiel-et-firmware.md`), d'où une inquiétude légitime sur sa sécurité.

**En résumé** : le risque est **modéré et surtout théorique** dans la configuration actuelle,
grâce à l'isolement VLAN déjà en place. La surface d'attaque locale est minuscule. Le principal
vecteur restant — la connexion cloud sortante — peut être **entièrement neutralisé** en coupant
l'accès Internet de la machine, ce que le pilotage local (LAN mode) rend désormais possible.

---

## 1. Ce que « 6 ans sans mise à jour » implique

| Élément | Valeur | Risque |
|---|---|---|
| Agent Ayla | ADA 1.5.3 | Pile applicative ancienne |
| SDK | **ESP-IDF v3.3.1** | Branche en fin de vie depuis 2022 ; mbedTLS embarqué ancien, CVE connues de l'époque |
| Build | 2020-04-13 | Binaire vieux de 6 ans |
| Dernière MàJ | 2021-03-18 (= activation) | **Jamais mis à jour** |

Le point sensible d'un firmware non patché de cette génération est sa **pile TLS** (mbedTLS via
ESP-IDF 3.3.1), utilisée pour la connexion sortante au cloud. Mais un firmware vulnérable n'est un
risque que s'il est **atteignable**. C'est là que la configuration réseau change tout.

---

## 2. Surface d'attaque réelle

### 2.1 En entrée — attaquer la machine

| Constat | Conséquence |
|---|---|
| **Un seul port ouvert : TCP/80** | Surface minimale |
| Deux handlers seulement (`/regtoken.json`, `/local_reg.json`) | Pas de gros service web exposé |
| Aucun port forward, machine derrière NAT | **Inatteignable depuis Internet** |
| Isolée sur VLAN IoT le VLAN IoT | Séparée du reste du réseau |
| `enable_ssl: null` | Le port 80 est en clair — mais rien de sensible n'y transite hors `/regtoken.json` |
| `/regtoken.json` sans authentification | Fuite DSN + regtoken à quiconque est déjà sur le VLAN IoT |

Pour exploiter une faille locale, il faut **déjà être présent sur le VLAN le VLAN IoT**. À ce stade,
l'attaquant a des cibles plus intéressantes qu'une cafetière.

### 2.2 En sortie — piéger la machine

- La machine ouvre **une seule** connexion sortante : l'ANS Ayla (UDP vers GCP).
- C'est le **seul vecteur d'attaque à distance** réaliste : un attaquant *en position sur le
  chemin* (MITM, détournement DNS) pourrait tenter d'exploiter la vieille pile TLS, ou de pousser
  une **OTA malveillante** — d'autant que l'OTA LAN se fait en `http://` non chiffré
  (`AylaLanOTADevice`, endpoint `/lanota.json`).
- Prérequis d'un tel scénario : compromettre le DNS/routage de la machine, ou le cloud Ayla
  lui-même. Non trivial.

---

## 3. Verdict

Ce **n'est pas** une passoire exposée sur Internet. La conception (un port, deux handlers, pas
d'entrée depuis le WAN) et l'isolement VLAN limitent fortement le risque concret.

Le point à retenir : la machine reste un **appareil de confiance faible**. Si son firmware était
compromis (via le vecteur sortant), elle deviendrait un **point d'appui sur le VLAN IoT** — d'où
l'intérêt de la traiter comme un objet potentiellement hostile et de la cloisonner.

---

## 4. Recommandations, par ordre d'impact

### 4.1 Priorité 1 — Couper l'accès Internet de la machine (le levier décisif)

Le pilotage local via LAN mode étant établi (voir `analyse-connexion-wifi.md` § 7), la machine
n'a plus besoin du cloud pour être commandée. **Bloquer son egress Internet neutralise d'un coup
le seul vecteur d'attaque à distance** (MITM sur TLS + OTA malveillante), et supprime au passage
la dépendance au cloud De'Longhi.

Règles OPNsense (source = `IP_MACHINE`) :

| # | Règle | But |
|---|---|---|
| 1 | **Block** `IP_MACHINE` → `wan` (tout) | Tue le vecteur MITM/OTA distant |
| 2 | **Block** `IP_MACHINE` → `RFC1918` (autres VLAN) | Empêche le pivot en cas de compromission |
| 3 | **Pass** `<contrôleur local>` → `IP_MACHINE:80` | Seul le pilote LAN mode y accède |
| 4 | **Block** reste de le VLAN IoT → `IP_MACHINE` | Isole des autres objets IoT |

Compromis : l'app mobile hors réseau et les notifications push cessent de fonctionner. En local
(domicile ou VPN), tout est conservé.

> **Ordre des opérations** : mettre en place le serveur LAN mode **avant** de couper l'egress,
> sinon plus aucun contrôle. Valider aussi que la machine tolère la perte prolongée du cloud
> (`keep_alive` de 30 s côté ANS).

### 4.2 Priorité 2 — Si on garde le cloud, restreindre l'egress

Plutôt que couper, n'autoriser la sortie que vers les hôtes Ayla EU
(`*-field-eu.aylanetworks.com`, `ans-field-eu.aylanetworks.com`) via un alias de destination.
Réduit la fenêtre de MITM sans casser l'app.

### 4.3 Priorité 3 — Maintien de l'isolement (déjà en place)

- Garder la machine sur le VLAN IoT le VLAN IoT. **Ne jamais** la basculer sur un VLAN de confiance.
- Restreindre qui, sur les autres VLAN, peut atteindre `IP_MACHINE:80` (idéalement : seulement
  le contrôleur Home Assistant / le pilote LAN mode).

### 4.4 Priorité 4 — Surveillance

- Alerter sur toute requête DNS de la machine vers un domaine **non-Ayla** (signe de compromission
  ou de détournement).
- Alerter sur toute connexion sortante de la machine autre que l'ANS habituel.

---

## 5. Ce qui ne peut pas être corrigé

- **Impossible de patcher le firmware soi-même** : aucune image OTA n'est disponible (voir
  `materiel-et-firmware.md` § 7 — l'endpoint OTA existe mais ne sert rien, faute de campagne
  De'Longhi). Le seul moyen d'obtenir/flasher un firmware serait un accès matériel au flash ESP32.
- **`/regtoken.json` restera ouvert** sans authentification sur le LAN tant que la machine tourne.
  La seule parade est le cloisonnement réseau (section 4.3).

La stratégie réaliste n'est donc pas de sécuriser le firmware, mais d'**enfermer la machine** :
egress coupé + VLAN isolé + accès restreint au seul contrôleur local.
