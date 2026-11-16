'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const vm = require('vm');

test.each(['deployments/index.ejs', 'deployments/detail.ejs'])('%s uses the same delete and approval confirmation fields', view => {
  const source = fs.readFileSync(path.join(__dirname, '../src/views', view), 'utf8');
  expect(source).toContain("include('../partials/deletion-confirmation', { prefix: 'delete'");
  expect(source).toContain("include('../partials/deletion-confirmation', { prefix: 'approve'");
  expect(source).toContain('/js/deletion-confirmation.js');
});

test('the shared form submits the confirmation and explicit data-destruction consent', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/partials/deletion-confirmation.ejs'), { prefix: 'delete', hasBucket: true });
  expect(html).toContain('name="confirmation"');
  expect(html).toContain('name="destroyData" value="yes"');
  expect(html).toContain('suppression définitive');
});

test('the confirm button requires delete and data consent; invalid submission is blocked', () => {
  const handlers = {};
  const input = { dataset: { deletionConfirmation: 'delete' }, value: '',
    addEventListener: (type, callback) => { handlers[type] = callback; },
    form: { addEventListener: (_type, callback) => { handlers.submit = callback; } } };
  const button = { disabled: false };
  const ack = { style: { display: 'block' } };
  const checkbox = { checked: false, addEventListener: (_type, callback) => { handlers.change = callback; } };
  const nodes = { deleteConfirmBtn: button, deleteBucketAck: ack, deleteBucketAckCheck: checkbox };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/deletion-confirmation.js'), 'utf8'), {
    document: { querySelectorAll: () => [input], getElementById: id => nodes[id] },
  });
  expect(button.disabled).toBe(true);
  expect(checkbox.required).toBe(true);
  expect(checkbox.disabled).toBe(false);
  input.value = 'delete'; handlers.input();
  expect(button.disabled).toBe(true);
  checkbox.checked = true; handlers.change();
  expect(button.disabled).toBe(false);
  input.value = 'wrong';
  const preventDefault = jest.fn(); handlers.submit({ preventDefault });
  expect(preventDefault).toHaveBeenCalled();
  ack.style.display = 'none'; checkbox.checked = false; input.value = 'DELETE'; handlers.input();
  expect(button.disabled).toBe(false);
  expect(checkbox.required).toBe(false);
  expect(checkbox.disabled).toBe(true);
});
