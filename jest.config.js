/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  testTimeout: 60000,
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { rootDir: '.', types: ['node', 'jest'] } }] },
};
