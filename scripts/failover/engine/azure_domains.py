"""Noms publics des apps Azure : <app>.<domaine> en prod, <app>-dev.<domaine> en dev, avec un certificat géré par Azure.

Décision du 16/11/2026 : les apps Azure sont servies sous eu.mooroon5.fr, zone hébergée chez Azure (cnp, azure/
15-public-dns.tf) avec deux jokers (A vers l'IP de l'environnement Container Apps, TXT de vérification). Aucun
enregistrement par app : il ne reste qu'à déclarer le nom sur la Container App et à le lier à un certificat.

Pourquoi ici et pas dans Crossplane : le provider Azure installé (v1.13) sait déclarer un nom personnalisé, mais pas
demander un certificat géré (gratuit, renouvelé par Azure). Le job de réplication tourne déjà toutes les 2 minutes avec
son identité ; il pose le nom en trois passages au plus, sans jamais attendre :
  1. nom ajouté à la Container App, non lié (bindingType Disabled) : Azure exige le nom avant le certificat ;
  2. certificat géré demandé, validation HTTP (le joker A amène déjà le trafic sur l'environnement) ;
  3. certificat délivré (5 min mesurées le 16/11) : nom lié en SNI.
Vérifié le 16/11 sur cnp-demo dev : un redéploiement par Crossplane (nouvelle image, nouvelle révision) conserve le nom
et sa liaison.

Un certificat dont plus aucune app ne porte le nom (app supprimée) est supprimé : un environnement en accepte un nombre
limité. Seuls les certificats de NOTRE domaine sont concernés.

Aucune connexion ni appel réseau à l'import. `call(method, url, body=None)` est l'appel ARM authentifié du moteur.
"""
import json

API = '2024-03-01'


def hostname(app, env, domain):
    """Nom public d'une app : la prod porte le nom de l'app, la dev le suffixe -dev."""
    return f'{app}.{domain}' if env == 'prod' else f'{app}-{env}.{domain}'


def app_and_env(item):
    """(app, env) d'une Container App du portail, ou None. Nom « <app>-<env> », tag cnp-env posé par le portail."""
    env = (item.get('tags') or {}).get('cnp-env')
    name = item.get('name', '')
    if env not in ('dev', 'prod') or not name.endswith('-' + env):
        return None
    return (item.get('tags') or {}).get('cnp-app') or name[:-len(env) - 1], env


def certificate_name(host):
    # Nom de ressource : lettres, chiffres et tirets, 60 caractères au plus.
    return ('cnp-' + host.replace('.', '-'))[:60].rstrip('-')


class Domains:
    def __init__(self, call, base_rg_url, environment, domain, log=print):
        self.call, self.domain, self.log = call, domain, log
        self.apps_url = base_rg_url + '/providers/Microsoft.App/containerApps'
        self.certs_url = base_rg_url + f'/providers/Microsoft.App/managedEnvironments/{environment}/managedCertificates'

    def _report(self, **fields):
        record = {'domain': self.domain, **fields}
        self.log(json.dumps(record, ensure_ascii=False, sort_keys=True))
        return record

    def reconcile(self, apply=True):
        apps = (self.call('GET', f'{self.apps_url}?api-version={API}') or {}).get('value', [])
        certs = (self.call('GET', f'{self.certs_url}?api-version={API}') or {}).get('value', [])
        by_subject = {c['properties'].get('subjectName'): c for c in certs}
        wanted, results = set(), []
        for item in apps:
            found = app_and_env(item)
            if not found:
                continue
            host = hostname(*found, self.domain)
            wanted.add(host)
            try:
                results.append(self._one(item, found, host, by_subject.get(host), apply))
            except Exception as error:  # noqa: BLE001 — une app en erreur n'empêche pas les autres.
                results.append(self._report(app=found[0], env=found[1], host=host, state='ERROR',
                                            error=type(error).__name__, detail=str(error)[:300]))
        for subject, cert in by_subject.items():
            if subject and subject.endswith('.' + self.domain) and subject not in wanted:
                if apply:
                    self.call('DELETE', f"{self.certs_url}/{cert['name']}?api-version={API}")
                results.append(self._report(host=subject, state='CERTIFICATE_REMOVED' if apply else 'CERTIFICATE_ORPHAN'))
        return results

    def _one(self, item, found, host, cert, apply):
        app, env = found
        ingress = item['properties']['configuration'].get('ingress') or {}
        domains = ingress.get('customDomains') or []
        current = next((d for d in domains if d.get('name') == host), None)
        cert_state = cert and cert['properties'].get('provisioningState')
        if current and current.get('bindingType') == 'SniEnabled':
            return self._report(app=app, env=env, host=host, state='BOUND')
        if not apply:
            return self._report(app=app, env=env, host=host, state='PENDING', certificate=cert_state or 'absent')
        if current is None:
            # Ingress COMPLET renvoyé : un PATCH partiel de l'ingress remettrait ses autres champs à leur défaut.
            self._patch_domains(item, ingress, domains + [{'name': host, 'bindingType': 'Disabled'}])
            return self._report(app=app, env=env, host=host, state='NAME_ADDED')
        if cert is None:
            self.call('PUT', f'{self.certs_url}/{certificate_name(host)}?api-version={API}', {
                'location': item['location'],
                'properties': {'subjectName': host, 'domainControlValidation': 'HTTP'}})
            return self._report(app=app, env=env, host=host, state='CERTIFICATE_REQUESTED')
        if cert_state != 'Succeeded':
            # Pending (normal, quelques minutes) ou Failed : un échec reste visible dans le journal, sans boucle de
            # redemande ; supprimer le certificat à la main relance la demande au passage suivant.
            return self._report(app=app, env=env, host=host, state='CERTIFICATE_' + str(cert_state).upper())
        bound = [dict(d, bindingType='SniEnabled', certificateId=cert['id']) if d.get('name') == host else d for d in domains]
        self._patch_domains(item, ingress, bound)
        return self._report(app=app, env=env, host=host, state='BOUND_NOW')

    def _patch_domains(self, item, ingress, domains):
        self.call('PATCH', f"{self.apps_url}/{item['name']}?api-version={API}",
                  {'properties': {'configuration': {'ingress': {**{k: v for k, v in ingress.items() if k != 'fqdn'},
                                                                'customDomains': domains}}}})
