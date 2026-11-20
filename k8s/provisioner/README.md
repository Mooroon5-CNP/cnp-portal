# OpenBao runtime provisioner (staged)

This overlay is **not included** in `k8s/overlays/prod`. The current portal
continues to use its existing identity mappings. Promotion requires:

1. Merge `cnp/feat/openbao-runtime-provisioner`, then apply its GCP and Azure
   identity resources from reviewed plans with no unexpected changes or deletes.
   A GCP project IAM administrator must grant the dedicated GSA its declared
   roles; the current operator account cannot do so.
2. Verify the non-secret `clientId` and `portalPrincipalId` in
   `azure-identity-config.yaml` against the provisioner UAI and existing portal
   UAI after Azure apply. Verify the projected Azure token can exchange for an
   ARM token from the provisioner pod.
3. Build the portal image from reviewed `main`, replace
   `REPLACE_WITH_REVIEWED_PORTAL_DIGEST` with that immutable digest, add this
   directory to `k8s/overlays/prod/kustomization.yaml` resources, and add
   `portal-patch.yaml` to its patches. Render and review `kubectl kustomize`
   before syncing Argo CD.
4. From the portal, create a new application with one fictitious variable on
   GCP and Azure. Confirm runtime identity and permissions, read after restart,
   rotation and denial across applications. Do not promote the AWS failover
   path until its separate account permissions and ECS role are verified.

The provisioner listens only inside the cluster. Kubernetes TokenReview
accepts the `cnp-portal` service account with the dedicated audience; the
Terraform NetworkPolicy admits requests only from portal pods. Its GCP and
Azure identities are separate from the portal identities. A failed request is
safe to retry: resource names are deterministic and existing ownership is
checked before a role is added.
