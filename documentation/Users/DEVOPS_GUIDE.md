# CNP Platform — DevOps Guide

This guide covers day-to-day DevOps operations on the CNP platform: monitoring K8s resource quotas, managing manifest merge requests, and configuring Cloud Run environment variables via Crossplane.

---

## Table of contents

1. [K8s Resources — reading quotas](#1-k8s-resources--reading-quotas)
2. [Manifest Merge Requests workflow](#2-manifest-merge-requests-workflow)
3. [Adding environment variables to a Cloud Run app](#3-adding-environment-variables-to-a-cloud-run-app)
4. [Good practices](#4-good-practices)

---

## 1. K8s Resources — reading quotas

Go to **Ressources K8s** in the sidebar. You will see one card per namespace with live usage data pulled from the cluster.

### What each metric means

| Metric | Description |
|--------|-------------|
| **CPU Requests** | Sum of `resources.requests.cpu` for all pods — what is *reserved* on the node |
| **CPU Limits** | Sum of `resources.limits.cpu` for all pods — the hard cap per pod |
| **Memory Requests** | Reserved memory across all pods in the namespace |
| **Memory Limits** | Hard memory cap — exceeding this causes OOMKill |
| **Pods** | Number of running pods vs the quota maximum |
| **Stockage (PVC)** | Total PersistentVolumeClaim storage requested vs the quota |
| **PVCs** | Number of PersistentVolumeClaims vs the quota |

### Colour coding

- **Green** — usage < 70 % → healthy
- **Amber** — usage ≥ 70 % → monitor closely, consider raising the quota or optimising the app
- **Red** — usage ≥ 90 % → critical, new pods or storage may be refused by the scheduler; act immediately

### When to raise a quota

Quotas are defined in `config-repo/apps/{appName}/base/resourcequota.yaml`. Edit via the YAML editor (see §2) and submit a Manifest MR for manager approval. Do not raise quotas preemptively — only when usage is consistently above 70 % over several days.

---

## 2. Manifest Merge Requests workflow

The YAML editor lets DevOps propose changes to any manifest in `config-repo`. Changes are **never committed directly** — they go through a Pull Request reviewed by a manager.

### How to submit a change

1. Go to **Ressources K8s** → click **✏ {appName}** in the "Applications — accès écriture" card.
2. Select a file from the left-hand tree (`base/`, `overlays/dev/`, `overlays/prod/`, `crossplane/`).
3. Edit the YAML in the editor. The editor loads the current file content from the config-repo `main` branch.
4. Optionally add a commit message explaining *why* you are making the change.
5. Click **Envoyer pour validation** (or press `Ctrl+S` / `Cmd+S`).

A Pull Request is automatically opened on `Mooroon5-CNP/config-repo`. The manager receives a notification badge in the portal.

### What happens after submission

| Status | Meaning | What to do |
|--------|---------|------------|
| `pending` | PR is open, waiting for manager review | Nothing — wait |
| `approved` | Manager merged the PR → ArgoCD will sync within ~2 minutes | Verify the app is healthy in ArgoCD |
| `rejected` | Manager closed the PR with comments | Go to **Mes Pull Requests**, read the rejection reason, click **Modifier**, fix the YAML, and resubmit |

### Viewing your MRs

Go to **Mes Pull Requests** in the sidebar. You can see all your submitted MRs, their current status, and a direct link to the GitHub PR.

### Rules and discipline

- **One logical change per MR.** Do not bundle unrelated edits (e.g. a quota increase and a new env var) into a single PR.
- **Always explain the why** in the commit message — the manager cannot approve a PR that just says "update".
- **Test locally before submitting.** Validate your YAML with `kubectl apply --dry-run=client -f <file>` or `kustomize build` before sending for review.
- **Never bypass the MR process.** Editing the config-repo directly (without the portal) will cause ArgoCD drift and may be overwritten by the next CI run.
- **Rejected MRs must be resubmitted**, not abandoned. A rejected MR stays in `rejected` state until you fix and resubmit — the manager's comments are on the GitHub PR.

---

## 3. Adding environment variables to a Cloud Run app

Environment variables for Cloud Run apps are declared in the Crossplane claim file:

```
config-repo/apps/{appName}/crossplane/cloudrun-claim.yaml
```

This file is accessible from the YAML editor under the **crossplane/** section.

### Where to add them

Open the file and locate `spec.forProvider.template.containers[0].env`. Add your variables there:

```yaml
apiVersion: cloudrun.cnp.io/v1alpha1
kind: V2Service
metadata:
  name: my-app
spec:
  forProvider:
    location: europe-west9
    template:
      containers:
        - image: europe-west9-docker.pkg.dev/cnp-terraform-500015/cnp-registry/my-app:latest
          env:
            # Platform-injected variables — do not remove
            - name: PORT
              value: "8080"
            - name: DATA_DIR
              value: /data
            # App-specific variables — add yours below
            - name: MY_API_URL
              value: "https://api.example.com"
            - name: FEATURE_FLAG_X
              value: "true"
            - name: MAX_CONNECTIONS
              value: "10"
```

> **Secret values** (API keys, passwords, tokens) must **never** be written as plain `value:` in this file — the config-repo is accessible to all DevOps and managers. Use `valueFrom.secretKeyRef` pointing to a Kubernetes Secret managed separately, or use the **Secrets** section in the portal admin to provision them.

### Example with a secret reference

```yaml
env:
  - name: PORT
    value: "8080"
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: my-app-secrets
        key: database-url
  - name: STRIPE_PUBLIC_KEY
    value: "pk_live_abc123"          # public key — safe as plain value
  - name: STRIPE_SECRET_KEY
    valueFrom:
      secretKeyRef:
        name: my-app-secrets
        key: stripe-secret-key      # secret — must use secretKeyRef
```

### After editing

Submit the file as a Manifest MR (see §2). Once a manager approves and merges the PR, ArgoCD syncs the updated claim → Crossplane updates the Cloud Run service → the new env vars are live within ~2 minutes.

> **Note:** Changing env vars triggers a Cloud Run revision update. Traffic switches to the new revision automatically once its `/ready` probe returns 200.

---

## 4. Good practices

### General

- Always use the portal editor — never edit the config-repo directly from GitHub. Direct edits bypass the MR approval gate and may be overwritten by the next CI run.
- Keep changes small and atomic. A targeted PR is easier to review and easier to roll back.
- Monitor ArgoCD after every approved MR. If the sync fails, the old manifest remains in place — you will need to investigate and resubmit a corrected MR.

### Quota management

- Do not inflate quotas speculatively. Set requests and limits based on observed `p95` CPU and memory usage.
- CPU `requests` should be ~50–70 % of `limits`. A ratio of 1:2 is a reasonable baseline.
- Memory `limits` must be set carefully — exceeding the limit causes an immediate OOMKill with no grace period.
- Use `resources.requests.cpu: 100m` / `limits.cpu: 500m` as a starting point for a lightweight Node.js app.

### Security

- Never commit secrets to config-repo manifests.
- Rotate `CONFIG_REPO_TOKEN` secrets annually or immediately after a team-member offboarding.
- If you suspect a secret has been leaked, rotate it first, then inform the manager — do not wait.

### Communication

- If a developer asks for an env var to be added, verify the variable name and value with them in writing before submitting the MR.
- Notify developers when their env vars are live — they may need to redeploy or verify their app's behaviour.
- If you reject a developer's onboarding or a quota request, always provide a concrete reason and suggested fix in the GitHub PR comment.
