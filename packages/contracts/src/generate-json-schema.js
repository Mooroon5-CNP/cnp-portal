'use strict';

const fs = require('fs');
const path = require('path');
const { toolNames, getInputJsonSchema, getOutputJsonSchema } = require('./index');

const outputDirectory = path.join(__dirname, '..', 'schemas');
fs.mkdirSync(outputDirectory, { recursive: true });

for (const tool of toolNames) {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: tool,
    input: getInputJsonSchema(tool),
    output: getOutputJsonSchema(tool),
  };
  fs.writeFileSync(path.join(outputDirectory, `${tool}.json`), `${JSON.stringify(schema, null, 2)}\n`);
}
