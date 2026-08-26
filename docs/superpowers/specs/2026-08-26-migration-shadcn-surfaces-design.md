# Migration des surfaces vers shadcn/ui

**Date** : 2026-08-26 · **Branche** : `feature/shadcn-surfaces` · **Statut** : approuvé, en cours

## Le problème

La fondation shadcn est en place depuis `d84f644` — Tailwind 4, `components.json`, `cn()`, et un
pont de tokens qui remappe tout le vocabulaire shadcn sur les rôles du boîtier. Mais **aucun
composant n'est monté**, et l'adoption réelle est de 3 fichiers sur 24 : `Nav.tsx` (7 utilitaires),
`layout.tsx` (2), `ThemeToggle.tsx` (1). Les 20 surfaces restantes tournent sur 1 845 lignes de
`surfaces.css` et 816 de `globals.css` écrites à la main.

La décision de portée était explicitement laissée ouverte (`PRODUCT.md` § Stack : « nouvelles
surfaces seulement, ou reprise des 9 surfaces existantes. À trancher avant la première surface
shadcn »). **Elle est tranchée ici : reprise intégrale, composants compris.**

## Portée mesurée

| | |
|---|---|
| Surfaces réelles | **20** (3 des 23 fichiers sont des redirections de 7 lignes : `/boissons`, `/bean-adapt`, `/cle-lan`) |
| `className` à reprendre | **854** |
| CSS écrit à la main | `surfaces.css` 1 845 lignes + `globals.css` 816 |
| Éléments natifs à remplacer | 7 `<dialog>`, 6 `<select>`, 7 `<input type="range">`, 4 `<table>` |

## La décision qui coûte, et pourquoi elle est prise quand même

Neuf primitives shadcn ont déjà été installées par la CLI puis **retirées**, chacune avec une
raison mesurée (`globals.css:622`) :

- le `<select>` natif ouvre le sélecteur du système **sous le pouce** ;
- le `<dialog>` natif donne le piège de focus, Échap et l'inertie du fond **sans une ligne** ;
- l'`<input type="range">` natif porte l'échelle imprimée par `--crans`.

Cette migration **renverse ces trois décisions**. C'est un choix explicite du propriétaire du
produit, pas un oubli. Deux conséquences sont donc écrites ici plutôt que découvertes plus tard :

1. **Ce qui était gratuit devient à prouver.** Le piège de focus, Échap, l'inertie du fond et
   l'échelle `--crans` ne sont plus des propriétés de la plateforme mais du code. Ils sont donc
   couverts par un test, et ce test est écrit **avant** la migration (voir § Preuve).
2. **Une régression assumée** : sur téléphone, Radix `Select` ouvre une liste dans la page au lieu
   de la molette du système. Conserver `<select>` sous `pointer: coarse` donnerait **deux**
   implémentations du même choix — le défaut que ce dépôt a déjà payé plusieurs fois (l'éditeur de
   recette, la carte de boisson). Le composant est pris partout, et la régression est écrite dans
   `globals.css` et `PRODUCT.md`.

## Architecture

### Le socle

Paquets amenés par la CLI : `class-variance-authority`, `lucide-react`, `tw-animate-css`, et un
`@radix-ui/react-*` par primitive.

**Quinze composants**, choisis sur l'inventaire réel des surfaces et non sur le catalogue :

`button` · `dialog` · `select` · `slider` · `input` · `label` · `checkbox` · `radio-group` ·
`table` · `card` · `badge` · `alert` · `progress` · `tooltip` · `sheet`

Ils arrivent déjà habillés par le pont de tokens existant. **Les deux arbitrages du pont tiennent
et ne sont pas rediscutés** : `--primary` reste la touche neutre et non l'ambre (l'ambre veut dire
« choisi » ; la peindre sur tout bouton principal ruinerait la loi des trois couleurs dès le
premier `<Button>`), et `--radius` vaut 2 px, la valeur du boîtier.

`Touche` (`src/ui/facade.tsx`) **disparaît**, absorbée dans les variantes CVA du `button` shadcn :
`neutre` / `marche` / `arret` / `choisi`. C'est le dernier composant monté de la façade ; le
fichier n'a plus d'objet après.

### Les trois remplacements à risque

| Remplacé | Ce que le natif donnait | Ce qui le rend |
|---|---|---|
| `confirm.tsx` (4) + `Nav.tsx` (3) — 7 `<dialog>` | focus piégé, Échap, inertie du fond | Radix `Dialog` en `modal`, **prouvé** |
| `Nav` (2), `/` (1), `beans` (2), `profils` (1) — 6 `<select>` | le sélecteur système sous le pouce | Radix `Select`, cible tactile pleine largeur |
| `RecipeEditor` (4), `ReglagesGrains` (3) — 7 `range` | l'échelle imprimée par `--crans` | `--crans` migre sur le `SliderTrack` de Radix |

`confirm.tsx` est le passage obligé de **toute action physique ou persistante** sur une vraie
cafetière. Il est donc migré **en premier** et couvert en premier, jamais laissé pour la fin.

### Ce qui reste écrit à la main

Cible : **~200 lignes** au lieu de 1 845. Ce qui survit est ce qu'aucun utilitaire n'exprime :

- l'échelle `--crans` de la piste du curseur, armée par les bornes que la machine a publiées et
  absente quand elle ne les a pas publiées ;
- le clavier de boissons et ses paliers — le pas est un choix produit, pas un `grid-cols-n` ;
- le seul mouvement authored du produit, le panneau de navigation ;
- les lampes `.pill.on / .off / .info::before`, qui doivent rester posées sur la plaquette portant
  déjà le **nom** de l'état — les séparer reconstruirait le couple à côté.

## Preuve

`scripts/verif-surfaces.mjs`, plus `puppeteer` en devDependency. Il sème une base, démarre le
serveur, ouvre les 12 pages en Chrome sans tête et vérifie par page : **zéro erreur console**, la
présence de repères nommés, puis les trois comportements ci-dessus (focus piégé, Échap ferme,
crans armés).

**Il est écrit et vert contre l'interface ACTUELLE avant que quoi que ce soit ne bouge.** Un test
de non-régression écrit après la régression ne prouve rien : il ne fait que décrire le résultat
obtenu. Celui-ci doit capturer la ligne de base pour valoir quelque chose.

Il rejoint `.github/workflows/ci.yml` à côté des onze vérifications existantes.

`verif-contraste.mjs` relit `globals.css` : tant que les tokens y restent, il continue de valoir.
S'ils déménagent, il est réécrit dans le même lot, pas plus tard.

## Documentation — shadcn devient la cible déclarée

- `PRODUCT.md` § Stack : la phrase « Ni Tailwind ni shadcn ne sont installés à ce jour » saute ;
  « ce qui reste ouvert » est remplacé par la décision prise.
- `CLAUDE.md` § Front-end conventions : « One hand-written stylesheet… No Tailwind, no component
  library » devient la règle inverse, avec la liste de ce qui reste écrit à la main et pourquoi.
- `globals.css:622` : le paragraphe « aucun composant shadcn n'est monté » devient l'inventaire des
  quinze montés. **Les trois décisions natives renversées gardent leur trace** — ce qui avait été
  mesuré, et ce qui le remplace. Effacer la mesure ferait croire qu'elle n'a pas eu lieu.
- `README.md` : la ligne de pile.

## Lots

Chacun vert avant le suivant.

1. **Socle et ligne de base** — `verif-surfaces.mjs` écrit et vert contre l'UI actuelle, puis les
   quinze composants installés et rebranchés, `Touche` absorbée.
2. **Les trois primitives à risque** — `confirm.tsx` d'abord, puis `Nav`, les sélecteurs, les
   curseurs. Chaque comportement reprouvé.
3. **Les 20 surfaces** — les grosses d'abord (`beans` 131, `pilotage` 117, `systeme` 113,
   `machines` 110, `profils` 65), parce que ce sont elles qui révèlent les motifs partagés.
4. **La documentation.**

## Hors périmètre

Le protocole, `src/lib/*.mjs`, `server.mjs`. Cette migration ne franchit pas la frontière `/api` :
aucune trame, aucun ordonnanceur, aucune écriture machine n'est concernée. Les onze vérifications
existantes doivent rester vertes sans être modifiées — si l'une d'elles casse, c'est que la
migration a débordé.
