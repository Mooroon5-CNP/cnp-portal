'use strict';
const STATUSES = new Set(['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND', 'ALREADY_EXISTS', 'ABORTED', 'FAILED_PRECONDITION', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL']);
const REASONS = new Set(['IAM_PERMISSION_DENIED', 'SERVICE_DISABLED', 'ACCESS_DENIED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'BILLING_DISABLED', 'RATE_LIMIT_EXCEEDED', 'USER_PROJECT_DENIED', 'ORG_RESTRICTION_VIOLATION']);
const NETWORK = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPERM', 'CONFIG_TIMEOUT']);
function safeDetails(error) {
  const result = {};
  const status = error?.response?.status || error?.status;
  if (Number.isInteger(status) && status >= 100 && status < 600) result.status = status;
  const data = error?.response?.data?.error;
  const providerStatus = data?.status || error?.providerStatus;
  if (STATUSES.has(providerStatus)) result.providerStatus = providerStatus;
  const info = data?.details?.find(item => item?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
  const reason = info?.reason || error?.reason;
  if (REASONS.has(reason)) result.reason = reason;
  const permission = info?.metadata?.permission || error?.permission;
  if (/^(iam|storage|run|resourcemanager|serviceusage)\.[A-Za-z][A-Za-z0-9.]{0,100}$/.test(permission || '')) result.permission = permission;
  const service = info?.metadata?.service || error?.service;
  if (/^[a-z0-9.-]+\.googleapis\.com$/.test(service || '')) result.service = service;
  const networkCode = error?.networkCode || error?.code;
  if (NETWORK.has(networkCode)) result.networkCode = networkCode;
  return result;
}
function provisionError(operation, error, message) {
  const safeOperation = /^[a-zA-Z][a-zA-Z0-9.]{0,80}$/.test(operation) ? operation : 'provider';
  const result = new Error(message);
  result.code = `PROVISION_${safeOperation.replace(/\./g, '_').toUpperCase()}_FAILED`;
  result.operation = safeOperation;
  return Object.assign(result, safeDetails(error));
}
module.exports = { safeDetails, provisionError };
