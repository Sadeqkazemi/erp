/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2022',
          strict: true,
          esModuleInterop: true,
        moduleResolution: 'node',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          skipLibCheck: true,
          types: ['node', 'jest'],
        },
      },
    ],
  },
  testEnvironment: 'node',
  testTimeout: 120000,
};
