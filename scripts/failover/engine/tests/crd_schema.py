"""Contrôle de manifests Crossplane contre le schéma OpenAPI officiel du fournisseur (fixtures réduites).

Tant qu'un fournisseur n'est pas installé dans le cluster, c'est la seule vérification de conformité possible : champs inconnus,
types, champs requis. Les fixtures viennent du dépôt upbound/provider-aws (voir `_source` dans chaque fichier).
"""
import json
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures" / "crds"


def schema(name):
    return json.loads((FIXTURES / name).read_text())


def problems(value, node, path="spec"):
    """Liste les écarts de `value` par rapport au nœud de schéma `node` (vide = conforme)."""
    if node.get("x-kubernetes-preserve-unknown-fields"):
        return []
    kind = node.get("type")
    found = []
    if kind == "object":
        if not isinstance(value, dict):
            return [f"{path} : objet attendu"]
        properties, extra = node.get("properties"), node.get("additionalProperties")
        if properties is not None:
            for key, item in value.items():
                if key not in properties:
                    found.append(f"{path}.{key} : champ inconnu du fournisseur")
                else:
                    found += problems(item, properties[key], f"{path}.{key}")
            found += [f"{path}.{key} : champ requis absent" for key in node.get("required", []) if key not in value]
        elif isinstance(extra, dict):
            for key, item in value.items():
                found += problems(item, extra, f"{path}.{key}")
    elif kind == "array":
        if not isinstance(value, list):
            return [f"{path} : liste attendue"]
        for index, item in enumerate(value):
            found += problems(item, node.get("items", {}), f"{path}[{index}]")
    elif kind == "string" and not isinstance(value, str):
        found.append(f"{path} : texte attendu")
    elif kind == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
        found.append(f"{path} : entier attendu")
    elif kind == "number" and (not isinstance(value, (int, float)) or isinstance(value, bool)):
        found.append(f"{path} : nombre attendu")
    elif kind == "boolean" and not isinstance(value, bool):
        found.append(f"{path} : booléen attendu")
    return found


def manifest_problems(manifest, fixture):
    """Écarts du `spec` d'un manifest, et vérification de la version d'API et du type."""
    doc = schema(fixture)
    found = []
    if manifest.get("kind") != doc["_kind"]:
        found.append(f"kind {manifest.get('kind')} au lieu de {doc['_kind']}")
    if manifest.get("apiVersion") != f"{doc['_group']}/{doc['_version']}":
        found.append(f"apiVersion {manifest.get('apiVersion')} au lieu de {doc['_group']}/{doc['_version']}")
    return found + problems(manifest.get("spec", {}), doc["spec"])
