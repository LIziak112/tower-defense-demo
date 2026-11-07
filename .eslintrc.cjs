module.exports = {
  root: true,
  env: {
    browser: true,
    es2024: true,
    node: true
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended'
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  overrides: [
    {
      files: ['src/runtime/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: ['phaser', 'canvas', 'window', 'document']
          }
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: 'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
            message: 'Use seeded random instead of Math.random().'
          },
          {
            selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]',
            message: 'Use simulation tick instead of Date.'
          }
        ],
        'no-restricted-globals': [
          'error',
          {
            name: 'window',
            message: 'Runtime must be detached from DOM.'
          },
          {
            name: 'document',
            message: 'Runtime must be detached from DOM.'
          }
        ]
      }
    }
  ]
};
