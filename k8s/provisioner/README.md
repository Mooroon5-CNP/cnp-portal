# OpenBao runtime provisioner

This overlay is included in `k8s/overlays/prod`. The dedicated service creates
runtime identities for new application/environment pairs when variables are used.
To reproduce or update the deployment:

1. Apply `cnp/cluster` Terraform GCP and Azure identity resources from reviewed
   plans. The GCP provisioner service account has the project IAM and service
   account administration roles; the Azure UAI has three roles scoped to
   `cnp-sov-shared-rg`.
2. Verify the non-secret `clientId` and `portalPrincipalId` in
   `azure-identity-config.yaml` against the provisioner UAI and existing portal
   UAI after Azure apply. Verify the projected Azure token can exchange for an
   ARM token from the provisioner pod.
3. Build the portal image from reviewed `main`, update the same immutable digest
   in this Deployment and `k8s/overlays/prod/kustomization.yaml`, and review
   `kubectl kustomize k8s/overlays/prod` before syncing Argo CD.
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
