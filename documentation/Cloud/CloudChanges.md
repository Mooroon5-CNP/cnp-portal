# Changement de compte, projet ou région GCP

La procédure complète est maintenue dans [le guide Cloud](Cloud/README.md).
Ce fichier conserve son nom pour préserver les références existantes.

`cloud:import` lit le contrat d’un Terraform déjà appliqué et configure le portail
local. Il ne crée pas l’infrastructure et ne migre pas les applications.
Le guide unique précise les prérequis Terraform, les références Crossplane à
adapter, les imports du cluster actuel et les vérifications après redémarrage.
