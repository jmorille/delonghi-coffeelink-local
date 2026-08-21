---
target: src/app/page.tsx
total_score: 18
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-08-20T20-41-53Z
slug: src-app-page-tsx
---
Method: dual-agent (A: design review · B: detector + browser evidence), isolated and parallel.
Deviation: B returned before A, so detector evidence entered the synthesis context first. A never saw B.

# Critique — src/app/page.tsx (accueil, mode Operate)

## Design Health Score — 18/40 (Poor)

| # | Heuristic | Note | Probleme cle |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | msg rendu uniquement dans la PowerCard : confirmation hors ecran depuis la 22e carte |
| 2 | Match System / Real World | 2 | "table constructeur 0132217055", "(d261_1_rec_priority)", "id 200", stopTitle = "Commande 0x83 mode STOPV2" — dans le catalogue |
| 3 | User Control and Freedom | 2 | Aucune annulation ; "Arreter" jamais desactive et devine la boisson (beverageId: target?.id ?? 1) |
| 4 | Consistency and Standards | 2 | Action physique confirmee ici, pas du tout sur /pilotage ; .grid existe et n'est pas utilise ; aucun aria-current |
| 5 | Error Prevention | 2 | Bornage et bannieres 409 exemplaires, mais peut preparer sur le mauvais appareil (P0-1) |
| 6 | Recognition Rather Than Recall | 1 | Noms de profils importes ailleurs, boisson en cours memorisee par l'app, machine jamais nommee |
| 7 | Flexibility and Efficiency | 1 | Ni recherche, ni filtre, ni relance, ni raccourci ; busy global grise les 88 boutons |
| 8 | Aesthetic and Minimalist Design | 1 | id + nom d'usine anglais + compte de parametres + pastilles par carte ; echelle de type 1,7:1 |
| 9 | Error Recovery | 3 | noLanKey / badServerIp exemplaires : cause, consequence, geste de reparation |
| 10 | Help and Documentation | 2 | Aide dans 34 attributs title, invisibles sur les deux appareils tactiles prioritaires |

Aucune heuristique n/a. max_score = 40.

## Verdict de specificite

Le langage est authentique, la composition est generique.

Specifique : le modele d'etat ("Prete il y a 4 h — peut avoir change depuis", "Etat inconnu — aucun monitor recu",
"pas de defaut"). Encode qu'un appareil peut etre muet et qu'un reglage peut n'avoir jamais existe.

Generique : colonne 880px dans 1512, 28 cartes empilees une par ligne alors que .grid existe et sert sur /pilotage,
trois boutons texte repetes 28 fois, input[type=range] natifs de 150px, window.confirm() comme seul rempart.

Hierarchie inversee : l'element le plus sature et le plus large est le bouton destructif "Arreter la preparation"
(toujours actif) ; la commande principale est une pastille de 52x28px qui arrive desactivee.

### Scan deterministe

Le detecteur CLI NE FONCTIONNE PAS. Modules d'analyse absents (htmlparser2, css-select, css-tree, domutils),
repli regex, renvoie [] / exit 0 sur toute entree. Controle positif echoue : un fichier avec les anti-patterns
documentes ressort aussi a zero. 59 regles au registre, aucune declenchable. Un "0 constat" de ce detecteur
ne vaut rien.

Moteur navigateur (fonctionnel, 390 ko injectes) :
- low-contrast button.danger "Arreter la preparation" : 4,1:1 (#fff sur #d1544f). REEL, reproduit a tous les
  viewports et dans les deux themes. Concorde a trois sources : 4,12 calcul manuel, 4,1 moteur, 4,15 revue.
- flat-type-hierarchy : 12,8 / 13,1 / 15 / 16,8 / 22,4px, ratio 1,7:1. Reel, signal faible.
- overused-font roboto 82% : FAUX POSITIF (pile systeme, Roboto en 5e position, aucune webfont).
- line-length x2 : A ECARTER (mesure pendant un etat de viewport incoherent).

Overlays : injection reussie, 3 elements rendus, serveur arrete comme exige. Aucun overlay live cote utilisateur.

## Ce qui fonctionne

1. Le refus d'inventer jusqu'au parametre : isSet/defOf/seedFor distinguent valeur du profil, defaut du modele
   et jamais configure. Consequence physique reelle (cafe = 0 ml au mug de voyage).
2. Les deux reinitialisations distinctes (valeurs du profil vs defauts du modele), rien n'est envoye avant
   Preparer ou Ecrire.
3. La divulgation progressive a trois crans : Details, Reglages avances, Infos techniques. Le seul item de la
   liste de charge cognitive qui passe.

## Problemes prioritaires

### [P0] Le catalogue affiche et la machine commandee peuvent etre deux appareils differents

page.tsx:107 — un fetch NU sur /api/beverages?profile=..., seule occurrence de la page, verifie.
mfetch ajoute la machine courante ; un fetch nu part sur la machine par defaut. Avec deux machines de
modeles differents : catalogue, ordre, bornes et valeurs de A affiches, "Preparer" et "Ecrire" partent sur B.
Regle 4/6 de CLAUDE.md. Divergence silencieuse, sans message d'erreur.
Correctif : mfetch ligne 107 ; nommer l'appareil dans le titre de la PowerCard (aujourd'hui "Machine", et le
selecteur de nav est masque en mono-machine, donc la page ne dit jamais quel appareil elle pilote).
Commande : /impeccable harden

### [P0] Le retour d'action est a 3 000 px du geste, et le verrou est global

msg n'est affiche que dans la PowerCard ; busy est un booleen unique. "Preparer" sur The : les 88 boutons
grisent, la reponse s'ecrit en haut d'une page de ~5 000 px sur telephone. C'est le defaut que PRODUCT.md
designe comme le pire possible pour ce produit.
Correctif : zone de statut par carte (role="status"), busy porte par {beverageId, action}, PowerCard collante.
Commande : /impeccable harden

### [P1] Le protocole est dans le catalogue de messages, pas dans le journal

Contrainte FERME de PRODUCT.md. Verifie dans messages/fr.json :
  beverages.intro "... table constructeur {productCode}."
  beverages.machineOrderNote "Ordre du profil actif, lu sur la machine ({prop})."
  power.stopTitle "Commande 0x83 mode STOPV2"   <- seule glose du bouton destructif
  power.activateTitle "... (trame 0xA9)"
  editor.writeSent "Envoye. Somme du profil avant ecriture : {checksum}."
ETAT.md documente une passe entiere consacree a sortir les trames des confirmations ; cinq messages traites,
ceux-la sont restes.
Correctif : {productCode} et {prop} vers Infos techniques ; stopTitle/activateTitle/writeSent reecrits en
langue d'intention.
Commande : /impeccable clarify

### [P1] Aucune adaptation d'ecran, et debordement horizontal mesure

globals.css n'a AUCUNE media query de mise en page (seule prefers-color-scheme). Tablette 11" identique au
desktop au pixel pres ; ~2 200 px de defilement pour atteindre "The".
CORRECTION A L'AUDIT : a 390px, scrollWidth 692 > clientWidth 390. Barre de defilement horizontale, entree
"Machines" coupee. Cause : .topbar en display:flex SANS flex-wrap, sur 8 liens + selecteur. .row a flex-wrap,
la topbar non.
Correctif : flex-wrap sur la topbar (une ligne) ; .grid pour les cartes au-dela de ~700px ; editeur en
grid-template-columns fluide (une ligne de parametre cumule >=530px de largeurs fixes).
Commande : /impeccable adapt

### [P1] 84 boutons homonymes, aucune annonce d'etat, deux contrastes sous le seuil

Arbre a11y plat : le nom de la boisson est un <strong>, pas un titre — 2 reperes pour 28 boissons. Boutons
"Details"/"Lire"/"Preparer" 28 fois chacun sans nom accessible. Rien n'est annonce apres activation (ni
role="status" ni aria-live). Bordures a 1,38:1 en clair et 1,30:1 en sombre : la PowerCard ressemble a la
carte de boisson n0.
CORRECTION A L'AUDIT : les 88 boutons mesurent 44px exactement, pas 42,5 (bordure oubliee dans le calcul).
Les puces .mini restent a ~24px mais n'ont pas pu etre mesurees (panneau Details ferme).
Correctif : <h3> par carte, role=list/listitem, aria-label "Preparer <nom>", role=status, bordures ~3:1,
44px sur les puces.
Commande : /impeccable harden

## Drapeaux rouges par persona — "preparer un espresso pour le profil actif"

Alex (power user) : l'interrupteur arrive DESACTIVE (disabled={busy || running} ; l'ouverture de la page
declenche un programme de presence) pendant que l'etat affiche "Commande en cours — Presence". Commande
principale morte, raison en jargon. Espresso est la 4e carte, ~600px plus bas, ordre non epinglable. Aucune
relance, aucun raccourci, aucune recherche parmi 28.

Sam (accessibilite) : "Espresso macchiato, id, 11, lait, Espresso Macchiato, ., 8 parametres, bouton Details,
bouton Lire, bouton Preparer" x28. Seule glose du bouton destructif : un title disant "Commande 0x83 mode
STOPV2". Pastilles d'etat a 2,2:1 en clair et 3,4:1 en sombre : "hors session", "etat date", "desaligne" sont
les moins lisibles de l'ecran.

Tiers auto-hebergeur : les deux bannieres amont sont sa meilleure experience du produit. Puis "28 boissons
declarees par le modele ECAM 610.75.MB (PD_SOUL), table constructeur 0132217055", "(d261_1_rec_priority)",
28 cartes "id 200 . Espresso BS 1", bouton rouge le plus visible, 5 boissons "Perso" vides qui proposent
quand meme "Preparer", "Bornes non lues — cliquer Lire" sur chacune des 28 cartes sans lecture groupee.
Rien ne lui dit que le premier geste est d'allumer la machine, et ce bouton est desactive a l'arrivee.

## Observations mineures

- Quatre chaines en dur alors que la cle existe mot pour mot : power.noRenamed (308), power.namesNotRead (311),
  beverages.confirmPrepareWarning (283), editor.confirmWriteWarning (361). Plus aria-label="Profil actif" (562)
  et le litteral "id " dans l'en-tete de carte. Verifie dans fr.json.
- window.confirm() porte tous les moments irreversibles : non stylable, dumpe "Cafe = 40, Arome = 3" en texte
  brut, et retourne false dans une iframe sandboxee (tous les boutons silencieusement inertes).
- stopDispense retombe sur beverageId: 1 et le bouton n'est jamais desactive : on peut "arreter" une boisson
  devinee alors que rien ne coule.
- Le theme clair EST le mode degrade que PRODUCT.md interdit : le sombre est authore, le clair surcharge
  6 tokens sans toucher aux accents.
- Nav.tsx:41 declare current: boolean, jamais utilise. Aucun aria-current sur 8 entrees.
- power.on et power.unknownState semblent morts.
- 0 <img>, 0 <svg> dans toute la page (mesure). Toute l'iconographie tient en deux emoji et un i textuel.
- Le monospace sert de decoration dans le titre des cartes (id 200) alors qu'il signale le technique.

## Questions a se poser

1. Si le geste reel est "je veux mon espresso", pourquoi la page commence-t-elle par 23 boissons, et pourquoi
   l'ordre de la machine est-il un chapitre annote plutot qu'applique en silence ?
2. Que devient la page si l'unite de composition est "une tuile atteignable au pouce" et l'editeur un panneau
   plein ecran ? .grid est deja dans le systeme.
3. Faut-il un mode banc explicite qui rallume ids, proprietes et trames partout, plutot que de servir deux
   publics dans la meme ligne de texte ?
4. Si confirm() disparait, qu'est-ce qui protege du rincage : appui maintenu, fenetre d'annulation de 5 s,
   ou rien au motif que la vraie protection est de nommer l'appareil ?
5. Pourquoi pas une zone unique et permanente "ce que je sais / depuis quand / ce que j'ai demande" plutot
   qu'un message ephemere en haut d'une page de 3 000 px ?
