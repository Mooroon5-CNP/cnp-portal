module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true,    // lets ESLint recognise describe/test/expect without errors
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
  },
  rules: {
    'no-console': 'off',    // we use console.log for structured JSON logging
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
};
