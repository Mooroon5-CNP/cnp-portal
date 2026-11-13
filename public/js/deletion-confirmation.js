/* global document */
'use strict';

document.querySelectorAll('[data-deletion-confirmation]').forEach(input => {
  const prefix = input.dataset.deletionConfirmation;
  const button = document.getElementById(`${prefix}ConfirmBtn`);
  const ack = document.getElementById(`${prefix}BucketAck`);
  const checkbox = document.getElementById(`${prefix}BucketAckCheck`);
  const check = () => {
    const needsConsent = ack.style.display !== 'none';
    checkbox.required = needsConsent;
    checkbox.disabled = !needsConsent;
    button.disabled = input.value.trim().toLowerCase() !== 'delete'
      || (needsConsent && !checkbox.checked);
  };
  input.addEventListener('input', check);
  checkbox.addEventListener('change', check);
  input.form.addEventListener('submit', event => {
    check();
    if (button.disabled) event.preventDefault();
  });
  check();
});
