module.exports = {
  parser: '@typescript-eslint/parser',
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended'
  ],
  rules: {
    // 基础规则
  },
  settings: {
    react: {
      version: 'detect'
    }
  }
};
